import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { DEFAULT_COMMAND_ALLOW } from "@haril/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  allowedCommand,
  cleanEnvironment,
  GRANT_ENV,
  resolveProgram,
  runHostCommand,
} from "../src/runtime/host-commands.js";

// Real git and real processes: under the load of the full suite one test can take several seconds, so this file gives
// its tests and hooks a minute instead of the suite's 15 s (a hang still fails it).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// haril_run (docs/modos-y-delegacion.md 3.10.5 and section 8; phase F8): a command of the allow list, run by the host
// in the agent's worktree as argv (never a shell), with a clean environment that carries no key, a time limit and an
// output limit, its result returned as data. N0: no sandbox; an allowed command runs project code with the user's rights.

let dir: string;
let script: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "haril-host-cmd-"));
  script = join(dir, "probe.mjs");
  writeFileSync(
    script,
    [
      "const [mode, ...rest] = process.argv.slice(2);",
      'if (mode === "argv") console.log(JSON.stringify(rest));',
      'if (mode === "env") console.log(JSON.stringify({ secret: process.env.SECRET_TOKEN ?? "absent", key: process.env.HARIL_CLIPROXYAPI_KEY ?? "absent", ci: process.env.CI }));',
      'if (mode === "cwd") console.log(process.cwd());',
      'if (mode === "sleep") setTimeout(() => console.log("woke"), 10000);',
      'if (mode === "flood") { process.stdout.write("x".repeat(100000)); process.stdout.write("END"); }',
      'if (mode === "fail") { console.error("boom"); process.exit(3); }',
      'if (mode === "orphan") { const { spawn } = await import("node:child_process"); const { tmpdir } = await import("node:os"); const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit", detached: true, cwd: tmpdir() }); console.log("orphan " + c.pid); c.unref(); }',
    ].join("\n"),
  );
});

afterAll(() => {
  // A process a test left behind may hold the folder for a moment after its kill.
  rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

const parentEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  SECRET_TOKEN: "fixture-not-a-real-token",
  HARIL_CLIPROXYAPI_KEY: "fixture-not-a-real-key",
});

const settings = (change: Partial<{ timeoutMs: number; outputMaxBytes: number }> = {}) => ({
  allow: ["node probe.mjs *"],
  timeoutMs: 20_000,
  outputMaxBytes: 16_384,
  ...change,
});

describe("allowedCommand", () => {
  it("matches an entry exactly, or as a prefix when it ends with *", () => {
    expect(allowedCommand(["npm test"], "npm", ["test"])).toBe(true);
    expect(allowedCommand(["npm test"], "npm", ["test", "--watch"])).toBe(false);
    expect(allowedCommand(["npm test *"], "npm", ["test", "button", "src/a.test.ts"])).toBe(true);
    expect(allowedCommand(["npm test"], "npm", ["run", "evil"])).toBe(false);
    expect(allowedCommand(["npm run build"], "npm", ["run"])).toBe(false);
    expect(allowedCommand([], "npm", ["test"])).toBe(false);
  });

  it("refuses, after an entry's *, an argument that loads code or moves where the command runs", () => {
    // The probes that ran an agent-written file or another folder's script through "npm test *" and "pnpm test *".
    expect(
      allowedCommand(["npm test *"], "npm", ["test", "--", "--import", "./docs/evil.mjs"]),
    ).toBe(false);
    expect(allowedCommand(["npm test *"], "npm", ["test", "--import=./docs/evil.mjs"])).toBe(false);
    expect(allowedCommand(["npm test *"], "npm", ["test", "--prefix", "elsewhere"])).toBe(false);
    expect(allowedCommand(["pnpm test *"], "pnpm", ["test", "-C", "sub"])).toBe(false);
    for (const flag of [
      "--require",
      "-r",
      "--loader",
      "--experimental-loader",
      "--config",
      "-c",
      "--dir",
      "--cwd",
      "--script-shell",
      "--userconfig",
      "--globalconfig",
      "--node-options",
      "--eval",
      "-e",
      "--inspect",
      "--inspect-brk=9229",
    ]) {
      expect([flag, allowedCommand(["npm test *"], "npm", ["test", flag, "x"])]).toEqual([
        flag,
        false,
      ]);
    }
    // An absolute path or a climb out of the worktree in any extra argument.
    expect(allowedCommand(["npm test *"], "npm", ["test", "--", "/etc/passwd"])).toBe(false);
    expect(allowedCommand(["npm test *"], "npm", ["test", "--", "C:\\Windows\\x"])).toBe(false);
    expect(allowedCommand(["npm test *"], "npm", ["test", "--", "../outside.test.js"])).toBe(false);
    expect(allowedCommand(["npm test *"], "npm", ["test", "--", "src/../../x"])).toBe(false);
    // Plain positional arguments still pass.
    expect(allowedCommand(["npm test *"], "npm", ["test", "button", "src/a.test.ts"])).toBe(true);
  });

  describe("after an entry's *, positional arguments only (the probes that got past the flag list)", () => {
    const allowed = (entry: string, args: readonly string[]): boolean => {
      const [command, ...fixed] = entry.replace(/ \*$/, "").split(" ");
      return allowedCommand([entry], command as string, [...fixed, ...args]);
    };

    it("refuses an abbreviated flag npm still takes: --prefi=../b", () => {
      expect(allowed("npm test *", ["--prefi=../b"])).toBe(false);
      expect(allowed("npm test *", ["--pre", "elsewhere"])).toBe(false);
    });

    it("refuses an absolute path after the start of an argument: --root=C:/other", () => {
      expect(allowed("npm test *", ["--root=C:/other"])).toBe(false);
      expect(allowed("npm test *", ["root=C:/other"])).toBe(false);
      expect(allowed("npm test *", ["root=D:\\other"])).toBe(false);
      expect(allowed("npm test *", ["root=/etc"])).toBe(false);
      expect(allowed("npm test *", ["C:relative"])).toBe(false);
    });

    it("refuses node's own flags after node *: -p, --print, -r./x", () => {
      for (const flag of ["-p", "--print", "-r./x", "-pe", "--require=./x"]) {
        expect([flag, allowed("node *", [flag, "1"])]).toEqual([flag, false]);
      }
      expect(allowed("node *", ["scripts/check.js", "fast"])).toBe(true);
    });

    it("refuses any argument that starts with -, a bare -- included", () => {
      expect(allowed("npm test *", ["--"])).toBe(false);
      expect(allowed("npm test *", ["-t", "button"])).toBe(false);
      expect(allowed("npm test *", ["button", "--watch"])).toBe(false);
    });

    it("refuses a leading slash or backslash, and a share's \\\\ anywhere", () => {
      expect(allowed("npm test *", ["/etc/passwd"])).toBe(false);
      expect(allowed("npm test *", ["\\Windows\\x"])).toBe(false);
      expect(allowed("npm test *", ["x\\\\server\\share"])).toBe(false);
    });

    it("refuses a .. path segment anywhere", () => {
      expect(allowed("npm test *", [".."])).toBe(false);
      expect(allowed("npm test *", ["src/../../x"])).toBe(false);
      expect(allowed("npm test *", ["src\\..\\x"])).toBe(false);
      expect(allowed("npm test *", ["out=../b"])).toBe(false);
      // Two dots inside a name are not a segment.
      expect(allowed("npm test *", ["a..b.test.ts"])).toBe(true);
    });

    it("keeps the exact entries of the default list as they are", () => {
      for (const entry of [
        "npm test",
        "pnpm install --frozen-lockfile",
        "go test ./...",
        "node --test",
      ]) {
        const [command, ...args] = entry.split(" ");
        expect([entry, allowedCommand(DEFAULT_COMMAND_ALLOW, command as string, args)]).toEqual([
          entry,
          true,
        ]);
      }
    });
  });

  it("has only exact entries in the default list", () => {
    expect(DEFAULT_COMMAND_ALLOW.filter((entry) => entry.trim().endsWith("*"))).toEqual([]);
    expect(allowedCommand(DEFAULT_COMMAND_ALLOW, "npm", ["test", "--prefix", "elsewhere"])).toBe(
      false,
    );
    expect(allowedCommand(DEFAULT_COMMAND_ALLOW, "pnpm", ["test", "-C", ".."])).toBe(false);
  });

  it("refuses a command given as a path, whatever the list says", () => {
    expect(allowedCommand(["node --test"], "./node", ["--test"])).toBe(false);
    expect(allowedCommand(["node --test"], "C:\\tools\\node", ["--test"])).toBe(false);
    expect(allowedCommand(["node --test"], "/usr/bin/node", ["--test"])).toBe(false);
  });

  it("has a default list for the usual test and build commands, with no shell and no eval", () => {
    expect(DEFAULT_COMMAND_ALLOW).toEqual(
      expect.arrayContaining(["npm test", "pnpm test", "npm run build", "node --test"]),
    );
    expect(
      DEFAULT_COMMAND_ALLOW.some((entry) => /^(sh|bash|cmd|powershell|pwsh)\b/.test(entry)),
    ).toBe(false);
    expect(allowedCommand(DEFAULT_COMMAND_ALLOW, "node", ["-e", "process.exit(0)"])).toBe(false);
  });
});

describe("cleanEnvironment", () => {
  it("keeps only the credentials' names for a grant, never the runtime's keys", () => {
    const env = cleanEnvironment(
      {
        PATH: "/bin",
        GH_TOKEN: "token",
        SSH_AUTH_SOCK: "/sock",
        CLIPROXY_API_KEY: "secret",
        ANTHROPIC_API_KEY: "secret",
        GIT_DIR: "/somewhere/else",
      },
      "linux",
      GRANT_ENV,
    );
    expect(env.GH_TOKEN).toBe("token");
    expect(env.SSH_AUTH_SOCK).toBe("/sock");
    expect(env.CLIPROXY_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(cleanEnvironment({ GH_TOKEN: "token" }, "linux").GH_TOKEN).toBeUndefined();
  });

  it("keeps the variables a program needs to start and drops everything else, keys first", () => {
    const env = cleanEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/home/me",
        OPENAI_API_KEY: "fixture-not-a-real-key",
        GITHUB_TOKEN: "fixture-not-a-real-token",
        HARIL_CLIPROXYAPI_KEY: "fixture-not-a-real-key",
        AWS_SECRET_ACCESS_KEY: "fixture",
        SOMETHING_ELSE: "x",
      },
      "linux",
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/me");
    expect(env.CI).toBe("true");
    for (const name of [
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "HARIL_CLIPROXYAPI_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "SOMETHING_ELSE",
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it("keeps the Windows names whatever their case", () => {
    const env = cleanEnvironment(
      { Path: "C:\\Windows", SystemRoot: "C:\\Windows", ComSpec: "cmd" },
      "win32",
    );
    expect(env.Path ?? env.PATH).toBe("C:\\Windows");
    expect(env.SystemRoot).toBe("C:\\Windows");
  });
});

describe("resolveProgram", () => {
  const files = new Set([
    "C:\\nodejs\\node.exe",
    "C:\\nodejs\\npm.cmd",
    "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    "C:\\nodejs\\pnpm.cmd",
    "C:\\nodejs\\node_modules\\corepack\\dist\\pnpm.js",
    "C:\\tools\\git.exe",
    "C:\\tools\\custom.cmd",
    "C:\\global\\vitest.cmd",
    "C:\\global\\node_modules\\vitest\\vitest.mjs",
  ]);
  const fs = {
    exists: (path: string) => files.has(path),
    readText: (path: string) =>
      path === "C:\\global\\vitest.cmd"
        ? '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\vitest\\vitest.mjs" %*\r\n'
        : undefined,
  };
  const env = { PATH: "C:\\nodejs;C:\\tools;C:\\global", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  it("runs an executable found on PATH directly", () => {
    expect(resolveProgram("git", env, "win32", fs)).toEqual({
      ok: true,
      file: "C:\\tools\\git.exe",
      prefix: [],
    });
  });

  it("runs npm and pnpm through node and their script, never through cmd.exe", () => {
    expect(resolveProgram("npm", env, "win32", fs)).toEqual({
      ok: true,
      file: "C:\\nodejs\\node.exe",
      prefix: ["C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
    });
    expect(resolveProgram("pnpm", env, "win32", fs)).toEqual({
      ok: true,
      file: "C:\\nodejs\\node.exe",
      prefix: ["C:\\nodejs\\node_modules\\corepack\\dist\\pnpm.js"],
    });
  });

  it("runs a node package's command shim through node and the script it names", () => {
    expect(resolveProgram("vitest", env, "win32", fs)).toEqual({
      ok: true,
      file: "C:\\nodejs\\node.exe",
      prefix: ["C:\\global\\node_modules\\vitest\\vitest.mjs"],
    });
  });

  it("refuses any other batch file and a program not on PATH", () => {
    expect(resolveProgram("custom", env, "win32", fs)).toMatchObject({ ok: false });
    expect(resolveProgram("nope", env, "win32", fs)).toMatchObject({ ok: false });
  });
});

describe("runHostCommand", () => {
  const nodeDir = dirname(process.execPath);
  const run = (args: string[], change: Parameters<typeof settings>[0] = {}) =>
    runHostCommand({
      command: "node",
      args: ["probe.mjs", ...args],
      cwd: dir,
      settings: settings(change),
      env: {
        ...parentEnv(),
        PATH: `${nodeDir}${process.platform === "win32" ? ";" : ":"}${parentEnv().PATH ?? ""}`,
      },
    });

  it("passes every argument as it is: no shell ever reads it", async () => {
    const result = await run(["argv", "a b", "&& echo hacked", "$(whoami)", "| more"]);
    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    if (!result.ok) return;
    expect(JSON.parse(result.stdout.trim())).toEqual([
      "a b",
      "&& echo hacked",
      "$(whoami)",
      "| more",
    ]);
    expect(result.stdout).not.toMatch(/^hacked/m);
  });

  it("starts the command in the worktree with a clean environment that holds no key", async () => {
    const env = await run(["env"]);
    expect(env.ok && JSON.parse(env.stdout.trim())).toEqual({
      secret: "absent",
      key: "absent",
      ci: "true",
    });
    const cwd = await run(["cwd"]);
    expect(cwd.ok && cwd.stdout.trim().toLowerCase()).toBe(dir.toLowerCase());
  });

  it("answers a failing command with its exit code and output, as data", async () => {
    const result = await run(["fail"]);
    expect(result).toMatchObject({ ok: true, exitCode: 3, timedOut: false });
    expect(result.ok && result.stderr).toContain("boom");
  });

  it("ends a command at its time limit", async () => {
    const started = Date.now();
    const result = await run(["sleep"], { timeoutMs: 400 });
    expect(result).toMatchObject({ ok: true, timedOut: true, exitCode: null });
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("keeps only the end of a long output and says it was cut", async () => {
    const result = await run(["flood"], { outputMaxBytes: 1_000 });
    expect(result).toMatchObject({ ok: true, exitCode: 0, truncated: true });
    if (!result.ok) return;
    expect(result.stdout.length).toBeLessThanOrEqual(1_000);
    expect(result.stdout.endsWith("END")).toBe(true);
  });

  it("says which process it started and when it ended, so a stop can find it", async () => {
    const seen: string[] = [];
    const result = await runHostCommand({
      command: "node",
      args: ["probe.mjs", "argv"],
      cwd: dir,
      settings: settings(),
      env: { ...parentEnv(), PATH: `${nodeDir}${delimiter}${parentEnv().PATH ?? ""}` },
      onSpawn: (child) => seen.push(`spawn ${child.pid > 0} ${child.startedAt > 0}`),
      onExit: (child) => seen.push(`exit ${child.pid > 0}`),
    });
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(seen).toEqual(["spawn true true", "exit true"]);
  });

  it("kills the command when its turn is aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runHostCommand({
      command: "node",
      args: ["probe.mjs", "sleep"],
      cwd: dir,
      settings: settings(),
      env: { ...parentEnv(), PATH: `${nodeDir}${delimiter}${parentEnv().PATH ?? ""}` },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    expect(result).toMatchObject({ ok: true, exitCode: null, aborted: true });
    expect(Date.now() - started).toBeLessThan(8_000);
    // An aborted signal stops a command before it starts.
    const late = await runHostCommand({
      command: "node",
      args: ["probe.mjs", "argv"],
      cwd: dir,
      settings: settings(),
      env: { ...parentEnv(), PATH: `${nodeDir}${delimiter}${parentEnv().PATH ?? ""}` },
      signal: controller.signal,
    });
    expect(late).toMatchObject({ ok: false });
  });

  it("answers once the command exits even when a process it left keeps its output open", async () => {
    const started = Date.now();
    const result = await run(["orphan"], { timeoutMs: 30_000 });
    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(Date.now() - started).toBeLessThan(15_000);
    const orphan = result.ok ? Number(/orphan (\d+)/.exec(result.stdout)?.[1]) : Number.NaN;
    expect(Number.isInteger(orphan)).toBe(true);
    try {
      process.kill(orphan, "SIGKILL");
    } catch {
      // Already gone.
    }
    // The orphan holds the test folder as its working directory until it is gone.
    for (let check = 0; check < 50; check += 1) {
      try {
        process.kill(orphan, 0);
      } catch {
        break;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
  });

  it("refuses a command outside the allow list and says what is allowed", async () => {
    const result = await runHostCommand({
      command: "node",
      args: ["-e", "1"],
      cwd: dir,
      settings: settings(),
      env: parentEnv(),
    });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("node probe.mjs *");
  });
});
