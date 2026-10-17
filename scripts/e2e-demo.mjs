#!/usr/bin/env node
// End-to-end check of the live demo (LD-T7b): a person types a goal, a planner proposes a plan, the person approves
// it, the plan's tasks run and the work is done. It builds nothing: `npm run e2e:demo` runs the build first. Every
// step runs the built CLI in a child process against this run's own temporary root (HARIL_HOME, HARIL_RUNTIME_DIR,
// HARIL_CONFIG and a project); no HARIL_* variable of the parent reaches it. The simulated lane plans with fake:plan.
// The real lane plans and works with the planner and analyst agents through the fake Pi
// (integrations/agent-pi/testing/fake-pi.mjs) and a fake OpenAI-compatible upstream on loopback, so nothing leaves the
// machine and no real model or key is used. Each step prints PASS or FAIL; the first failure prints the runtime log
// tail and the status, and exits 1. Temporary directories are removed, and the metadata of other tools' installs must
// not change across the run (AR-G7).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanUpSession,
  createCli,
  expect,
  guardForeignInstalls,
  isAlive,
  runSteps,
  spawnDetached,
  waitFor,
  withoutHarilEnv,
  writeFakePiWrapper,
} from "./lib/e2e-harness.mjs";
import { FAKE_UPSTREAM_REPLY, startUpstream } from "./lib/fake-upstream.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "apps", "haril", "dist", "haril.mjs");
const CHILD_TIMEOUT_MS = 30_000;
// A runtime this run leaks exits by itself after this; the steps stop every runtime long before.
const IDLE_EXIT_SEC = 30;
const LEASE_TIMEOUT_MS = 15_000;
const APPROVAL_TIMEOUT_MS = 15_000;
const DONE_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 15_000;
const LOG_TAIL_LINES = 30;
const PROJECT = "demo";
const SIMULATED_GOAL = "Survey the demo project";
const REAL_GOAL = "Summarize the demo project for a new reader";
const DENIED_GOAL = "Rewrite the demo project from scratch";
const DEMO_MODEL = "e2e-model";
const PROVIDER_ID = "e2e";
// The fake upstream's bearer value: a fixture that only the loopback upstream checks, never a real key.
const FAKE_SECRET = "fake-secret-for-the-loopback-upstream";
const FAKE_SECRET_ENV = "DEMO_FAKE_SECRET";
const ANALYST_MAX_TOKENS = 20_000;
const PI_SCENARIO = "propose_analyst_plan";

const session = {
  root: "",
  env: {},
  projectDir: "",
  runtimeLog: "",
  runtimePid: undefined,
  upstream: undefined,
  approvalId: "",
  approvalTasks: 0,
};

const { expectCode, expectJson } = createCli(session, ENTRY, CHILD_TIMEOUT_MS);

function statusReport() {
  return expectJson(["status", "--json", "--project", PROJECT]);
}

function approvalsOf(...flags) {
  return expectJson(["approvals", "--json", "--project", PROJECT, ...flags]);
}

function approvalById(approvalId) {
  return approvalsOf("--all").find((row) => row.approvalId === approvalId);
}

function taskView(taskId) {
  return expectJson(["task", "show", taskId, "--json"]);
}

// The tasks a granted plan of the goal created: every planner names its steps "<goal> (step n of m)".
function planTasksOf(report, goal) {
  return report.taskList.filter((task) => task.goal.startsWith(`${goal} (step `));
}

function plannerTaskOf(report, goal) {
  return report.taskList.find((task) => task.goal === goal);
}

function runtimeLogLines() {
  if (!existsSync(session.runtimeLog)) return [];
  return readFileSync(session.runtimeLog, "utf8")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

// Belt and braces: the CLI never prints a key, and the fixture is not one, but no diagnostic prints it either.
function redact(text) {
  return text.split(FAKE_SECRET).join("[redacted]");
}

// What a failed step prints: the tail of the current runtime's log and the status of the demo project.
function printDiagnostics() {
  const lines = runtimeLogLines().slice(-LOG_TAIL_LINES);
  if (lines.length > 0) {
    console.log(`      runtime log, last ${lines.length} lines (${session.runtimeLog}):`);
    for (const line of lines) console.log(`        ${redact(line)}`);
  }
  try {
    const report = statusReport();
    console.log(
      `      status: tasks ${JSON.stringify(report.tasks.byState)}, runtime ${report.runtime.status}`,
    );
    for (const task of report.taskList) {
      console.log(`        ${task.state}  ${task.agentRef}  ${redact(task.goal)}`);
    }
  } catch (error) {
    console.log(`      status unavailable: ${redact(error.message)}`);
  }
}

// `haril start` detached, as the demo starts it, with its own log. Waits until this process holds the lease.
async function startRuntime(logName) {
  session.runtimeLog = join(session.root, logName);
  const child = spawnDetached({
    entry: ENTRY,
    args: ["start", "--idle-exit-sec", String(IDLE_EXIT_SEC), "--project", PROJECT],
    cwd: session.root,
    env: session.env,
    logPath: session.runtimeLog,
  });
  expect(typeof child.pid === "number", "the runtime did not spawn");
  session.runtimePid = child.pid;
  await waitFor(
    () => {
      const lease = statusReport().runtime;
      return lease.status === "active" && lease.pid === child.pid;
    },
    LEASE_TIMEOUT_MS,
    `runtime pid ${child.pid} to hold the lease`,
  );
  return `pid ${child.pid}, idle exit ${IDLE_EXIT_SEC} s`;
}

// `haril stop`, then the lease is released and the runtime process is gone.
async function stopRuntime() {
  const pid = session.runtimePid;
  expectCode(["stop"], [0]);
  await waitFor(
    () => statusReport().runtime.status === "released" && !isAlive(pid),
    STOP_TIMEOUT_MS,
    `runtime pid ${pid} to release the lease and exit`,
  );
  session.runtimePid = undefined;
  const done = runtimeLogLines().find((line) => line.startsWith("done: "));
  expect(done !== undefined, "the runtime log has no done line");
  return `lease released, pid ${pid} gone (${done})`;
}

// A task that can no longer complete ends the wait at once, with the error task show reports.
function failIfSettledWithoutSuccess(tasks) {
  const stuck = tasks.find((task) => ["failed", "cancelled", "blocked"].includes(task.state));
  if (stuck === undefined) return;
  const error = taskView(stuck.taskId).error;
  const why = error === null ? "no error recorded" : `${error.code}: ${error.message}`;
  throw new Error(`task "${stuck.goal}" (${stuck.agentRef}) is ${stuck.state}: ${redact(why)}`);
}

// Waits for the one requested approval of the project, proposed by the plan task of the goal, and checks the model its
// plan's tasks will run with.
async function awaitApproval(goal, model) {
  const pending = await waitFor(
    () => {
      const rows = approvalsOf();
      if (rows.length > 0) return rows;
      const planner = plannerTaskOf(statusReport(), goal);
      failIfSettledWithoutSuccess(planner === undefined ? [] : [planner]);
      return undefined;
    },
    APPROVAL_TIMEOUT_MS,
    "a requested approval",
  );
  expect(pending.length === 1, `${pending.length} requested approvals, expected 1`);
  const [row] = pending;
  expect(row.model === model, `approval model ${JSON.stringify(row.model)}, expected ${model}`);
  expect(row.tasks > 0, "the approval holds no tasks");
  const text = expectCode(["approvals", "--project", PROJECT], [0]).out;
  expect(
    text.includes(row.approvalId) && text.includes(`model ${model ?? "none"}`),
    `approvals does not show the approval with model ${model ?? "none"}`,
  );
  // Nothing of the plan runs before the approval: once the planner's attempt is over, the plan has no task and no
  // plan.submit waits in the queue.
  const report = await waitFor(
    () => {
      const current = statusReport();
      return plannerTaskOf(current, goal)?.state === "completed" ? current : undefined;
    },
    APPROVAL_TIMEOUT_MS,
    "the planner task to complete",
  );
  const early = planTasksOf(report, goal).length;
  expect(early === 0, `the plan created ${early} tasks before its approval`);
  const queued = report.queuedCommands.filter((command) => command.type === "plan.submit");
  expect(queued.length === 0, `${queued.length} plan.submit commands queued before the approval`);
  session.approvalId = row.approvalId;
  session.approvalTasks = row.tasks;
  return `${row.approvalId}: ${row.tasks} tasks, model ${model ?? "none"}; 0 plan tasks before approval`;
}

function approve() {
  const result = expectCode(["approve", session.approvalId], [0]);
  expect(result.out.includes("granted"), `approve did not grant: ${result.out.trim()}`);
  return "granted";
}

// Waits until the granted plan of the goal created as many tasks as it held and every task of the project completed.
async function awaitPlanDone(goal) {
  const report = await waitFor(
    () => {
      const current = statusReport();
      failIfSettledWithoutSuccess(current.taskList);
      const done =
        planTasksOf(current, goal).length === session.approvalTasks &&
        current.taskList.every((task) => task.state === "completed");
      return done ? current : undefined;
    },
    DONE_TIMEOUT_MS,
    `the ${session.approvalTasks} tasks of the plan and every other task to complete`,
  );
  const approval = approvalById(session.approvalId);
  expect(approval?.status === "granted", `approval status ${approval?.status}`);
  expect(approval.appliedAt !== null, "the runtime did not mark the approval applied");
  const planner = plannerTaskOf(report, goal);
  expect(planner?.state === "completed", `planner task state ${planner?.state}`);
  return report;
}

const steps = [
  [
    "build present",
    () => {
      expect(existsSync(ENTRY), `${ENTRY} is missing: run "npm run build" first`);
      return "apps/haril/dist/haril.mjs";
    },
  ],
  [
    "project init --yes",
    () => {
      expectCode(
        ["project", "init", session.projectDir, "--name", "Demo", "--slug", PROJECT, "--yes"],
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
    "simulated: task add --kind plan --agent fake:plan",
    () => {
      const result = expectCode(
        [
          "task",
          "add",
          SIMULATED_GOAL,
          "--kind",
          "plan",
          "--agent",
          "fake:plan",
          "--project",
          PROJECT,
        ],
        [0],
      );
      expect(result.out.includes("queued"), "task add did not queue the command");
      return "queued";
    },
  ],
  ["simulated: start runs detached", () => startRuntime("runtime-simulated.log")],
  [
    "simulated: the plan waits as one requested approval",
    () => awaitApproval(SIMULATED_GOAL, null),
  ],
  ["simulated: approve", approve],
  [
    "simulated: every task completes",
    async () => {
      const report = await awaitPlanDone(SIMULATED_GOAL);
      const count = planTasksOf(report, SIMULATED_GOAL).length;
      return `${count} plan tasks (as proposed) and the planner task completed`;
    },
  ],
  ["simulated: stop", stopRuntime],
  [
    "real lane: fake upstream, fake Pi and provider file (loopback only)",
    async () => {
      session.upstream = await startUpstream({ key: FAKE_SECRET, model: DEMO_MODEL });
      const baseUrl = `http://127.0.0.1:${session.upstream.port}/v1`;
      const configPath = join(session.root, "haril.json");
      writeFileSync(
        configPath,
        JSON.stringify({ providers: [{ id: PROVIDER_ID, baseUrl, keyEnv: FAKE_SECRET_ENV }] }),
      );
      const wrapper = writeFakePiWrapper(join(session.root, "pi-demo.mjs"), PI_SCENARIO);
      session.env = {
        ...session.env,
        HARIL_CONFIG: configPath,
        HARIL_PI_CLI_OVERRIDE: wrapper,
        [FAKE_SECRET_ENV]: FAKE_SECRET,
      };
      return `upstream on 127.0.0.1:${session.upstream.port}, fake Pi scenario ${PI_SCENARIO}`;
    },
  ],
  [
    `real lane: task add --kind plan --agent planner --model ${DEMO_MODEL}`,
    () => {
      const result = expectCode(
        [
          "task",
          "add",
          REAL_GOAL,
          "--kind",
          "plan",
          "--agent",
          "planner",
          "--model",
          DEMO_MODEL,
          "--project",
          PROJECT,
        ],
        [0],
      );
      expect(result.out.includes("queued"), "task add did not queue the command");
      return "queued";
    },
  ],
  ["real lane: start runs detached", () => startRuntime("runtime-real.log")],
  [
    "real lane: the planner's plan waits for approval with its model",
    () => awaitApproval(REAL_GOAL, DEMO_MODEL),
  ],
  ["real lane: approve", approve],
  [
    "real lane: the analyst tasks run through the fake Pi and the fake upstream",
    async () => {
      const report = await awaitPlanDone(REAL_GOAL);
      const planTasks = planTasksOf(report, REAL_GOAL);
      for (const task of planTasks) {
        const view = taskView(task.taskId);
        const what = `plan task "${task.goal}"`;
        expect(view.state === "completed", `${what}: state ${view.state}`);
        expect(view.agent === "analyst", `${what}: agent ${view.agent}`);
        expect(view.model === DEMO_MODEL, `${what}: model ${JSON.stringify(view.model)}`);
        expect(view.maxTokens === ANALYST_MAX_TOKENS, `${what}: max tokens ${view.maxTokens}`);
        const reply = view.result?.text ?? view.result?.summary;
        expect(reply === FAKE_UPSTREAM_REPLY, `${what}: result ${JSON.stringify(reply)}`);
        expect(
          view.result?.model === `${PROVIDER_ID}/${DEMO_MODEL}`,
          `${what}: served by ${JSON.stringify(view.result?.model)}`,
        );
        expect(view.tokens !== null && view.tokens.input > 0, `${what}: no ledger tokens`);
      }
      const planner = taskView(plannerTaskOf(report, REAL_GOAL).taskId);
      expect(planner.model === DEMO_MODEL, `planner task model ${JSON.stringify(planner.model)}`);
      return `${planTasks.length} analyst tasks completed with model ${DEMO_MODEL} (${PROVIDER_ID}/${DEMO_MODEL} served)`;
    },
  ],
  [
    "real lane: no task was skipped",
    () => {
      const skipped = runtimeLogLines().filter((line) => line.startsWith("skipped "));
      expect(skipped.length === 0, `skipped: ${redact(skipped.join(" | "))}`);
      return "no skipped line in the runtime log";
    },
  ],
  [
    "denial: a second plan waits for approval",
    async () => {
      expectCode(
        [
          "task",
          "add",
          DENIED_GOAL,
          "--kind",
          "plan",
          "--agent",
          "fake:plan",
          "--project",
          PROJECT,
        ],
        [0],
      );
      return awaitApproval(DENIED_GOAL, null);
    },
  ],
  [
    "denial: deny",
    () => {
      const result = expectCode(["deny", session.approvalId, "--reason", "not this plan"], [0]);
      expect(result.out.includes("denied"), `deny did not deny: ${result.out.trim()}`);
      return "denied";
    },
  ],
  [
    "denial: the runtime applies it, no plan task is created, the planner task stays completed",
    async () => {
      const approval = await waitFor(
        () => {
          const row = approvalById(session.approvalId);
          return row !== undefined && row.appliedAt !== null ? row : undefined;
        },
        APPROVAL_TIMEOUT_MS,
        "the runtime to apply the denial",
      );
      expect(approval.status === "denied", `approval status ${approval.status}`);
      expect(approval.reason === "not this plan", `approval reason ${approval.reason}`);
      const report = statusReport();
      const planTasks = planTasksOf(report, DENIED_GOAL);
      expect(planTasks.length === 0, `${planTasks.length} tasks of the denied plan exist`);
      const planner = plannerTaskOf(report, DENIED_GOAL);
      expect(planner !== undefined, "no planner task for the denied plan");
      const view = taskView(planner.taskId);
      // The planner's attempt succeeded by proposing; the person's denial does not turn it into a failure.
      expect(
        planner.state === "completed" && view.state === "completed",
        `planner task state: status ${planner.state}, task show ${view.state}`,
      );
      const text = expectCode(["task", "show", planner.taskId], [0]).out;
      expect(text.includes("state completed"), "task show does not say completed");
      return "approval denied and applied, 0 plan tasks, planner task completed";
    },
  ],
  ["real lane: stop", stopRuntime],
];

// Every step, then the foreign-installs check. Returns the exit code.
async function runAndCheck(foreign) {
  const started = Date.now();
  const passed = await runSteps(steps, printDiagnostics);
  if (!passed) return 1;
  const changes = foreign.changes();
  if (changes.length > 0) {
    console.log("FAIL  foreign installs changed during the demo run:");
    for (const change of changes) console.log(`      ${change}`);
    return 1;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`PASS  all demo steps (goal, plan, approval, done; hermetic) in ${seconds} s`);
  // One PASS line per compared root plus the user PATH.
  console.log(`PASS  foreign installs untouched (${foreign.rootCount} roots compared)`);
  return 0;
}

async function main() {
  session.root = mkdtempSync(join(tmpdir(), "haril-e2e-demo-"));
  session.env = withoutHarilEnv(process.env, {
    HARIL_HOME: join(session.root, "home"),
    HARIL_RUNTIME_DIR: join(session.root, "runtime-root"),
  });
  session.projectDir = join(session.root, "demo-project");
  mkdirSync(session.projectDir);
  const foreign = guardForeignInstalls();

  let code = 1;
  try {
    code = await runAndCheck(foreign);
  } finally {
    // The temporary root is removed whatever happened; anything left running or open fails the run.
    const problems = await cleanUpSession(session);
    for (const problem of problems) console.log(`FAIL  cleanup: ${redact(problem)}`);
    if (problems.length > 0) code = 1;
  }
  return code;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.log(`FAIL  ${redact(error.message)}`);
    process.exitCode = 1;
  },
);
