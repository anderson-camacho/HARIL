// Crash child for the crash-point harness (test only, never built or shipped).
// Usage: node --import <integrations/state-sqlite/tests/crash>/register.mjs child.mjs <dataDir> <point>
// <point> is cp1, cp3, cp4 or cp8. The child stops at its crash point by killing itself hard (SIGKILL, which is
// TerminateProcess on Windows): no cleanup, no lease release, no rollback. The marker file written just before the
// kill proves the point was reached, so a child that fails to load can never look like a crash.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canTransition, checkAcceptance, checkPlanSubmission, checkTaskKind } from "@haril/core";
import { openStore } from "@haril/state-sqlite";

const [dataDir, point] = process.argv.slice(2);
const rules = { canTransition, checkPlan: checkPlanSubmission, checkAcceptance, checkTaskKind };
const clock = { now: () => Date.now(), schedule: () => () => undefined };
const ids = { next: () => randomUUID() };
// Shared with the parent test, which asserts the key is revoked after recovery.
const KEY_HASH = "crash-key";

function die(name) {
  writeFileSync(join(dataDir, `reached-${name}`), "");
  process.kill(process.pid, "SIGKILL");
}

// Test-only decorator (ARCH 13.2): forwards every port call and kills the process after the N-th call of one
// method. The call itself has completed (and committed) when the process dies.
const PORTS = [
  "projects",
  "commands",
  "tasks",
  "runtime",
  "runs",
  "events",
  "metrics",
  "budgets",
  "virtualKeys",
];
function crashAfter(store, target, nth, name) {
  const [port, method] = target.split(".");
  let calls = 0;
  const decorated = { info: () => store.info(), close: () => store.close() };
  for (const portName of PORTS) {
    decorated[portName] = Object.fromEntries(
      Object.entries(store[portName]).map(([key, fn]) => [
        key,
        (...args) => {
          const result = fn(...args);
          if (portName === port && key === method && ++calls === nth) die(name);
          return result;
        },
      ]),
    );
  }
  return decorated;
}

// A project, one ready task and one claim (the runtime's own path: enqueue, apply, claim). Returns the grant.
function claimOne(store) {
  const grant = store.runtime.acquire({
    pid: process.pid,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  const project = store.projects.register({ slug: "demo", name: "Demo", rootPath: dataDir });
  store.commands.enqueue({
    type: "task.create",
    projectId: project.projectId,
    args: { goal: "A", dependsOn: [], agent: "fake:succeed", maxAttempts: 1, timeoutMs: 1000 },
    idempotencyKey: "crash-A",
    requestHash: "crash-A",
  });
  store.commands.applyNext(grant.value.epoch);
  const claimed = store.tasks.claimNext(grant.value.epoch);
  if (claimed === undefined) throw new Error("nothing claimed");
  return { claimed, projectId: project.projectId };
}

function issueKey(store, claimed, budgetId) {
  store.virtualKeys.issue({
    runId: claimed.runId,
    keyHash: KEY_HASH,
    routeGrant: { providerId: "crash" },
    budgetIds: [budgetId],
    expiresAt: Date.now() + 60_000,
  });
}

// CP1: killed after the claim and the key row, before any effect intent.
function cp1() {
  const store = crashAfter(
    openStore({ dataDir, clock, ids, rules, isPidAlive: () => true }),
    "virtualKeys.issue",
    1,
    "cp1",
  );
  const { claimed, projectId } = claimOne(store);
  const budgetId = store.budgets.ensure({
    scopeType: "project",
    scopeId: projectId,
    projectId,
    hardLimit: 1000,
  }).budgetId;
  issueKey(store, claimed, budgetId);
}

// CP4: killed mid-turn, right after a budget reservation (with its key) and before any settlement.
function cp4() {
  const store = crashAfter(
    openStore({ dataDir, clock, ids, rules, isPidAlive: () => true }),
    "budgets.reserve",
    1,
    "cp4",
  );
  const { claimed, projectId } = claimOne(store);
  const budgetId = store.budgets.ensure({
    scopeType: "project",
    scopeId: projectId,
    projectId,
    hardLimit: 1000,
  }).budgetId;
  issueKey(store, claimed, budgetId);
  store.budgets.reserve({
    budgetIds: [budgetId],
    amount: 300,
    idempotencyKey: "crash-cp4",
    runId: claimed.runId,
    taskId: claimed.taskId,
    routeId: "route-paid",
  });
}

// CP3: killed when the agent starts, before it confirms anything. The run loop itself starts the attempt.
async function cp3() {
  const store = openStore({ dataDir, clock, ids, rules, isPidAlive: () => true });
  const project = store.projects.register({ slug: "demo", name: "Demo", rootPath: dataDir });
  store.commands.enqueue({
    type: "task.create",
    projectId: project.projectId,
    args: { goal: "A", dependsOn: [], agent: "fake:succeed", maxAttempts: 1, timeoutMs: 1000 },
    idempotencyKey: "crash-A",
    requestHash: "crash-A",
  });
  const { runUntilIdle } = await import("../../src/runtime/run-loop.ts");
  await runUntilIdle({
    store,
    agentRuntime: {
      start: async () => die("cp3"),
    },
    clock,
    pid: process.pid,
    nodeVersion: process.version,
    onEvent: () => undefined,
  });
}

// CP8: killed halfway through migration 2. Migration 1 commits; migration 2 creates a table and then calls the
// crash() function inside its own transaction, so its work is still uncommitted when the process dies.
async function cp8() {
  const { configureConnection } = await import(
    "../../../../integrations/state-sqlite/src/connection.ts"
  );
  const { migrate } = await import("../../../../integrations/state-sqlite/src/migrate.ts");
  const { MIGRATION_0001 } = await import(
    "../../../../integrations/state-sqlite/src/migrations/0001_init.ts"
  );
  const db = new DatabaseSync(join(dataDir, "haril.db"));
  configureConnection(db, "wal");
  db.function("crash", () => die("cp8"));
  const halfway = {
    version: 2,
    name: "crash-halfway",
    kind: "additive",
    sql: "CREATE TABLE half (id INTEGER); INSERT INTO half VALUES (crash());",
  };
  migrate(db, clock, ids, [MIGRATION_0001, halfway]);
}

if (point === "cp1") cp1();
else if (point === "cp3") await cp3();
else if (point === "cp4") cp4();
else if (point === "cp8") await cp8();
else throw new Error(`unknown crash point "${point}"`);
