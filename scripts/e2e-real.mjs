#!/usr/bin/env node
// Real lane of the M2 end to end (M2-T7): one analyst task through the installed Pi runtime, the Broker and a
// real gateway (CLIProxyAPI, ADR-0021). It runs only when everything it needs is present; otherwise it prints
// the reason and exits 0. The gateway key is read from the environment and is never printed or stored.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "apps", "haril", "dist", "haril.mjs");
const CHILD_TIMEOUT_MS = 300_000;
const PROMPT = "Read README.md and summarize it in one sentence";

// Same location rule as the CLI's runtime root (apps/haril/src/runtime.ts), without importing the bundle.
function runtimeRoot() {
  const env = process.env;
  if (env.HARIL_RUNTIME_DIR) return env.HARIL_RUNTIME_DIR;
  if (process.platform === "win32") {
    return win32.join(env.LOCALAPPDATA || win32.join(homedir(), "AppData", "Local"), "HARIL");
  }
  return posix.join(env.XDG_DATA_HOME || posix.join(homedir(), ".local", "share"), "haril");
}

function skipReason() {
  const manifest = join(runtimeRoot(), "runtime", "manifest.json");
  if (!existsSync(manifest))
    return `Pi runtime not installed (${manifest} missing; run npm run runtime:install)`;
  if (!process.env.HARIL_CLIPROXYAPI_KEY) return "HARIL_CLIPROXYAPI_KEY is not set";
  if (!process.env.HARIL_DEFAULT_MODEL)
    return "HARIL_DEFAULT_MODEL is not set (use an id from haril models)";
  return undefined;
}

function harilWith(env, args) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    env,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const reason = skipReason();
  if (reason !== undefined) {
    console.log(`SKIP real lane: ${reason}`);
    return 0;
  }
  if (!existsSync(ENTRY)) {
    console.log(`FAIL  ${ENTRY} is missing: run npm run build first`);
    return 1;
  }

  const root = mkdtempSync(join(tmpdir(), "haril-e2e-real-"));
  try {
    const projectDir = join(root, "real-project");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "README.md"),
      "# Real lane\n\nHARIL runs one analyst task through a real model.\n",
    );
    // Pi gets the test seam only in the hermetic lane; the real lane must never set it.
    const env = { ...process.env, HARIL_HOME: join(root, "home") };
    delete env.HARIL_PI_CLI_OVERRIDE;

    const init = harilWith(env, [
      "project",
      "init",
      projectDir,
      "--name",
      "Real",
      "--slug",
      "real",
      "--yes",
    ]);
    expect(init.code === 0, `project init exited ${init.code}: ${init.err.trim()}`);
    const add = harilWith(env, ["task", "add", PROMPT, "--agent", "analyst", "--project", "real"]);
    expect(add.code === 0, `task add exited ${add.code}: ${add.err.trim()}`);
    const start = harilWith(env, ["start", "--project", "real"]);
    expect(start.code === 0, `start exited ${start.code}:\n${start.out}${start.err}`);
    console.log("PASS  project init, task add --agent analyst, start");
    expect(/^completed \S+ /m.test(start.out), `the analyst task did not complete:\n${start.out}`);

    const status = JSON.parse(harilWith(env, ["status", "--json", "--project", "real"]).out);
    const task = status.taskList.find((candidate) => candidate.goal === PROMPT);
    expect(task !== undefined, "the analyst task is missing from status");
    const show = harilWith(env, ["task", "show", task.taskId, "--json"]);
    expect(show.code === 0, `task show exited ${show.code}`);
    const shown = JSON.parse(show.out);
    expect(shown.state === "completed", `task state is ${shown.state}`);
    console.log(
      `PASS  task show: completed with ${String(shown.result?.text ?? "").length} characters of reply`,
    );

    const metrics = JSON.parse(harilWith(env, ["metrics", "--json", "--project", "real"]).out);
    expect(
      metrics.tokens !== null && metrics.tokens.input + metrics.tokens.output > 0,
      "no ledger tokens were counted",
    );
    console.log(
      `PASS  metrics: input ${metrics.tokens.input}, output ${metrics.tokens.output} tokens`,
    );
    console.log("PASS  real lane completed");
    return 0;
  } catch (error) {
    console.log(`FAIL  ${error.message}`);
    return 1;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

process.exitCode = main();
