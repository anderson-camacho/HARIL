#!/usr/bin/env node
// End-to-end check of the M1 flow through the built CLI (M1-T8). It builds nothing: `npm run e2e` runs the
// build first. Every step runs the CLI in a child process against temporary directories (HARIL_HOME and a
// project root). Each step prints PASS or FAIL; the first failing step exits 1. Temporary directories are removed.
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "apps", "haril", "dist", "haril.mjs");
const PLAN_VALID = join(REPO, "examples", "plan.valid.json");
const PLAN_CYCLE = join(REPO, "examples", "plan.cycle.json");
const CHILD_TIMEOUT_MS = 60_000;
const CRASH_TASK_MS = 15_000;
const CRASH_POLL_TIMEOUT_MS = 20_000;
const SIMULATED_NOTE = "(simulated: no real agent until M2)";

const session = {
  root: "",
  env: {},
  projectDir: "",
  runtime: undefined,
  runtimePid: undefined,
  runtimeLog: "",
};

// Runs the CLI in a child process and returns its exit code and output. Never throws on a non-zero exit.
function haril(args) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: session.root,
    env: session.env,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function expectCode(args, allowed) {
  const result = haril(args);
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

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function statusReport() {
  return expectJson(["status", "--json", "--project", "demo"]);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function killHard(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/F", "/PID", String(pid)], { encoding: "utf8" });
    expect(result.status === 0, `taskkill /F /PID ${pid} failed: ${result.stderr ?? ""}`);
  } else {
    process.kill(pid, "SIGKILL");
  }
}

const steps = [
  [
    "build present",
    () => {
      expect(existsSync(ENTRY), `${ENTRY} is missing: run "npm run build" first`);
      return "apps/haril/dist/haril.mjs";
    },
  ],
  ["doctor (0 or 1: Node 24.19 warns, M1-D1)", () => `exit ${expectCode(["doctor"], [0, 1]).code}`],
  [
    "project init preview creates nothing",
    () => {
      expectCode(["project", "init", session.projectDir, "--name", "Demo", "--slug", "demo"], [0]);
      expect(readdirSync(session.projectDir).length === 0, "preview created files in the project");
      return "nothing applied";
    },
  ],
  [
    "project init --yes",
    () => {
      expectCode(
        ["project", "init", session.projectDir, "--name", "Demo", "--slug", "demo", "--yes"],
        [0],
      );
      expect(
        existsSync(join(session.projectDir, ".haril", "project.json")),
        "no .haril/project.json",
      );
      return ".haril/project.json written";
    },
  ],
  [
    "task add (fake:succeed by default)",
    () => {
      const result = expectCode(["task", "add", "Succeed", "--project", "demo"], [0]);
      expect(result.out.includes("queued"), "task add did not queue the command");
    },
  ],
  [
    "task add fake:fail --max-attempts 2",
    () => {
      expectCode(
        [
          "task",
          "add",
          "Fails",
          "--agent",
          "fake:fail",
          "--max-attempts",
          "2",
          "--project",
          "demo",
        ],
        [0],
      );
    },
  ],
  [
    "plan import examples/plan.valid.json",
    () => {
      const result = expectCode(["plan", "import", PLAN_VALID, "--project", "demo"], [0]);
      expect(result.out.includes("queued"), "plan import did not queue");
    },
  ],
  [
    "plan import again is idempotent",
    () => {
      const result = expectCode(["plan", "import", PLAN_VALID, "--project", "demo"], [0]);
      expect(result.out.includes("already queued"), "re-import was not reported as already queued");
    },
  ],
  [
    "plan import examples/plan.cycle.json is rejected",
    () => {
      const result = expectCode(["plan", "import", PLAN_CYCLE, "--project", "demo"], [1]);
      expect(result.out.includes("cycle"), "the cycle was not reported");
    },
  ],
  [
    "status --json shows the queued commands",
    () => {
      const report = statusReport();
      expect(report.queuedCommands.length >= 2, `only ${report.queuedCommands.length} queued`);
      return `${report.queuedCommands.length} queued`;
    },
  ],
  [
    "start runs the queue (exit 1: one task fails)",
    () => {
      const result = expectCode(["start", "--project", "demo"], [1]);
      const simulated = result.out
        .split("\n")
        .filter((line) => line.startsWith("completed ") && line.endsWith(SIMULATED_NOTE));
      expect(simulated.length === 4, `expected 4 simulated completions, got ${simulated.length}`);
      expect(
        result.out.includes("done: 5 completed, 1 failed, 0 blocked"),
        `unexpected summary: ${result.out.split("\n").at(-2)}`,
      );
      return "5 completed (4 simulated), 1 failed";
    },
  ],
  [
    "second start has no work (exit 0)",
    () => {
      const result = expectCode(["start", "--project", "demo"], [0]);
      expect(
        result.out.includes("done: 0 completed, 0 failed, 0 blocked"),
        "second start did work",
      );
    },
  ],
  [
    "metrics --json agrees with status",
    () => {
      const metrics = expectJson(["metrics", "--json", "--project", "demo"]);
      const report = statusReport();
      expect(metrics.tasks.completed === report.tasks.byState.completed, "completed tasks differ");
      expect(metrics.tasks.failed === report.tasks.byState.failed, "failed tasks differ");
      expect(metrics.tasks.completed === 5 && metrics.tasks.failed === 1, "unexpected task counts");
      expect(metrics.runs.completed === 5 && metrics.runs.failed === 2, "unexpected run counts");
      expect(
        metrics.runs.total ===
          metrics.runs.completed +
            metrics.runs.failed +
            metrics.runs.orphaned +
            metrics.runs.running,
        "run total does not add up",
      );
      return `runs ${metrics.runs.total}, success ${metrics.successRate}`;
    },
  ],
  [
    "events --limit 5",
    () => {
      const result = expectCode(["events", "--project", "demo", "--limit", "5"], [0]);
      const lines = result.out.split("\n").filter((line) => line.trim() !== "");
      expect(lines.length >= 1 && lines.length <= 5, `${lines.length} lines`);
      return `${lines.length} lines`;
    },
  ],
  [
    "crash: task add fake:slow",
    () => {
      expectCode(
        ["task", "add", "Crash", "--agent", `fake:slow:${CRASH_TASK_MS}`, "--project", "demo"],
        [0],
      );
    },
  ],
  [
    "crash: start runs detached",
    () => {
      const logFd = openSync(session.runtimeLog, "w");
      const child = spawn(process.execPath, [ENTRY, "start", "--project", "demo"], {
        cwd: session.root,
        env: session.env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      });
      closeSync(logFd);
      child.unref();
      session.runtime = child;
      expect(typeof child.pid === "number", "the runtime did not spawn");
      return `pid ${child.pid}`;
    },
  ],
  [
    "crash: task is running",
    async () => {
      const running = await waitFor(
        () => {
          const report = statusReport();
          const task = report.taskList.find((candidate) => candidate.goal === "Crash");
          const lease = report.runtime;
          return task?.state === "running" && lease.status === "active" ? lease : undefined;
        },
        CRASH_POLL_TIMEOUT_MS,
        "the Crash task to be running",
      );
      session.runtimePid = running.pid;
      return `lease pid ${running.pid}`;
    },
  ],
  [
    "crash: kill -9 the runtime mid-run",
    async () => {
      const pid = session.runtimePid;
      killHard(pid);
      await waitFor(() => !isAlive(pid), 5_000, `pid ${pid} to exit`);
      session.runtime = undefined;
      return `pid ${pid} killed`;
    },
  ],
  [
    "crash: start recovers and completes the task",
    () => {
      const result = expectCode(["start", "--project", "demo"], [0]);
      expect(
        /^recovered \S+ Crash \(orphaned, restart 1\/3\)$/m.test(result.out),
        "no recovered line",
      );
      expect(
        /^claimed \S+ Crash \(attempt 1\/1\)$/m.test(result.out),
        "claim line is not attempt 1/1",
      );
      expect(/^completed \S+ Crash/m.test(result.out), "the recovered task did not complete");
      return "recovered, then completed";
    },
  ],
  [
    "crash: metrics count one orphaned recovery",
    () => {
      const metrics = expectJson(["metrics", "--json", "--project", "demo"]);
      expect(metrics.orphanedRecoveries === 1, `orphanedRecoveries ${metrics.orphanedRecoveries}`);
      expect(metrics.runs.orphaned === 1, `runs.orphaned ${metrics.runs.orphaned}`);
      return "1 orphaned recovery";
    },
  ],
];

async function main() {
  session.root = mkdtempSync(join(tmpdir(), "haril-e2e-"));
  session.env = { ...process.env, HARIL_HOME: join(session.root, "home") };
  session.projectDir = join(session.root, "demo-project");
  session.runtimeLog = join(session.root, "runtime.log");
  mkdirSync(session.projectDir);

  try {
    for (const [name, run] of steps) {
      try {
        const detail = await run();
        console.log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
      } catch (error) {
        console.log(`FAIL  ${name}: ${error.message}`);
        if (existsSync(session.runtimeLog)) {
          console.log(`      runtime log: ${session.runtimeLog}`);
        }
        return 1;
      }
    }
    console.log("PASS  all M1 E2E steps");
    return 0;
  } finally {
    if (session.runtimePid !== undefined && isAlive(session.runtimePid)) {
      killHard(session.runtimePid);
    }
    rmSync(session.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.log(`FAIL  ${error.message}`);
    process.exitCode = 1;
  },
);
