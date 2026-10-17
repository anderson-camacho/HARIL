import { randomUUID } from "node:crypto";
import { canTransition, checkAcceptance, checkPlanSubmission } from "@haril/core";
import type { Clock, Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";

// Seeds a real store in a temp data dir through the Store facets (the way the CLI's tests do), so the shell reads
// genuine rows. Two projects: "demo" holds a completed task with result and ledger tokens, a running task and a
// pending task that depends on the running one; "other" holds one unrelated task.

const clock: Clock = {
  now: () => Date.now(),
  schedule: (delayMs, run) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
};

export const SEED_TITLES = {
  completed: "Summarize the logs",
  running: "Write the parser",
  pending: "Ship the release",
  unrelated: "Unrelated task",
} as const;

export interface SeedResult {
  readonly epoch: number;
  readonly demoId: string;
  readonly otherId: string;
  readonly completedTaskId: string;
  readonly runningTaskId: string;
  readonly pendingTaskId: string;
}

export function openSeedStore(dataDir: string): Store {
  return openStore({
    dataDir,
    clock,
    ids: { next: () => randomUUID() },
    rules: { canTransition, checkPlan: checkPlanSubmission, checkAcceptance },
    isPidAlive: () => true,
  });
}

// Queues task.create, applies it and returns the new task id.
export function createTask(
  store: Store,
  projectId: string,
  epoch: number,
  goal: string,
  dependsOn: readonly string[] = [],
): string {
  const enqueued = store.commands.enqueue({
    type: "task.create",
    projectId,
    idempotencyKey: `seed-${randomUUID()}`,
    requestHash: `seed-${goal}`,
    args: {
      goal,
      dependsOn: [...dependsOn],
      agent: "fake-agent",
      model: null,
      maxAttempts: 1,
      timeoutMs: 60000,
      maxTokens: 1000,
      acceptance: [],
    },
  });
  if (enqueued.duplicate) throw new Error("seed command duplicated");
  const applied = store.commands.applyNext(epoch);
  const taskId = applied?.taskIds[0];
  if (taskId === undefined) throw new Error(`seed task "${goal}" was not applied`);
  return taskId;
}

export function seedStore(dataDir: string): SeedResult {
  const store = openSeedStore(dataDir);
  try {
    const demo = store.projects.register({
      slug: "demo",
      name: "Demo project",
      rootPath: "/work/demo",
    });
    const other = store.projects.register({
      slug: "other",
      name: "Other project",
      rootPath: "/work/other",
    });
    const grant = store.runtime.acquire({
      pid: process.pid,
      nodeVersion: process.version,
      sqliteVersion: store.info().sqliteVersion,
      ttlMs: 600_000,
    });
    if (!grant.ok) throw new Error("seed could not acquire the runtime lease");
    const epoch = grant.value.epoch;

    // The completed task is the only ready task when it is claimed, so it is the one that runs.
    const completedTaskId = createTask(store, demo.projectId, epoch, SEED_TITLES.completed);
    const claimed = store.tasks.claimNext(epoch);
    if (claimed === undefined || claimed.taskId !== completedTaskId)
      throw new Error("seed claim failed");
    // Every reservation holds a project budget and a task budget, as the broker reserves them.
    const projectBudget = store.budgets.ensure({
      scopeType: "project",
      scopeId: demo.projectId,
      projectId: demo.projectId,
      hardLimit: 10000,
    });
    const taskBudget = store.budgets.ensure({
      scopeType: "task",
      scopeId: claimed.taskId,
      projectId: demo.projectId,
      hardLimit: 1000,
    });
    const reserved = store.budgets.reserve({
      budgetIds: [projectBudget.budgetId, taskBudget.budgetId],
      amount: 100,
      idempotencyKey: `reserve-${claimed.runId}`,
      runId: claimed.runId,
      taskId: claimed.taskId,
      routeId: "route-seed",
    });
    if (!reserved.ok) throw new Error("seed reserve failed");
    store.budgets.commit({
      reservationId: reserved.reservationId,
      usage: { inputTokens: 40, outputTokens: 12 },
      upperBound: 100,
      modelRequested: "fake-model",
      modelServed: "fake-model",
    });
    store.runs.complete({
      runId: claimed.runId,
      outcome: "succeeded",
      result: {
        text: "Logs summarized",
        verification: {
          verified: true,
          checks: [{ kind: "file_exists", ok: true, detail: "summary.md" }],
        },
      },
    });
    store.events.append({
      aggregateType: "task",
      aggregateId: completedTaskId,
      type: "security.pathguard.denied",
      actorKind: "agent",
      actorId: "fake-agent",
      payload: { tool: "write", path: "/etc/hosts" },
      projectId: demo.projectId,
      taskId: completedTaskId,
    });

    // The running task is claimed and never completed; the pending task waits for it.
    const runningTaskId = createTask(store, demo.projectId, epoch, SEED_TITLES.running);
    const claimedRunning = store.tasks.claimNext(epoch);
    if (claimedRunning === undefined || claimedRunning.taskId !== runningTaskId) {
      throw new Error("seed running claim failed");
    }
    const pendingTaskId = createTask(store, demo.projectId, epoch, SEED_TITLES.pending, [
      runningTaskId,
    ]);
    createTask(store, other.projectId, epoch, SEED_TITLES.unrelated);

    return {
      epoch,
      demoId: demo.projectId,
      otherId: other.projectId,
      completedTaskId,
      runningTaskId,
      pendingTaskId,
    };
  } finally {
    store.close();
  }
}
