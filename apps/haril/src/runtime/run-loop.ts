import {
  buildAgentSpec,
  checkHandshake,
  completionFor,
  isRealAgent,
  MAX_INFRA_RESTARTS,
  REAL_AGENT_REFS,
  type RunEvent,
  type RunSummary,
  summarizeRun,
} from "@haril/core";
import type {
  AgentHandle,
  AgentHello,
  AgentOutcome,
  AgentRuntime,
  ClaimedTask,
  Clock,
  RecoveredTask,
  Store,
} from "@haril/core/ports";
import { StoreError } from "@haril/state-sqlite";
import type { RealAgentReadiness, RealAgents } from "./real-agent.js";

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
  // Real agents (M2-T6). Without them, every agent keeps the simulated behaviour of M1.
  readonly realAgents?: Pick<RealAgents, "readiness" | "runtime">;
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
  // Checked once per run: the prerequisites of the real agents do not change while the loop runs.
  const setup = options.realAgents?.readiness();
  try {
    // M1-T7: attempts orphaned by a previous runtime go back to the queue before anything is claimed.
    for (const recovered of store.runtime.reconcile(epoch, MAX_INFRA_RESTARTS)) {
      emit(recoveryEvent(recovered));
    }
    await drainQueue(options, epoch, emit, setup);
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
  setup: RealAgentReadiness | undefined,
): Promise<void> {
  const { store } = options;
  const reported = new Set<string>();
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

    // A real agent without its prerequisites is never claimed: its tasks stay ready and are reported as skipped.
    const missing = setup !== undefined && !setup.ok ? setup : undefined;
    if (missing !== undefined) reportSkipped(store, missing, reported, emit);
    const claimed = store.tasks.claimNext(epoch, missing === undefined ? [] : REAL_AGENT_REFS);
    if (claimed === undefined) return;
    emit({
      type: "task.claimed",
      taskId: claimed.taskId,
      goal: claimed.goal,
      // M1-T8: the number shown is the charged attempts plus one. `attempt` also counts orphan recoveries,
      // which charge nothing, so showing it would print "attempt 2/1" after a crash.
      attempt: claimed.attemptsUsed + 1,
      maxAttempts: claimed.maxAttempts,
    });

    const outcome = await executeAttempt(options, epoch, claimed);
    const completion = completionFor(claimed.runId, outcome);
    const result = store.runs.complete(completion);
    const code = completion.outcome === "failed" ? completion.error.code : "";
    if (result.taskState === "completed") {
      emit({
        type: "task.completed",
        taskId: result.taskId,
        goal: result.goal,
        simulated: outcome.status === "succeeded" && outcome.simulated === true,
      });
    } else if (result.taskState === "ready") {
      emit({
        type: "task.retrying",
        taskId: result.taskId,
        goal: result.goal,
        nextAttempt: result.attemptsUsed + 1,
        maxAttempts: result.maxAttempts,
        code,
      });
    } else {
      emit({ type: "task.failed", taskId: result.taskId, goal: result.goal, code });
    }
  }
}

// Each ready task of a real agent is reported once per run, with what is missing and how to add it.
function reportSkipped(
  store: Store,
  missing: { readonly what: string; readonly fix: string },
  reported: Set<string>,
  emit: (event: RunEvent) => void,
): void {
  for (const task of store.tasks.list()) {
    if (task.state !== "ready" || !isRealAgent(task.agentRef) || reported.has(task.taskId))
      continue;
    reported.add(task.taskId);
    emit({
      type: "task.skipped",
      taskId: task.taskId,
      goal: task.goal,
      what: missing.what,
      fix: missing.fix,
    });
  }
}

function recoveryEvent(recovered: RecoveredTask): RunEvent {
  if (recovered.outcome === "failed") {
    return {
      type: "task.failed",
      taskId: recovered.taskId,
      goal: recovered.goal,
      code: "infra_restarts_exhausted",
    };
  }
  return {
    type: "task.recovered",
    taskId: recovered.taskId,
    goal: recovered.goal,
    infraRestarts: recovered.infraRestarts,
    maxInfraRestarts: recovered.maxInfraRestarts,
  };
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
    return await runAttempt(runtimeFor(options, task), options.clock, task);
  } finally {
    clearInterval(renew);
  }
}

function runtimeFor(options: RunLoopOptions, task: ClaimedTask): AgentRuntime {
  return options.realAgents !== undefined && isRealAgent(task.agentRef)
    ? options.realAgents.runtime
    : options.agentRuntime;
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
    let hello: AgentHello;
    try {
      hello = await handle.hello;
    } catch (error) {
      // The adapter refuses a bad handshake by rejecting `hello` with its HarilError: the attempt fails.
      return failureOf(error);
    }
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

function failureOf(error: unknown): AgentOutcome {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof record.code === "string" ? record.code : "agent.handshake_failed";
  const message = typeof record.message === "string" ? record.message : "the handshake failed";
  return { status: "failed", code, message };
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
