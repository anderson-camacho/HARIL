import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runtimeLogFile, spawnDetached } from "../src/runtime-start.js";
import { openSeedStore, queueTask } from "./seed.js";

// The real spawn port (LD-T6, ADR-0022): `haril start --started-by shell` runs detached, its output goes to the log of
// the day, it records runtime.started_by_shell once it holds the lease, and it exits on its own after its idle window.
// The CLI runs from its sources against a temp data dir and runtime root, with the simulated agent; nothing of the
// user's data or keys is used.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const MAIN = join(REPO, "apps", "haril", "src", "main.ts");
// The test-only hook that lets Node run the workspace's TypeScript sources (the CLI's stop test uses it too).
const REGISTER = join(REPO, "integrations", "state-sqlite", "tests", "crash", "register.mjs");
const EXIT_TIMEOUT_MS = 60_000;
const FAKE_SECRET = "fake-provider-value-not-a-key";

let root: string;
let dataDir: string;
let runtimeRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-spawn-"));
  dataDir = join(root, "data");
  runtimeRoot = join(root, "runtime");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The environment of the child: this process's, without any HARIL_* variable, pointed at the temp roots. The provider
// key variable holds a fake value, to show it reaches neither the log nor the store.
function hermeticEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith("HARIL_")) env[name] = value;
  }
  return {
    ...env,
    HARIL_HOME: dataDir,
    HARIL_RUNTIME_DIR: runtimeRoot,
    HARIL_CLIPROXYAPI_KEY: FAKE_SECRET,
  };
}

describe("spawnDetached with the real CLI (LD-T6)", () => {
  it("starts a detached runtime that records its start, logs to logs/ and exits idle", async () => {
    const store = openSeedStore(dataDir);
    try {
      const project = store.projects.register({ slug: "solo", name: "Solo", rootPath: root });
      queueTask(store, project.projectId, "Work for the shell's runtime");
    } finally {
      store.close();
    }
    // The haril entry: registers the hook, then runs the CLI's main from its sources.
    const entry = join(root, "haril-from-source.mjs");
    writeFileSync(
      entry,
      [
        `import ${JSON.stringify(pathToFileURL(REGISTER).href)};`,
        `await import(${JSON.stringify(pathToFileURL(MAIN).href)});`,
      ].join("\n"),
      "utf8",
    );
    const logFile = runtimeLogFile(runtimeRoot, Date.now());
    expect(existsSync(dirname(logFile))).toBe(false);

    const runtime = spawnDetached({
      harilEntry: entry,
      args: ["start", "--started-by", "shell", "--data-dir", dataDir, "--idle-exit-sec", "1"],
      logFile,
      cwd: runtimeRoot,
      env: hermeticEnv(),
    });
    expect(runtime.pid).toBeGreaterThan(0);
    expect(runtime.running).toBe(true);
    const exited = new Promise<number | null>((resolve) => runtime.onExit(resolve));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("the runtime did not exit idle")),
          EXIT_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    expect(runtime.running).toBe(false);
    // The exit code reaches the listener: 0, idle with nothing failed.
    expect(code).toBe(0);

    const log = readFileSync(logFile, "utf8");
    expect(log).toContain(
      `runtime up (pid ${runtime.pid}): waiting for work, exits after 1 s idle`,
    );
    expect(log).toMatch(/completed \S+ Work for the shell's runtime/);
    expect(log).toContain(`done: 1 completed, 0 failed, 0 blocked (pid ${runtime.pid})`);
    expect(log).not.toContain(FAKE_SECRET);

    const after = openSeedStore(dataDir);
    try {
      const started = after.events
        .list()
        .filter((event) => event.type === "runtime.started_by_shell");
      expect(started).toHaveLength(1);
      expect(started[0]?.payload).toEqual({ pid: runtime.pid, epoch: 1 });
      expect(started[0]?.audit).toBe(true);
      expect(JSON.stringify(after.events.list())).not.toContain(FAKE_SECRET);
      expect(after.runtime.leaseSummary().status).toBe("released");
    } finally {
      after.close();
    }
  }, 90_000);
});
