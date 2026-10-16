#!/usr/bin/env node
// End-to-end check of the M1 flow through the built CLI (M1-T8). It builds nothing: `npm run e2e` runs the
// build first. Every step runs the CLI in a child process against temporary directories (HARIL_HOME and a
// project root). Each step prints PASS or FAIL; the first failing step exits 1. Temporary directories are removed.
// M3: the installer of HARIL (haril-bootstrap install/uninstall) runs into a temporary root, and the metadata of
// other tools' installs must not change across the whole run (AR-G7, M3-T2).
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import {
  diffForeignSnapshots,
  foreignRoots,
  isEmptyDiff,
  snapshotForeignInstalls,
} from "./lib/foreign-snapshot.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "apps", "haril", "dist", "haril.mjs");
const BOOTSTRAP = join(REPO, "apps", "bootstrap", "dist", "haril-bootstrap.mjs");
const PACKAGE_JSON = join(REPO, "apps", "haril", "package.json");
const PLAN_VALID = join(REPO, "examples", "plan.valid.json");
const PLAN_CYCLE = join(REPO, "examples", "plan.cycle.json");
const CHILD_TIMEOUT_MS = 60_000;
const CRASH_TASK_MS = 15_000;
const CRASH_POLL_TIMEOUT_MS = 20_000;
const SIMULATED_NOTE = "(simulated: no real agent until M2)";
const FAKE_PI = join(REPO, "integrations", "agent-pi", "testing", "fake-pi.mjs");
const E2E_GATEWAY_KEY = "e2e-gateway-key-0123456789";
const E2E_MODEL = "e2e-model";
const E2E_REPLY = "Hello from the e2e model.";

const session = {
  root: "",
  env: {},
  projectDir: "",
  installRoot: "",
  runtime: undefined,
  runtimePid: undefined,
  runtimeLog: "",
  upstream: undefined,
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

// Runs haril-bootstrap in a child process against the temporary install root. Never throws on a non-zero exit.
function bootstrap(args) {
  const result = spawnSync(process.execPath, [BOOTSTRAP, ...args], {
    cwd: session.root,
    env: session.env,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

// Runs the installed launcher the way a user would: the .cmd shim through cmd.exe on win32, the sh shim elsewhere.
function launcher(args) {
  const bin = join(session.installRoot, "bin");
  const options = {
    cwd: session.root,
    env: session.env,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    windowsHide: true,
  };
  const result =
    process.platform === "win32"
      ? spawnSync(
          "cmd.exe",
          ["/d", "/s", "/c", `""${join(bin, "haril.cmd")}" ${args.join(" ")}"`],
          { ...options, windowsVerbatimArguments: true },
        )
      : spawnSync(join(bin, "haril"), args, options);
  if (result.error) throw result.error;
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function packageVersion() {
  return JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version;
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

// Hermetic OpenAI-compatible upstream for the M2 steps: one streamed reply with usage, bearer key checked.
// It runs in a worker thread, because the steps block on spawnSync and would starve an in-process server.
function startUpstream() {
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { role: "upstream" } });
  return new Promise((resolve, reject) => {
    worker.once("message", (port) => resolve({ port, worker }));
    worker.once("error", reject);
  });
}

function serveUpstream() {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${E2E_GATEWAY_KEY}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "auth", message: "bad key" } }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "not_found", message: "no route" } }));
      return;
    }
    request.resume();
    request.on("end", () => {
      const base = {
        id: "chatcmpl-e2e",
        object: "chat.completion.chunk",
        created: 0,
        model: E2E_MODEL,
      };
      const send = (choices, extra = {}) =>
        response.write(`data: ${JSON.stringify({ ...base, choices, ...extra })}\n\n`);
      response.writeHead(200, { "content-type": "text/event-stream" });
      send([{ index: 0, delta: { content: "Hello " }, finish_reason: null }]);
      send([{ index: 0, delta: { content: "from the e2e model." }, finish_reason: null }]);
      send([{ index: 0, delta: {}, finish_reason: "stop" }]);
      send([], { usage: { prompt_tokens: 12, completion_tokens: 5 } });
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
  parentPort.on("message", () => server.close());
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
  [
    "M2: fake upstream and Pi stand-in (hermetic, no network)",
    async () => {
      session.upstream = await startUpstream();
      const port = session.upstream.port;
      const wrapper = join(session.root, "pi-ok-via-broker.mjs");
      writeFileSync(
        wrapper,
        `process.env.FAKE_PI_SCENARIO = "ok_via_broker";\nawait import(${JSON.stringify(pathToFileURL(FAKE_PI).href)});\n`,
      );
      session.env = {
        ...session.env,
        HARIL_PI_CLI_OVERRIDE: wrapper,
        HARIL_CLIPROXYAPI_KEY: E2E_GATEWAY_KEY,
        HARIL_GATEWAY_URL: `http://127.0.0.1:${port}/v1`,
        HARIL_DEFAULT_MODEL: E2E_MODEL,
      };
      return `upstream on 127.0.0.1:${port}`;
    },
  ],
  [
    "M2: task add --agent analyst",
    () => {
      const result = expectCode(
        [
          "task",
          "add",
          "Read README.md and summarize it",
          "--agent",
          "analyst",
          "--project",
          "demo",
        ],
        [0],
      );
      expect(result.out.includes("queued"), "task add did not queue the command");
    },
  ],
  [
    "M2: start completes the analyst task through the Broker",
    () => {
      const result = expectCode(["start", "--project", "demo"], [0]);
      expect(
        /^completed \S+ Read README\.md and summarize it$/m.test(result.out),
        "the analyst task did not complete",
      );
      expect(
        result.out.includes("done: 1 completed, 0 failed, 0 blocked"),
        `unexpected summary: ${result.out.split("\n").at(-2)}`,
      );
      return "1 completed";
    },
  ],
  [
    "M2: task show prints the reply text",
    () => {
      const report = statusReport();
      const task = report.taskList.find((candidate) => candidate.goal.startsWith("Read README"));
      expect(task !== undefined, "no analyst task in status");
      const result = expectCode(["task", "show", task.taskId], [0]);
      expect(result.out.includes(`result: ${E2E_REPLY}`), "the reply text is not shown");
      return "reply shown";
    },
  ],
  [
    "M2: metrics count the ledger tokens",
    () => {
      const metrics = expectJson(["metrics", "--json", "--project", "demo"]);
      expect(metrics.tokens !== null, "no ledger tokens");
      expect(metrics.tokens.input > 0 && metrics.tokens.output > 0, "tokens are not counted");
      return `input ${metrics.tokens.input}, output ${metrics.tokens.output}`;
    },
  ],
  [
    "installer: haril-bootstrap install into a temp root",
    () => {
      const result = bootstrap(["install", "--root", session.installRoot, "--from", REPO]);
      expect(result.code === 0, `install exited ${result.code}: ${result.err || result.out}`);
      const app = join(session.installRoot, "app", packageVersion());
      expect(existsSync(join(app, "haril.mjs")), "no app/<version>/haril.mjs");
      expect(existsSync(join(session.installRoot, "bin", "haril.cmd")), "no bin/haril.cmd");
      return `app/${packageVersion()} and bin/ created`;
    },
  ],
  [
    "installer: second install is skipped",
    () => {
      const result = bootstrap(["install", "--root", session.installRoot, "--from", REPO]);
      expect(result.code === 0, `second install exited ${result.code}`);
      const steps = result.out
        .split("\n")
        .filter((line) => /^(payload|shims|current)\s/.test(line));
      expect(
        steps.length === 3 && steps.every((line) => /\sskipped\s/.test(line)),
        `not every step was skipped: ${steps.join(" | ")}`,
      );
      return "payload, shims and current skipped";
    },
  ],
  [
    "installed launcher: --version and doctor",
    () => {
      const version = launcher(["--version"]);
      expect(version.code === 0, `--version exited ${version.code}: ${version.err}`);
      expect(version.out.includes(`haril ${packageVersion()}`), `unexpected: ${version.out}`);
      const doctor = launcher(["doctor"]);
      expect(doctor.code === 0 || doctor.code === 1, `doctor exited ${doctor.code}`);
      return `haril ${packageVersion()}, doctor exit ${doctor.code}`;
    },
  ],
  [
    "installer: uninstall removes the install",
    () => {
      const result = bootstrap(["uninstall", "--root", session.installRoot]);
      expect(result.code === 0, `uninstall exited ${result.code}: ${result.err || result.out}`);
      expect(!existsSync(join(session.installRoot, "bin")), "bin/ still exists");
      expect(!existsSync(join(session.installRoot, "app")), "app/ still exists");
      return "app/ and bin/ removed";
    },
  ],
];

async function main() {
  session.root = mkdtempSync(join(tmpdir(), "haril-e2e-"));
  session.env = { ...process.env, HARIL_HOME: join(session.root, "home") };
  session.projectDir = join(session.root, "demo-project");
  session.runtimeLog = join(session.root, "runtime.log");
  session.installRoot = join(session.root, "install");
  mkdirSync(session.projectDir);
  const roots = foreignRoots();
  const foreignBefore = snapshotForeignInstalls({ roots });

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
    const diff = diffForeignSnapshots(foreignBefore, snapshotForeignInstalls({ roots }));
    if (!isEmptyDiff(diff)) {
      console.log("FAIL  foreign installs changed during the E2E run:");
      for (const [kind, entries] of Object.entries(diff)) {
        for (const entry of entries) console.log(`      ${kind}: ${entry}`);
      }
      return 1;
    }
    console.log("PASS  all E2E steps (M1 and M2 hermetic)");
    // One PASS line per compared root plus the user PATH.
    console.log(`PASS  foreign installs untouched (${roots.length + 1} roots compared)`);
    return 0;
  } finally {
    await session.upstream?.worker.terminate();
    if (session.runtimePid !== undefined && isAlive(session.runtimePid)) {
      killHard(session.runtimePid);
    }
    rmSync(session.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// The same file serves as the upstream worker of the M2 steps (see startUpstream).
if (!isMainThread) {
  serveUpstream();
} else {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.log(`FAIL  ${error.message}`);
      process.exitCode = 1;
    },
  );
}
