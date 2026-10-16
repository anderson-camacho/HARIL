import {
  buildAgentSpec,
  checkHandshake,
  completionFor,
  type RunEvent,
  type RunSummary,
  summarizeRun,
} from "@haril/core";
import type {
  AgentHandle,
  AgentOutcome,
  AgentRuntime,
  ClaimedTask,
  Clock,
  Store,
} from "@haril/core/ports";
import { StoreError } from "@haril/state-sqlite";

// Foreground runtime loop (M1-D6): acquire the lease, apply the queue, promote, claim, run, complete,
// until nothing is queued or ready, then release the lease. Tasks run one at a time (concurrency 1 in M1);
// the core scheduling stays sequential so that a later concurrent executor changes only this file.
const LEASE_TTL_MS = 30_000;
const HEARTBEAT_MS = 10_000;

export interface RunLoopOptions {
  readonly store: Store;
  readonly agentRuntime: AgentRuntime;
  readonly clock: Clock;
  readonly pid: number;
  readonly nodeVersion: string;
  readonly onEvent: (event: RunEvent) => void;
}

export type RunLoopResult =
  | { readonly kind: "busy"; readonly pid: number }
  | { readonly kind: "idle"; readonly summary: RunSummary };

export async function runUntilIdle(options: RunLoopOptions): Promise<RunLoopResult> {
  const { store } = options;
  const grant = store.runtime.acquire({
    pid: options.pid,
    nodeVersion: options.nodeVersion,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: LEASE_TTL_MS,
  });
  if (!grant.ok) return { kind: "busy", pid: grant.error.pid };

  const epoch = grant.value.epoch;
  const events: RunEvent[] = [];
  const emit = (event: RunEvent): void => {
    events.push(event);
    options.onEvent(event);
  };
  let cleanExit = false;
  try {
    await drainQueue(options, epoch, emit);
    cleanExit = true;
  } finally {
    releaseLease(store, epoch, cleanExit);
  }
  return { kind: "idle", summary: summarizeRun(events) };
}

async function drainQueue(
  options: RunLoopOptions,
  epoch: number,
  emit: (event: RunEvent) => void,
): Promise<void> {
  const { store } = options;
  for (;;) {
    store.runtime.heartbeat(epoch, LEASE_TTL_MS);
    for (let applied = store.commands.applyNext(epoch); applied !== undefined; ) {
      emit(
        applied.outcome === "applied"
          ? {
              type: "command.applied",
              commandId: applied.commandId,
              commandType: applied.type,
              taskIds: applied.taskIds,
            }
          : {
              type: "command.rejected",
              commandId: applied.commandId,
              commandType: applied.type,
              reason: applied.reason ?? "",
            },
      );
      applied = store.commands.applyNext(epoch);
    }

    for (const blocked of store.tasks.promote().blocked) {
      emit({
        type: "task.blocked",
        taskId: blocked.taskId,
        goal: blocked.goal,
        reason: "dep_failed",
      });
    }

    const claimed = store.tasks.claimNext(epoch);
    if (claimed === undefined) return;
    emit({
      type: "task.claimed",
      taskId: claimed.taskId,
      goal: claimed.goal,
      attempt: claimed.attempt,
      maxAttempts: claimed.maxAttempts,
    });

    const outcome = await executeAttempt(options, epoch, claimed);
    const completion = completionFor(claimed.runId, outcome);
    const result = store.runs.complete(completion);
    const code = completion.outcome === "failed" ? completion.error.code : "";
    if (result.taskState === "completed") {
      emit({ type: "task.completed", taskId: result.taskId, goal: result.goal });
    } else if (result.taskState === "ready") {
      emit({
        type: "task.retrying",
        taskId: result.taskId,
        goal: result.goal,
        nextAttempt: result.attempt + 1,
        maxAttempts: result.maxAttempts,
        code,
      });
    } else {
      emit({ type: "task.failed", taskId: result.taskId, goal: result.goal, code });
    }
  }
}

// The lease is renewed between tasks and while an attempt runs, so a long attempt does not expire it.
async function executeAttempt(
  options: RunLoopOptions,
  epoch: number,
  task: ClaimedTask,
): Promise<AgentOutcome> {
  const renew = setInterval(() => {
    try {
      options.store.runtime.heartbeat(epoch, LEASE_TTL_MS);
    } catch {
      // A fenced epoch is reported by the next turn of the loop, which is the one that must stop.
    }
  }, HEARTBEAT_MS);
  try {
    return await runAttempt(options.agentRuntime, options.clock, task);
  } finally {
    clearInterval(renew);
  }
}

// One attempt: start, handshake (before any prompt), prompt, settle within the timeout, dispose.
async function runAttempt(
  agentRuntime: AgentRuntime,
  clock: Clock,
  task: ClaimedTask,
): Promise<AgentOutcome> {
  const spec = buildAgentSpec(task, { runId: task.runId, attempt: task.attempt });
  const started = await agentRuntime.start(spec);
  if (!started.ok) {
    return { status: "failed", code: started.error.code, message: started.error.message };
  }
  const handle = started.value;
  try {
    const hello = await handle.hello;
    const handshake = checkHandshake(spec.allowedTools, hello.tools);
    if (!handshake.ok) {
      return { status: "failed", code: handshake.error.code, message: handshake.error.message };
    }
    const prompted = await handle.prompt(spec.prompt);
    if (!prompted.ok) {
      return { status: "failed", code: prompted.error.code, message: prompted.error.message };
    }
    return await settleWithin(handle, spec.timeoutMs, clock);
  } finally {
    await handle.dispose();
  }
}

function settleWithin(handle: AgentHandle, timeoutMs: number, clock: Clock): Promise<AgentOutcome> {
  return new Promise((resolve) => {
    const cancel = clock.schedule(timeoutMs, () => resolve({ status: "timed_out" }));
    void handle.settled.then((outcome) => {
      cancel();
      resolve(outcome);
    });
  });
}

function releaseLease(store: Store, epoch: number, cleanExit: boolean): void {
  try {
    store.runtime.release(epoch, cleanExit);
  } catch (error) {
    // Already lost to a takeover: nothing left to release.
    if (!(error instanceof StoreError && error.code === "store.fenced")) throw error;
  }
}
