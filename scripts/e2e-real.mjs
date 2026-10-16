#!/usr/bin/env node
// Real lane of the analyst path (M2-T7, ADR-0021): one analyst task through the installed Pi runtime and a real
// model, with the Broker, the token ledger, the bridge's read tool and the host verification. It is opt-in
// (npm run e2e:real), not part of npm test. It runs only when everything it needs is present; otherwise it prints
// the reason and exits 0. A key is read from the environment only when the default model's provider declares one,
// and it is never printed or stored.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "apps", "haril", "dist", "haril.mjs");
const CHILD_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 600_000;
const SECRET = "HARIL-REAL-7731";
const TASK = "Read the file README.md and reply with the secret code it contains.";
const GATEWAY_KEY_ENV = "HARIL_CLIPROXYAPI_KEY";

// Same location rule as the CLI's runtime root (apps/haril/src/runtime.ts), without importing the bundle.
function runtimeRoot() {
  const env = process.env;
  if (env.HARIL_RUNTIME_DIR) return env.HARIL_RUNTIME_DIR;
  if (process.platform === "win32") {
    return win32.join(env.LOCALAPPDATA || win32.join(homedir(), "AppData", "Local"), "HARIL");
  }
  return posix.join(env.XDG_DATA_HOME || posix.join(homedir(), ".local", "share"), "haril");
}

// The environment variable that holds the key of the default model's provider, or undefined when that provider
// needs none. The provider comes from HARIL_CONFIG or <runtime root>/config/haril.json; without a file the
// defaults apply, where only cliproxy is keyed (apps/haril/src/providers.ts).
function defaultModelKeyEnv(modelRef) {
  const providerId = modelRef.split("/")[0];
  const configPath = process.env.HARIL_CONFIG || join(runtimeRoot(), "config", "haril.json");
  if (!existsSync(configPath)) return providerId === "cliproxy" ? GATEWAY_KEY_ENV : undefined;
  try {
    const providers = JSON.parse(readFileSync(configPath, "utf8")).providers ?? [];
    const entry = providers.find((candidate) => candidate.id === providerId);
    return typeof entry?.keyEnv === "string" ? entry.keyEnv : undefined;
  } catch {
    // An unreadable file is reported by the CLI when the run starts.
    return undefined;
  }
}

function skipReason() {
  const manifest = join(runtimeRoot(), "runtime", "manifest.json");
  if (!existsSync(manifest))
    return `Pi runtime not installed (${manifest} missing; run npm run runtime:install)`;
  if (!process.env.HARIL_DEFAULT_MODEL)
    return "HARIL_DEFAULT_MODEL is not set (use an id from haril models)";
  const keyEnv = defaultModelKeyEnv(process.env.HARIL_DEFAULT_MODEL);
  if (keyEnv !== undefined && !process.env[keyEnv])
    return `${keyEnv} is not set (the default model's provider needs it)`;
  return undefined;
}

// Runs the CLI in a child process. Never throws on a non-zero exit.
function harilWith(env, args, timeoutMs) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    code: result.status,
    signal: result.signal,
    out: result.stdout ?? "",
    err: result.stderr ?? "",
  };
}

// Prints a step's output so a failure can be diagnosed. The CLI never prints a key.
function show(label, text) {
  if (text.trim() === "") return;
  console.log(`      ${label}:`);
  for (const line of text.trimEnd().split("\n")) console.log(`        ${line}`);
}

function runStep(env, args, timeoutMs = CHILD_TIMEOUT_MS) {
  console.log(`      $ haril ${args.join(" ")}`);
  const result = harilWith(env, args, timeoutMs);
  show("stdout", result.out);
  show("stderr", result.err);
  return result;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function runJson(env, args) {
  const result = runStep(env, args);
  expect(result.code === 0, `"haril ${args.join(" ")}" exited ${result.code ?? result.signal}`);
  try {
    return JSON.parse(result.out);
  } catch {
    throw new Error(`"haril ${args.join(" ")}" did not print JSON`);
  }
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
    writeFileSync(join(projectDir, "README.md"), `The secret code is ${SECRET}.\n`);
    // Pi gets the test seam only in the hermetic lane; the real lane must never set it.
    const env = { ...process.env, HARIL_HOME: join(root, "home") };
    delete env.HARIL_PI_CLI_OVERRIDE;

    const init = runStep(env, [
      "project",
      "init",
      projectDir,
      "--name",
      "Real",
      "--slug",
      "real",
      "--yes",
    ]);
    expect(init.code === 0, `project init exited ${init.code}`);
    const add = runStep(env, [
      "task",
      "add",
      TASK,
      "--agent",
      "analyst",
      "--project",
      "real",
      "--accept-output",
      SECRET,
    ]);
    expect(add.code === 0, `task add exited ${add.code}`);
    console.log("PASS  project init, task add --agent analyst --accept-output");

    const start = runStep(env, ["start", "--project", "real"], START_TIMEOUT_MS);
    expect(start.code === 0, `start exited ${start.code ?? start.signal}`);
    expect(/^completed \S+ /m.test(start.out), "the analyst task did not complete");
    console.log("PASS  start: the analyst task completed");

    const status = runJson(env, ["status", "--json", "--project", "real"]);
    const task = status.taskList.find((candidate) => candidate.goal === TASK);
    expect(task !== undefined, "the analyst task is missing from status");
    const shown = runJson(env, ["task", "show", task.taskId, "--json"]);
    expect(shown.state === "completed", `task state is ${shown.state}`);
    expect(shown.verification?.verified === true, "the completed task is not verified");
    console.log("PASS  task show: completed and verified");

    // The project holds only this run in the temporary home, so its tokens are the run's tokens.
    const metrics = runJson(env, ["metrics", "--json", "--project", "real"]);
    expect(
      metrics.tokens !== null && metrics.tokens.input + metrics.tokens.output > 0,
      "no ledger tokens were counted",
    );
    console.log(
      `PASS  ledger: input ${metrics.tokens.input}, output ${metrics.tokens.output} tokens`,
    );

    const events = runJson(env, [
      "events",
      "--project",
      "real",
      "--task",
      task.taskId,
      "--limit",
      "500",
      "--json",
    ]);
    const reads = events.filter((event) => event.type === "tool.read");
    expect(reads.length >= 1, "no tool.read event: the model did not read README.md");
    console.log(`PASS  tool.read: ${reads.length} read operation(s) through the bridge`);
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
