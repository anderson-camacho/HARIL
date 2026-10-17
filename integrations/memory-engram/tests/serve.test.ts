import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeMemoryDeps } from "@haril/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEngramServe,
  EngramMemoryProvider,
  type EngramServe,
  type EngramServeOptions,
  type EngramSpawnOptions,
  engramDataDirOf,
  engramHomeOf,
} from "../src/index.js";
import { killProcessTree } from "../src/serve.js";
import { FakeEngramServer } from "../testing/fake-engram-server.js";

// Supervision of `engram serve` (ADR-0008 D4, D5; MEMORY.md 4.4, 11.3; memory.md 9.4 points 1 to 4) with the fake
// executable testing/fake-engram.mjs run by the host Node: a real child process on an ephemeral loopback port, with a
// temporary data dir and a fixture home. The scenario is a leading argument of the binary, so the child's environment
// is exactly the one the supervisor builds (MEM-T5) and the tests read it back from the child itself.

const FAKE_ENGRAM = fileURLToPath(new URL("../testing/fake-engram.mjs", import.meta.url));
const WINDOWS = process.platform === "win32";

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: EngramSpawnOptions;
}

let root = "";
let harilData = "";
let home = "";
const serves: EngramServe[] = [];
const busy: Server[] = [];
const foreign: FakeEngramServer[] = [];

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "haril-engram-serve-")));
  harilData = join(root, "haril", "data");
  home = join(root, "home");
  mkdirSync(harilData, { recursive: true });
  mkdirSync(join(home, ".engram"), { recursive: true });
});

afterEach(async () => {
  for (const serve of serves.splice(0)) await serve.stop();
  for (const server of busy.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const server of foreign.splice(0)) await server.close();
  rmSync(root, { recursive: true, force: true });
});

// A supervisor of the fake. `beforeChild` runs in the spawn wrapper, after every guard and before the child starts.
function serve(
  scenario: string,
  overrides: Partial<EngramServeOptions> = {},
  beforeChild?: (options: EngramSpawnOptions) => void,
  extraArgs: readonly string[] = [],
): { serve: EngramServe; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const created = createEngramServe({
    binary: {
      path: process.execPath,
      leadingArgs: [FAKE_ENGRAM, `--scenario=${scenario}`, ...extraArgs],
    },
    harilDataDir: harilData,
    homeDir: home,
    osEnv: process.env,
    timings: { readinessMs: 5000, pollMs: 25, restartBaseMs: 50, stopMs: 3000 },
    ...overrides,
    spawn: (command, args, options) => {
      calls.push({ command, args: [...args], options: { ...options } });
      beforeChild?.(options);
      return nodeSpawn(command, [...args], options) as ChildProcess;
    },
  });
  serves.push(created);
  return { serve: created, calls };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function freeBusyPort(): Promise<number> {
  const server = createServer();
  busy.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

// The parent's environment at its worst: everything that could lead Engram to the user's files or to 7437.
function poisonedEnv(): Record<string, string | undefined> {
  return {
    SystemRoot: process.env.SystemRoot,
    PATH: "C:\\fake-evil\\bin",
    Path: "C:\\fake-evil\\bin",
    USERPROFILE: "C:\\Users\\fake-victim",
    HOME: "/home/fake-victim",
    HOMEDRIVE: "Z:",
    HOMEPATH: "\\fake-victim",
    TEMP: "C:\\fake-evil-temp",
    TMP: "C:\\fake-evil-temp",
    TMPDIR: "/tmp/fake-evil",
    USERNAME: "fake-victim",
    USERDOMAIN: "FAKE-DOMAIN",
    LOGONSERVER: "\\\\FAKE-SERVER",
    ENGRAM_PROJECT: "fake-leak",
    ENGRAM_URL: "http://127.0.0.1:7437",
    ENGRAM_AGENT_CLI: "claude",
    ENGRAM_DATA_DIR: join(home, ".engram"),
    ENGRAM_PORT: "7437",
  };
}

describe("launching engram serve", () => {
  it("launches by absolute path, and the child's real environment is exactly the one built from scratch", async () => {
    const { serve: engram, calls } = serve("ok", { osEnv: poisonedEnv() });
    const connected = await engram.connect();
    if (!connected.ok) throw new Error(connected.error.message);
    const endpoint = connected.value;
    const dataDir = engramDataDirOf(harilData);
    const engramHome = engramHomeOf(harilData);
    expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(endpoint.dataDir).toBe(dataDir);
    expect(endpoint.instanceId).toBe(readFileSync(join(dataDir, ".instance-id"), "utf8").trim());
    expect(existsSync(join(engramHome, "tmp"))).toBe(true);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("no spawn");
    expect(call.command).toBe(process.execPath);
    expect(call.args).toEqual([FAKE_ENGRAM, "--scenario=ok", "serve"]);
    expect(call.options.shell).toBe(false);

    const port = new URL(endpoint.baseUrl).port;
    const expected: Record<string, string> = {
      ENGRAM_DATA_DIR: dataDir,
      ENGRAM_PORT: port,
      ENGRAM_HTTP_TOKEN: endpoint.token,
      ENGRAM_STARTUP_POLICY: "deny",
      ENGRAM_NO_UPDATE_CHECK: "1",
      HOME: engramHome,
    };
    if (WINDOWS) {
      const systemRoot = process.env.SystemRoot ?? "";
      Object.assign(expected, {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        SYSTEMDRIVE: systemRoot.slice(0, 2),
        PATH: join(systemRoot, "System32"),
        USERPROFILE: engramHome,
        HOMEDRIVE: engramHome.slice(0, 2),
        HOMEPATH: engramHome.slice(2),
        TEMP: join(engramHome, "tmp"),
        TMP: join(engramHome, "tmp"),
        USERNAME: "",
        USERDOMAIN: "",
        LOGONSERVER: "",
      });
    } else {
      expected.TMPDIR = join(engramHome, "tmp");
    }
    const childEnv = (await (await fetch(`${endpoint.baseUrl}/__fake/env`)).json()) as Record<
      string,
      string
    >;
    expect(childEnv).toEqual(expected);
    expect(endpoint.token).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(port)).not.toBe(7437);

    // The adapter over the supervised serve, end to end.
    const deps = fakeMemoryDeps("serve");
    const memory = new EngramMemoryProvider(deps, {
      engramVersion: "3.4.0",
      harilDataDir: harilData,
      connect: () => engram.connect(),
    });
    const content = "zqxsupervised content";
    const stored = await memory.store({
      schemaVersion: 1,
      operationId: "fake-op-serve-1",
      scope: {
        workspaceId: "01HWORKSPACE00000000000001",
        projectKey: "01HPROJECT0000000000000001",
        visibility: "project",
        sessionId: "01HSESSION0000000000000001",
        kind: "discovery",
      },
      title: "zqxsupervised",
      content,
      contentSha256: deps.hasher.sha256(content),
      origin: "haril",
    });
    expect(stored.ok).toBe(true);
    expect(await memory.health()).toMatchObject({ state: "active", dataDir });
    expect((await engram.connect()).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("refuses a binary that is not an absolute path, so PATH is never searched", async () => {
    const { serve: engram, calls } = serve("ok", { binary: { path: "engram" } });
    const connected = await engram.connect();
    expect(connected).toMatchObject({ ok: false, error: { code: "memory.serve.binary_refused" } });
    expect(calls).toEqual([]);
  });

  it("refuses ~/.engram as the data dir without launching anything or touching it", async () => {
    const userEngram = join(home, ".engram");
    const { serve: engram, calls } = serve("ok", { harilDataDir: join(userEngram, "haril-data") });
    const connected = await engram.connect();
    expect(connected).toMatchObject({
      ok: false,
      error: { code: "memory.serve.data_dir_refused" },
    });
    expect(calls).toEqual([]);
    expect(readdirSync(userEngram)).toEqual([]);
  });

  it("refuses, typed, a data dir whose link points nowhere yet", async () => {
    mkdirSync(join(harilData, "memory"), { recursive: true });
    symlinkSync(join(home, ".engram", "notyet"), engramDataDirOf(harilData), "junction");
    const { serve: engram, calls } = serve("ok");
    expect(await engram.connect()).toMatchObject({
      ok: false,
      error: { code: "memory.serve.data_dir_refused" },
    });
    expect(calls).toEqual([]);
    expect(readdirSync(join(home, ".engram"))).toEqual([]);
  });

  it("refuses 7437 and a port already in use without launching anything", async () => {
    for (const port of [7437, await freeBusyPort()]) {
      const { serve: engram, calls } = serve("ok", { port });
      const connected = await engram.connect();
      expect(connected, String(port)).toMatchObject({
        ok: false,
        error: { code: "memory.serve.port_refused" },
      });
      expect(calls).toEqual([]);
    }
    expect(existsSync(engramDataDirOf(harilData))).toBe(false);
  });

  it("runs a single serve per data dir", async () => {
    const first = serve("ok").serve;
    expect((await first.connect()).ok).toBe(true);
    const { serve: second, calls } = serve("ok");
    expect(await second.connect()).toMatchObject({
      ok: false,
      error: { code: "memory.serve.held" },
    });
    expect(calls).toEqual([]);
    await first.stop();
    expect((await second.connect()).ok).toBe(true);
  });

  it("keeps the launch token out of the error it records from the child's output", async () => {
    const { serve: engram, calls } = serve("leak_token");
    expect(await engram.connect()).toMatchObject({ ok: false });
    const token = calls[0]?.options.env.ENGRAM_HTTP_TOKEN ?? "";
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const lastError = engram.status().lastError ?? "";
    expect(lastError).toContain("fake-engram: token [REDACTED]");
    expect(lastError).not.toContain(token);
  });
});

describe("readiness and identity", () => {
  it("gives up at the readiness deadline and kills the child", async () => {
    const { serve: engram, calls } = serve("never_ready", {
      timings: { readinessMs: 400, pollMs: 25, stopMs: 3000 },
    });
    const started = Date.now();
    const connected = await engram.connect();
    expect(connected).toMatchObject({ ok: false, error: { code: "memory.serve.not_ready" } });
    expect(Date.now() - started).toBeLessThan(3000);
    const pid = engram.status().lastPid;
    expect(pid).not.toBeNull();
    await until(() => !alive(pid ?? 0));
    expect(calls).toHaveLength(1);
  });

  it("does not trust nor relaunch a serve that exits 0 before it is ready (#1462), and frees its data dir", async () => {
    const { serve: engram, calls } = serve("exit0");
    expect(await engram.connect()).toMatchObject({
      ok: false,
      error: { code: "memory.serve.exited" },
    });
    expect(await engram.connect()).toMatchObject({ ok: false });
    expect(calls).toHaveLength(1);
    expect((await serve("ok").serve.connect()).ok).toBe(true);
  });

  it("refuses a server on its port that is not this data dir's instance, and does not reuse it", async () => {
    const { serve: engram } = serve("wrong_instance");
    expect(await engram.connect()).toMatchObject({
      ok: false,
      error: { code: "memory.serve.foreign_instance" },
    });
    const pid = engram.status().lastPid;
    await until(() => !alive(pid ?? 0));
  });

  // The race of the verifier: another server binds the chosen port after the port check and before the child, which
  // starts late (--start-delay-ms) and then cannot bind it.
  async function race(echoInstance: boolean): Promise<{
    readonly engram: EngramServe;
    readonly impostor: () => FakeEngramServer;
    readonly token: () => string;
  }> {
    let impostor: FakeEngramServer | undefined;
    let token = "";
    const { serve: engram } = serve(
      "ok",
      {},
      (options) => {
        token = options.env.ENGRAM_HTTP_TOKEN ?? "";
        const dataDir = options.env.ENGRAM_DATA_DIR ?? "";
        const instanceId = "fake0000000000000000000000000001";
        if (echoInstance) writeFileSync(join(dataDir, ".instance-id"), `${instanceId}\n`);
        impostor = new FakeEngramServer({
          port: Number(options.env.ENGRAM_PORT),
          token: "fake-impostor-token",
          ...(echoInstance ? { instanceId } : {}),
        });
        foreign.push(impostor);
        void impostor.start();
      },
      ["--start-delay-ms=400"],
    );
    return {
      engram,
      impostor: () => {
        if (impostor === undefined) throw new Error("no impostor");
        return impostor;
      },
      token: () => token,
    };
  }

  it("refuses a server that took its port before the child, without ever sending it the token", async () => {
    const { engram, impostor, token } = await race(false);
    expect(await engram.connect()).toMatchObject({
      ok: false,
      error: { code: "memory.serve.foreign_instance" },
    });
    expect(token()).toMatch(/^[0-9a-f]{64}$/);
    expect(impostor().requests.length).toBeGreaterThan(0);
    expect(impostor().requests.every((request) => request.authorization === undefined)).toBe(true);
    const pid = engram.status().lastPid;
    await until(() => !alive(pid ?? 0));
  });

  it("refuses a server that took its port and copies the data dir's instance id: it does not take the launch token", async () => {
    const { engram, impostor } = await race(true);
    expect(await engram.connect()).toMatchObject({
      ok: false,
      error: { code: "memory.serve.foreign_instance" },
    });
    expect(engram.status().state).not.toBe("ready");
    // The token goes only to the one token-protected check, after the instance id matched and the child was alive.
    const withToken = impostor().requests.filter((request) => request.authorization !== undefined);
    expect(withToken.map((request) => request.route)).toEqual(["compatibility"]);
    const pid = engram.status().lastPid;
    await until(() => !alive(pid ?? 0));
  });
});

describe("restart and stop", () => {
  it("relaunches a crashed serve on the next connect, after its backoff, up to the restart cap", async () => {
    const { serve: engram, calls } = serve("ok", { maxRestarts: 1 });
    const first = await engram.connect();
    if (!first.ok) throw new Error(first.error.message);
    const crash = async (baseUrl: string) => {
      await fetch(`${baseUrl}/__fake/exit?code=1`, { method: "POST" });
      await until(() => engram.status().state === "down");
    };
    await crash(first.value.baseUrl);
    let second = await engram.connect();
    if (!second.ok) {
      expect(second.error.code).toBe("memory.serve.backoff");
      await new Promise((resolve) => setTimeout(resolve, 150));
      second = await engram.connect();
    }
    if (!second.ok) throw new Error(second.error.message);
    expect(calls).toHaveLength(2);
    expect(second.value.instanceId).toBe(first.value.instanceId);
    await crash(second.value.baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await engram.connect()).toMatchObject({
      ok: false,
      error: { code: "memory.serve.gave_up" },
    });
    expect(calls).toHaveLength(2);
  });

  it("stop kills the whole process tree", async () => {
    const { serve: engram } = serve("grandchild");
    const connected = await engram.connect();
    if (!connected.ok) throw new Error(connected.error.message);
    const pidFile = join(engramDataDirOf(harilData), "fake-grandchild.pid");
    await until(() => existsSync(pidFile));
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    const child = engram.status().lastPid ?? 0;
    expect(alive(grandchild)).toBe(true);
    expect(alive(child)).toBe(true);
    await engram.stop();
    await until(() => !alive(child) && !alive(grandchild));
    expect(engram.status().state).toBe("stopped");
    expect(await engram.connect()).toMatchObject({
      ok: false,
      error: { code: "memory.serve.stopped" },
    });
  });

  it("kills the child itself when the Windows tree killer cannot be started", async () => {
    const child = nodeSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const pid = child.pid ?? 0;
    expect(alive(pid)).toBe(true);
    const missing = join(root, "fake-missing-taskkill.exe");
    killProcessTree(child, { SystemRoot: "C:\\Windows" }, "win32", (command, args) =>
      nodeSpawn(missing, [...args, command], { stdio: "ignore" }),
    );
    await until(() => !alive(pid));
  });
});
