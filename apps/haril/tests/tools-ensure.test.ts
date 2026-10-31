import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGRAM_VERSION } from "../src/memory-config.js";
import type { DownloadFetch } from "../src/tools/download.js";
import {
  type EngramEnsureResult,
  type EnsureDeps,
  type EnsureInput,
  type EnsureOutcome,
  ensureEngram,
} from "../src/tools/ensure.js";
import { type EnsureFs, nodeEnsureFs } from "../src/tools/fs.js";
import { engramAsset } from "../src/tools/release.js";
import type { SmokeFn } from "../src/tools/smoke.js";
import { emptyToolsState, type ToolsState } from "../src/tools/state.js";

const PIN = ENGRAM_VERSION;
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const BINARY = process.platform === "win32" ? "engram.exe" : "engram";
const ASSET = engramAsset(PIN, process.platform, process.arch);
const BASE = `https://github.com/Gentleman-Programming/engram/releases/download/v${PIN}`;

interface RigOptions {
  // Text of the file at the pin's path; absent: no copy.
  copy?: string;
  // Other files under vendor/engram, by relative path.
  vendor?: Record<string, string>;
  config?: unknown;
  rawConfig?: string;
  mcp?: unknown;
  rawMcp?: string;
  state?: ToolsState;
  tag?: string;
  archiveVersion?: string;
  checksum?: "ok" | "bad" | "missing";
  download?: DownloadFetch;
  smoke?: SmokeFn;
  fs?: Partial<EnsureFs>;
  force?: boolean;
  extract?: EnsureDeps["extract"];
  platform?: string;
  arch?: string;
}

interface Rig {
  readonly root: string;
  readonly home: string;
  readonly runtimeRoot: string;
  readonly vendor: string;
  readonly copy: string;
  readonly configPath: string;
  readonly mcpPath: string;
  readonly dataDir: string;
  input: EnsureInput;
  deps: EnsureDeps;
  readonly urls: string[];
  readonly latestUrls: string[];
  readonly events: string[];
  readonly saved: ToolsState[];
  state: ToolsState;
  smokeSawCopy: boolean[];
  smokedPath: string | undefined;
}

let sandboxes: string[] = [];

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function rig(options: RigOptions = {}): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "haril-ensure-")));
  sandboxes.push(root);
  const home = join(root, "home");
  const runtimeRoot = join(root, "haril");
  const vendor = join(runtimeRoot, "vendor", "engram");
  const copy = join(vendor, PIN, BINARY);
  const configPath = join(runtimeRoot, "config", "haril.json");
  const mcpPath = join(runtimeRoot, "agent", "mcp.json");
  const dataDir = join(root, "data");
  mkdirSync(home, { recursive: true });
  if (options.copy !== undefined) write(copy, options.copy);
  for (const [path, text] of Object.entries(options.vendor ?? {})) write(join(vendor, path), text);
  if (options.config !== undefined) write(configPath, JSON.stringify(options.config));
  if (options.rawConfig !== undefined) write(configPath, options.rawConfig);
  if (options.mcp !== undefined) write(mcpPath, JSON.stringify(options.mcp));
  if (options.rawMcp !== undefined) write(mcpPath, options.rawMcp);

  const archiveBytes = Buffer.from(`archive-of engram ${options.archiveVersion ?? PIN}`);
  const digest = createHash("sha256").update(archiveBytes).digest("hex");
  const checksums = {
    ok: `${digest}  ${ASSET?.name}\n`,
    bad: `${"0".repeat(64)}  ${ASSET?.name}\n`,
    missing: `${digest}  some_other_asset.zip\n`,
  }[options.checksum ?? "ok"];

  const r = {
    root,
    home,
    runtimeRoot,
    vendor,
    copy,
    configPath,
    mcpPath,
    dataDir,
    urls: [] as string[],
    latestUrls: [] as string[],
    events: [] as string[],
    saved: [] as ToolsState[],
    state: options.state ?? emptyToolsState(),
    smokeSawCopy: [] as boolean[],
    smokedPath: undefined as string | undefined,
  } as unknown as Rig;

  const download: DownloadFetch =
    options.download ??
    (async (url) => {
      r.urls.push(url);
      if (url.endsWith("/checksums.txt")) return new Response(checksums, { status: 200 });
      if (url === ASSET?.url) return new Response(archiveBytes, { status: 200 });
      return new Response("no", { status: 404 });
    });
  const smoke: SmokeFn =
    options.smoke ??
    (async (input) => {
      r.events.push("smoke");
      r.smokedPath = input.binary.path;
      r.smokeSawCopy.push(existsSync(copy));
      return { ok: true };
    });

  const deps: EnsureDeps = {
    detect: {
      isFile: (path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      },
      realPath: (path) => {
        try {
          return realpathSync.native(path);
        } catch {
          return path;
        }
      },
      readVersion: async (path) => {
        const text = readFileSync(path, "utf8").trim();
        const version = /^engram (\d+\.\d+\.\d+)$/.exec(text)?.[1];
        return version === undefined ? { error: "exit 1" } : { version };
      },
    },
    fetch: async (url) => {
      r.latestUrls.push(url);
      const tool = url.includes("/engram/") ? "engram" : "gentle-ai";
      const tag = tool === "engram" ? (options.tag ?? `v${PIN}`) : "v4.3.1";
      return {
        status: 302,
        headers: new Headers({ location: `https://github.com/x/${tool}/releases/tag/${tag}` }),
        body: null,
      };
    },
    now: () => NOW,
    readState: () => r.state,
    writeState: (next) => {
      r.saved.push(next);
      r.state = next;
    },
    download,
    exec: async (file) => {
      r.events.push("exec");
      const text = readFileSync(file, "utf8").trim();
      return /^engram \d/.test(text)
        ? { code: 0, output: `${text}\n`, timedOut: false }
        : { code: 1, output: "", timedOut: false };
    },
    extract:
      options.extract ??
      (async ({ archive, destDir, binary }) => {
        r.events.push("extract");
        const text = readFileSync(archive, "utf8").replace(/^archive-of /, "");
        mkdirSync(destDir, { recursive: true });
        write(join(destDir, binary), text);
        return { ok: true, path: join(destDir, binary) };
      }),
    smoke,
    fs: { ...nodeEnsureFs, ...options.fs },
    pid: 4242,
    makeId: () => "abc123",
  };

  r.input = {
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    env: {},
    homeDir: home,
    runtimeRoot,
    configPath,
    dataDir,
    pin: PIN,
    force: options.force ?? false,
  };
  r.deps = deps;
  return r;
}

const run = (r: Rig): Promise<EnsureOutcome> => ensureEngram(r.input, r.deps);
const engramOf = (outcome: EnsureOutcome) => outcome.report.tools.find((t) => t.id === "engram");
type McpFile = { mcpServers: Record<string, Record<string, unknown>> };
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8"));
const readMcp = (path: string): McpFile => JSON.parse(readFileSync(path, "utf8"));
const tmpEntries = (r: Rig) =>
  existsSync(join(r.runtimeRoot, "tmp")) ? readdirSync(join(r.runtimeRoot, "tmp")) : [];
const lockPath = (r: Rig) => join(r.runtimeRoot, "state", "tools.lock");

beforeEach(() => {
  sandboxes = [];
});
afterEach(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

describe("ensure engram: nothing to do", () => {
  it("does nothing when HARIL's copy runs and is the pin", async () => {
    const r = rig({ copy: `engram ${PIN}` });
    const outcome = await run(r);
    expect(outcome.engram).toMatchObject({ action: "none", path: r.copy });
    expect(r.urls).toEqual([]);
    expect(r.events).toEqual([]);
    expect(engramOf(outcome)).toMatchObject({ state: "ok", active: { version: PIN } });
    expect(existsSync(lockPath(r))).toBe(false);
    expect(tmpEntries(r)).toEqual([]);
    expect(existsSync(r.configPath)).toBe(false);
  });

  it("refreshes the latest-version cache when it is due, before deciding", async () => {
    const r = rig({ copy: `engram ${PIN}` });
    await run(r);
    expect(r.latestUrls.sort()).toEqual([
      "https://github.com/Gentleman-Programming/engram/releases/latest",
      "https://github.com/Gentleman-Programming/gentle-ai/releases/latest",
    ]);
    expect(r.state.tools.engram?.latest).toBe(PIN);
  });

  it("does not ask GitHub again while the cache is fresh", async () => {
    const fresh: ToolsState = {
      version: 1,
      tools: {
        engram: { latest: PIN, latestCheckedAt: iso(NOW - 2 * HOUR) },
        "gentle-ai": { latest: "4.3.1", latestCheckedAt: iso(NOW - 2 * HOUR) },
      },
    };
    const r = rig({ copy: `engram ${PIN}`, state: fresh });
    await run(r);
    expect(r.latestUrls).toEqual([]);
  });

  it("only reports a newer upstream Engram, and installs nothing", async () => {
    const r = rig({ copy: `engram ${PIN}`, tag: "v3.7.0" });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("none");
    expect(r.urls).toEqual([]);
    expect(engramOf(outcome)).toMatchObject({ newerUpstream: true, latest: "3.7.0" });
  });
});

describe("ensure engram: installing and updating", () => {
  it("installs the pin when HARIL has no copy", async () => {
    const r = rig();
    const outcome = await run(r);
    expect(outcome.engram).toMatchObject({ action: "installed", to: PIN, path: r.copy });
    expect(outcome.engram.from).toBeUndefined();
    expect(readFileSync(r.copy, "utf8")).toBe(`engram ${PIN}`);
    expect(engramOf(outcome)).toMatchObject({
      state: "ok",
      active: { version: PIN, path: r.copy },
    });
  });

  it("downloads checksums.txt and the asset of the pin from the release, in that order", async () => {
    const r = rig();
    await run(r);
    expect(r.urls).toEqual([`${BASE}/checksums.txt`, `${BASE}/${ASSET?.name}`]);
  });

  it("verifies and smoke-tests the extracted copy before it touches the installed one", async () => {
    const r = rig();
    await run(r);
    expect(r.events).toEqual(["extract", "exec", "smoke"]);
    expect(r.smokeSawCopy).toEqual([false]);
    expect(r.smokedPath?.startsWith(join(r.runtimeRoot, "tmp"))).toBe(true);
  });

  it("updates an older copy to the pin and says from which version", async () => {
    const r = rig({ copy: "engram 3.5.0" });
    const outcome = await run(r);
    expect(outcome.engram).toMatchObject({ action: "updated", from: "3.5.0", to: PIN });
    expect(readFileSync(r.copy, "utf8")).toBe(`engram ${PIN}`);
    expect(readdirSync(r.vendor)).toEqual([PIN]);
  });

  it("repairs a copy that does not run", async () => {
    const r = rig({ copy: "not an executable" });
    const outcome = await run(r);
    expect(outcome.engram).toMatchObject({ action: "installed", to: PIN });
    expect(readFileSync(r.copy, "utf8")).toBe(`engram ${PIN}`);
  });

  it("never installs a version above the pin, even when upstream is newer", async () => {
    const r = rig({ tag: "v3.7.0" });
    const outcome = await run(r);
    expect(outcome.engram).toMatchObject({ action: "installed", to: PIN });
    expect(r.urls.every((url) => url.includes(`/v${PIN}/`))).toBe(true);
    expect(engramOf(outcome)).toMatchObject({ newerUpstream: true });
  });

  it("leaves no lock, staging or temporary folder behind", async () => {
    const r = rig();
    await run(r);
    expect(existsSync(lockPath(r))).toBe(false);
    expect(tmpEntries(r)).toEqual([]);
    expect(readdirSync(r.vendor)).toEqual([PIN]);
  });

  it("keeps the pin and one earlier version and prunes the rest", async () => {
    const r = rig({
      copy: "engram 3.5.0",
      vendor: { "3.2.0/engram": "x", "3.5.0/engram": "engram 3.5.0" },
    });
    await run(r);
    expect(readdirSync(r.vendor).sort()).toEqual(["3.5.0", PIN]);
  });

  it("clears an earlier failure record after a good install", async () => {
    const r = rig({
      state: {
        version: 1,
        tools: {},
        engramInstall: { failedAt: iso(NOW - 7 * HOUR), message: "network error" },
      },
    });
    await run(r);
    expect(r.state.engramInstall).toBeUndefined();
  });
});

describe("ensure engram: a user override", () => {
  it("does nothing when memory.binary points outside HARIL's vendor folder", async () => {
    const mine = join(tmpdir(), "my-engram", BINARY);
    const config = { memory: { provider: "engram", binary: mine, version: PIN } };
    const r = rig({ config });
    const outcome = await run(r);
    expect(outcome.engram).toMatchObject({ action: "skipped", path: mine });
    expect(outcome.engram.message).toContain("memory.binary");
    expect(r.urls).toEqual([]);
    expect(readJson(r.configPath)).toEqual(config);
    expect(existsSync(r.vendor)).toBe(false);
    expect(existsSync(lockPath(r))).toBe(false);
  });

  it("still refreshes the latest-version cache", async () => {
    const mine = join(tmpdir(), "my-engram", BINARY);
    const r = rig({ config: { memory: { provider: "engram", binary: mine } } });
    await run(r);
    expect(r.latestUrls).toHaveLength(2);
  });
});

describe("ensure engram: nothing changes when verification fails", () => {
  async function assertUntouched(r: Rig, outcome: EnsureOutcome) {
    expect(outcome.engram.action).toBe("failed");
    expect(readFileSync(r.copy, "utf8")).toBe("corrupt old copy");
    expect(readdirSync(r.vendor)).toEqual([PIN]);
    expect(tmpEntries(r)).toEqual([]);
    expect(existsSync(lockPath(r))).toBe(false);
    expect(existsSync(r.configPath)).toBe(false);
    expect(existsSync(r.mcpPath)).toBe(false);
  }

  it("fails on a checksum that does not match", async () => {
    const r = rig({ copy: "corrupt old copy", checksum: "bad" });
    const outcome = await run(r);
    expect(outcome.engram.message).toContain("checksum");
    expect(r.events).toEqual([]);
    await assertUntouched(r, outcome);
  });

  it("fails when checksums.txt has no line for the asset", async () => {
    const r = rig({ copy: "corrupt old copy", checksum: "missing" });
    const outcome = await run(r);
    expect(outcome.engram.message).toContain("checksums.txt");
    expect(r.events).toEqual([]);
    await assertUntouched(r, outcome);
  });

  it("fails when the extracted binary reports another version", async () => {
    const r = rig({ copy: "corrupt old copy", archiveVersion: "3.5.0" });
    const outcome = await run(r);
    expect(outcome.engram.message).toContain("3.5.0");
    expect(outcome.engram.message).toContain(PIN);
    expect(r.events).toEqual(["extract", "exec"]);
    await assertUntouched(r, outcome);
  });

  it("fails when the extracted binary does not run", async () => {
    const r = rig({ copy: "corrupt old copy", archiveVersion: "garbage" });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("failed");
    expect(r.events).not.toContain("smoke");
    await assertUntouched(r, outcome);
  });

  it("fails when the health smoke fails, naming why", async () => {
    const r = rig({
      copy: "corrupt old copy",
      smoke: async () => ({ ok: false, reason: "health is degraded (realReadOk false)" }),
    });
    const outcome = await run(r);
    expect(outcome.engram.message).toContain("health is degraded");
    await assertUntouched(r, outcome);
  });

  it("fails when extraction rejects the archive, such as a zip-slip entry", async () => {
    const r = rig({
      copy: "corrupt old copy",
      extract: async () => ({ ok: false, reason: "the archive has an unsafe entry: ../evil" }),
    });
    const outcome = await run(r);
    expect(outcome.engram.message).toContain("unsafe entry");
    await assertUntouched(r, outcome);
  });

  it("fails on a redirect to a host that is not allowed", async () => {
    const download: DownloadFetch = async (url) =>
      url.endsWith("checksums.txt")
        ? new Response("x", { status: 200 })
        : new Response(null, { status: 302, headers: { location: "https://evil.example.com/a" } });
    const r = rig({ copy: "corrupt old copy", download });
    const outcome = await run(r);
    expect(outcome.engram.message).toContain("not allowed");
    await assertUntouched(r, outcome);
  });

  it("fails on a download that announces more than the cap", async () => {
    const download: DownloadFetch = async () =>
      new Response("x", { status: 200, headers: { "content-length": String(151 * 1024 * 1024) } });
    const r = rig({ copy: "corrupt old copy", download });
    const outcome = await run(r);
    expect(outcome.engram.message).toContain("larger than");
    await assertUntouched(r, outcome);
  });

  it("deletes the temporary folder even when the smoke throws", async () => {
    const r = rig({
      copy: "corrupt old copy",
      smoke: async () => {
        throw new Error("boom");
      },
    });
    const outcome = await run(r);
    expect(outcome.engram).toMatchObject({ action: "failed" });
    await assertUntouched(r, outcome);
  });
});

describe("ensure engram: going offline", () => {
  const offline: DownloadFetch = async () => {
    throw new TypeError("fetch failed");
  };

  it("fails with a short message instead of crashing", async () => {
    const r = rig({ download: offline });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("failed");
    expect(outcome.engram.message).toBe(
      "could not download checksums.txt: network error: fetch failed",
    );
    expect(existsSync(r.copy)).toBe(false);
  });

  it("records the failure so it is not retried for a while", async () => {
    const r = rig({ download: offline });
    await run(r);
    expect(r.state.engramInstall).toEqual({
      failedAt: iso(NOW),
      message: "could not download checksums.txt: network error: fetch failed",
    });
  });

  it("keeps the latest-version cache when it records the failure", async () => {
    const r = rig({ download: offline });
    await run(r);
    expect(r.state.tools.engram?.latest).toBe(PIN);
  });
});

describe("ensure engram: the cooldown after a failure", () => {
  const failedAgo = (ms: number): ToolsState => ({
    version: 1,
    tools: {},
    engramInstall: { failedAt: iso(NOW - ms), message: "network error: fetch failed" },
  });

  it("does not try again 5 h 59 min after a failure", async () => {
    const r = rig({ state: failedAgo(5 * HOUR + 59 * MINUTE) });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("failed");
    expect(outcome.engram.message).toContain("--force");
    expect(outcome.engram.message).toContain("network error: fetch failed");
    expect(r.urls).toEqual([]);
    expect(existsSync(r.copy)).toBe(false);
  });

  it("tries again after 6 h and 1 ms", async () => {
    const r = rig({ state: failedAgo(6 * HOUR + 1) });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("installed");
  });

  it("tries again inside the cooldown with --force", async () => {
    const r = rig({ state: failedAgo(HOUR), force: true });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("installed");
  });

  it("does not hold back a copy that is already fine", async () => {
    const r = rig({ copy: `engram ${PIN}`, state: failedAgo(MINUTE) });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("none");
  });
});

describe("ensure engram: only one at a time", () => {
  it("returns busy at once, doing nothing, when another ensure holds a fresh lock", async () => {
    const r = rig();
    write(lockPath(r), JSON.stringify({ pid: 1 }));
    utimesSync(lockPath(r), new Date(NOW - 5 * MINUTE), new Date(NOW - 5 * MINUTE));
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("busy");
    expect(r.urls).toEqual([]);
    expect(r.latestUrls).toEqual([]);
    expect(existsSync(lockPath(r))).toBe(true);
    expect(existsSync(r.copy)).toBe(false);
  });

  it("takes over a lock older than 15 minutes", async () => {
    const r = rig();
    write(lockPath(r), JSON.stringify({ pid: 1 }));
    utimesSync(lockPath(r), new Date(NOW - 16 * MINUTE), new Date(NOW - 16 * MINUTE));
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("installed");
    expect(existsSync(lockPath(r))).toBe(false);
  });

  it("releases the lock after a failure too", async () => {
    const r = rig({ checksum: "bad" });
    await run(r);
    expect(existsSync(lockPath(r))).toBe(false);
  });
});

describe("ensure engram: a copy the runtime is using", () => {
  const busy: Partial<EnsureFs> = {
    rename: (from, to) => {
      if (from.endsWith(PIN)) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      nodeEnsureFs.rename(from, to);
    },
  };

  it("asks to stop the runtime and leaves the previous state intact", async () => {
    const r = rig({ copy: "corrupt old copy", fs: busy });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("failed");
    expect(outcome.engram.message).toContain(
      "Engram is in use: stop the runtime (haril stop) and retry",
    );
    expect(readFileSync(r.copy, "utf8")).toBe("corrupt old copy");
    expect(readdirSync(r.vendor)).toEqual([PIN]);
    expect(tmpEntries(r)).toEqual([]);
    expect(existsSync(r.configPath)).toBe(false);
  });

  it("does not start the six-hour cooldown, so the retry works at once", async () => {
    const r = rig({ copy: "corrupt old copy", fs: busy });
    await run(r);
    expect(r.state.engramInstall).toBeUndefined();
  });
});

describe("ensure engram: haril.json", () => {
  it("writes the memory section after a verified install when there is none", async () => {
    const r = rig({ config: { providers: { a: 1 }, ui: { theme: "x" } } });
    await run(r);
    expect(readJson(r.configPath)).toEqual({
      providers: { a: 1 },
      ui: { theme: "x" },
      memory: { provider: "engram", binary: r.copy, version: PIN },
    });
  });

  it("creates the file when there is none", async () => {
    const r = rig();
    await run(r);
    expect(readJson(r.configPath)).toEqual({
      memory: { provider: "engram", binary: r.copy, version: PIN },
    });
  });

  it("never overrides an existing memory section, provider null included", async () => {
    const config = { memory: { provider: "null" }, other: 1 };
    const r = rig({ config });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("installed");
    expect(readJson(r.configPath)).toEqual(config);
  });

  it("updates a managed section that names an older version, and only that", async () => {
    const r = rig();
    const previous = join(r.vendor, "3.5.0", BINARY);
    write(previous, "engram 3.5.0");
    write(
      r.configPath,
      JSON.stringify({
        keep: true,
        memory: { provider: "engram", binary: previous, version: "3.5.0" },
      }),
    );
    const outcome = await run(r);
    expect(outcome.engram).toMatchObject({ action: "updated", from: "3.5.0", to: PIN });
    expect(readJson(r.configPath)).toEqual({
      keep: true,
      memory: { provider: "engram", binary: r.copy, version: PIN },
    });
    expect(existsSync(previous)).toBe(true);
  });

  it("updates the configuration alone when the copy is current but the section is old", async () => {
    const r = rig({ copy: `engram ${PIN}` });
    const previous = join(r.vendor, "3.5.0", BINARY);
    write(previous, "engram 3.5.0");
    write(
      r.configPath,
      JSON.stringify({ memory: { provider: "engram", binary: previous, version: "3.5.0" } }),
    );
    const outcome = await run(r);
    expect(outcome.engram).toMatchObject({ action: "updated", from: "3.5.0", to: PIN });
    expect(r.urls).toEqual([]);
    expect(readJson(r.configPath).memory).toEqual({
      provider: "engram",
      binary: r.copy,
      version: PIN,
    });
  });

  it("still installs the copy but leaves a haril.json it cannot parse alone", async () => {
    const r = rig({ rawConfig: "{ this is not json" });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("installed");
    expect(readFileSync(r.configPath, "utf8")).toBe("{ this is not json");
    expect(outcome.engram.notes?.join("\n")).toContain("haril.json");
    expect(existsSync(r.mcpPath)).toBe(false);
  });

  it("does not leave a temporary settings file behind", async () => {
    const r = rig();
    await run(r);
    expect(readdirSync(dirname(r.configPath))).toEqual(["haril.json"]);
  });

  it("keeps the old settings when the new ones cannot be written, and says so", async () => {
    const config = { ui: 1 };
    const r = rig({
      config,
      fs: {
        rename: (from, to) => {
          if (to.endsWith("haril.json")) throw new Error("EPERM: operation not permitted");
          nodeEnsureFs.rename(from, to);
        },
      },
    });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("installed");
    expect(outcome.engram.notes?.join("\n")).toContain("could not update");
    expect(readJson(r.configPath)).toEqual(config);
  });

  it("does not prune the folder haril.json still points at when it could not be updated", async () => {
    const refuseConfig: Partial<EnsureFs> = {
      rename: (from, to) => {
        if (to.endsWith("haril.json")) throw new Error("EPERM: operation not permitted");
        nodeEnsureFs.rename(from, to);
      },
    };
    const r = rig({ fs: refuseConfig });
    const stale = join(r.vendor, "3.3.0", BINARY);
    write(stale, "engram 3.3.0");
    write(join(r.vendor, "3.5.0", BINARY), "engram 3.5.0");
    const config = { memory: { provider: "engram", binary: stale, version: "3.3.0" } };
    write(r.configPath, JSON.stringify(config));
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("updated");
    expect(readJson(r.configPath)).toEqual(config);
    expect(readdirSync(r.vendor).sort()).toEqual(["3.3.0", "3.5.0", PIN]);
  });
});

describe("ensure engram: the Pi MCP entry", () => {
  it("registers Engram in <root>/agent/mcp.json with the entry npm run memory:install writes", async () => {
    const r = rig({ mcp: { mcpServers: { other: { command: "x" } } } });
    await run(r);
    const mcp = readMcp(r.mcpPath);
    expect(mcp.mcpServers.other).toEqual({ command: "x" });
    expect(mcp.mcpServers.engram).toMatchObject({
      command: r.copy,
      args: ["mcp", "--tools=agent"],
      env: {
        ENGRAM_DATA_DIR: join(r.dataDir, "memory", "engram"),
        ENGRAM_PROJECT: "haril",
        ENGRAM_STARTUP_POLICY: "deny",
        ENGRAM_NO_UPDATE_CHECK: "1",
      },
      exposure: "direct",
    });
  });

  it("does not register it when the user chose provider null, and says so", async () => {
    const r = rig({ config: { memory: { provider: "null" } } });
    const outcome = await run(r);
    expect(existsSync(r.mcpPath)).toBe(false);
    expect(outcome.engram.notes?.join("\n")).toContain("MCP");
  });

  it("refreshes an entry that already exists even when the provider is null", async () => {
    const r = rig({
      config: { memory: { provider: "null" } },
      mcp: { mcpServers: { engram: { command: "/old/engram", args: [] } } },
    });
    await run(r);
    expect(readMcp(r.mcpPath).mcpServers.engram?.command).toBe(r.copy);
  });

  it("leaves an mcp.json it cannot parse alone", async () => {
    const r = rig({ rawMcp: "nope" });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("installed");
    expect(readFileSync(r.mcpPath, "utf8")).toBe("nope");
    expect(outcome.engram.notes?.join("\n")).toContain("mcp.json");
  });

  it("never touches a project's .pi/mcp.json", async () => {
    const r = rig();
    const project = join(r.root, "project", ".pi", "mcp.json");
    write(project, "{}");
    await run(r);
    expect(readFileSync(project, "utf8")).toBe("{}");
  });
});

describe("ensure engram: the user's own ~/.engram", () => {
  it("refuses a runtime folder inside it and creates nothing", async () => {
    const r = rig();
    const input = { ...r.input, runtimeRoot: join(r.home, ".engram", "haril") };
    const outcome = await ensureEngram(input, r.deps);
    expect(outcome.engram.action).toBe("failed");
    expect(outcome.engram.message).toContain("~/.engram");
    expect(existsSync(join(r.home, ".engram"))).toBe(false);
    expect(r.urls).toEqual([]);
  });

  it("refuses a settings file inside it", async () => {
    const r = rig();
    const input = { ...r.input, configPath: join(r.home, ".engram", "haril.json") };
    const outcome = await ensureEngram(input, r.deps);
    expect(outcome.engram.message).toContain("~/.engram");
    expect(r.urls).toEqual([]);
  });

  it("refuses a data folder inside it", async () => {
    const r = rig();
    const input = { ...r.input, dataDir: join(r.home, ".engram", "data") };
    const outcome = await ensureEngram(input, r.deps);
    expect(outcome.engram.message).toContain("~/.engram");
  });

  it("allows a sibling that only shares the name prefix", async () => {
    const r = rig();
    const input = { ...r.input, dataDir: join(r.home, ".engram-other", "data") };
    const outcome = await ensureEngram(input, r.deps);
    expect(outcome.engram.action).toBe("installed");
  });
});

describe("ensure engram: unsupported platforms", () => {
  it("says there is no release for the platform and downloads nothing", async () => {
    const r = rig({ platform: "freebsd", arch: "x64" });
    const outcome = await run(r);
    expect(outcome.engram.action).toBe("failed");
    expect(outcome.engram.message).toContain("freebsd/x64");
    expect(r.urls).toEqual([]);
    expect(r.state.engramInstall).toBeUndefined();
  });
});

describe("the result as a whole", () => {
  it("carries a status report that agrees with the action", async () => {
    const r = rig();
    const outcome: { engram: EngramEnsureResult; report: EnsureOutcome["report"] } = await run(r);
    expect(outcome.report.schema).toBe("haril.tools.status/1");
    expect(outcome.report.tools.map((tool) => tool.id)).toEqual(["engram", "gentle-ai"]);
  });
});
