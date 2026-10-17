// Shared helpers of the hermetic end-to-end scripts (scripts/e2e.mjs, scripts/e2e-demo.mjs): the CLI in a child
// process against one session's temporary root and environment, the step runner, polling with a deadline, process
// control and cleanup, the fake Pi wrapper and the foreign-installs guard (AR-G7, M3-T2). Nothing here starts a step on
// its own.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  diffForeignSnapshots,
  foreignRoots,
  isEmptyDiff,
  snapshotForeignInstalls,
} from "./foreign-snapshot.mjs";

const FAKE_PI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "integrations",
  "agent-pi",
  "testing",
  "fake-pi.mjs",
);
const POLL_MS = 250;
const HARIL_ENV_PREFIX = "HARIL_";

// The CLI runner of one session: `node <entry> <args>` with the session's root as cwd and its env. Both are read on
// every call, so a step may replace session.env. The runner never throws on a non-zero exit.
export function createCli(session, entry, timeoutMs) {
  function run(args) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: session.root,
      env: session.env,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
  }

  function expectCode(args, allowed) {
    const result = run(args);
    if (!allowed.includes(result.code)) {
      throw new Error(
        `"haril ${args.join(" ")}" exited ${result.code}, expected ${allowed.join(" or ")}: ${result.err.trim()}`,
      );
    }
    return result;
  }

  function expectJson(args, allowedCodes = [0]) {
    const result = expectCode(args, allowedCodes);
    try {
      return JSON.parse(result.out);
    } catch {
      throw new Error(`"haril ${args.join(" ")}" did not print JSON`);
    }
  }

  return { run, expectCode, expectJson };
}

export function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// Runs the steps in order and prints one PASS or FAIL line for each. The first failure calls onFailure, which prints
// what helps to diagnose it, and stops the run: the result is false.
export async function runSteps(steps, onFailure) {
  for (const [name, run] of steps) {
    try {
      const detail = await run();
      console.log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
    } catch (error) {
      console.log(`FAIL  ${name}: ${error.message}`);
      onFailure();
      return false;
    }
  }
  return true;
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// Kills pid at once. Returns true when it killed the process and false when the process had already exited: a runtime
// may exit by itself between a liveness check and the kill, which is not an error. Throws only when a process that is
// still alive could not be killed.
export function killHard(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/F", "/PID", String(pid)], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) return true;
    if (!isAlive(pid)) return false;
    throw new Error(`taskkill /F /PID ${pid} failed: ${(result.stderr ?? "").trim()}`);
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

// The cleanup of one session, in an order that never skips its last step: the fake upstream closes, a runtime that is
// still alive is killed, and the temporary root is removed whatever happened before. Returns what went wrong before the
// removal, for the caller to report; only a root that cannot be removed throws.
export async function cleanUpSession(session) {
  const problems = [];
  try {
    await session.upstream?.close();
  } catch (error) {
    problems.push(`the fake upstream did not close: ${error.message}`);
  }
  try {
    if (session.runtimePid !== undefined && isAlive(session.runtimePid)) {
      killHard(session.runtimePid);
    }
  } catch (error) {
    problems.push(`the runtime was not stopped: ${error.message}`);
  }
  rmSync(session.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return problems;
}

// Starts `node <entry> <args>` detached, with stdout and stderr in logPath (truncated first). The caller stops it, or
// kills it in its cleanup. Returns the child process.
export function spawnDetached({ entry, args, cwd, env, logPath }) {
  const logFd = openSync(logPath, "w");
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  closeSync(logFd);
  child.unref();
  return child;
}

// A wrapper at path that selects one fake-pi scenario (and its environment) and runs fake-pi.mjs with the current
// Node. HARIL_PI_CLI_OVERRIDE points the real lane at it. Returns the path.
export function writeFakePiWrapper(path, scenario, env = {}) {
  const assignments = Object.entries({ FAKE_PI_SCENARIO: scenario, ...env })
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};\n`)
    .join("");
  writeFileSync(
    path,
    `${assignments}await import(${JSON.stringify(pathToFileURL(FAKE_PI).href)});\n`,
  );
  return path;
}

// The base environment without any HARIL_* variable, then the given one. Variables are dropped by name and their
// values are never read, so no configuration, model or key of the user reaches the children (Windows names are
// matched without case, as Windows does).
export function withoutHarilEnv(base, extra = {}) {
  const kept = Object.entries(base).filter(
    ([name]) => !name.toUpperCase().startsWith(HARIL_ENV_PREFIX),
  );
  return { ...Object.fromEntries(kept), ...extra };
}

// The foreign-installs guard of one run: a metadata snapshot of other tools' installs now, compared with a second one
// by changes(), which lists every difference as "<kind>: <entry>" (empty when nothing changed). rootCount counts the
// compared roots plus the user PATH.
export function guardForeignInstalls() {
  const roots = foreignRoots();
  const before = snapshotForeignInstalls({ roots });
  return {
    rootCount: roots.length + 1,
    changes() {
      const diff = diffForeignSnapshots(before, snapshotForeignInstalls({ roots }));
      if (isEmptyDiff(diff)) return [];
      return Object.entries(diff).flatMap(([kind, entries]) =>
        entries.map((entry) => `${kind}: ${entry}`),
      );
    },
  };
}
