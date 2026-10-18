import type { ControlServer } from "@haril/control";
import {
  buildAgentSpec,
  checkHandshake,
  completionFor,
  createMemoryService,
  evaluateAcceptance,
  isRealAgent,
  MAX_INFRA_RESTARTS,
  type MemoryService,
  type MemoryTick,
  planAttemptOutcome,
  REAL_AGENT_REFS,
  type RunEvent,
  type RunSummary,
  summarizeRun,
  type Verification,
} from "@haril/core";
import type {
  AgentHandle,
  AgentHello,
  AgentOutcome,
  AgentRuntime,
  AgentSpec,
  ClaimedTask,
  Clock,
  RecoveredTask,
  Store,
} from "@haril/core/ports";
import { StoreError } from "@haril/state-sqlite";
import { modelProblemOf } from "../providers.js";
import { projectFileReader, verificationPayload } from "./acceptance.js";
import { applyDecidedApprovals, denyPlansOfFailedTask } from "./approvals.js";
import { controlEventOf } from "./control-events.js";
import type { DelegationTools, TurnWindowReport } from "./delegation-tools.js";
import {
  backoffJitter,
  defaultRuntimeMemory,
  type MemoryLeft,
  memoryLeftOf,
  type RuntimeMemory,
} from "./memory.js";
import type { PlanAttemptReport, PlanProposals } from "./plan-proposals.js";
import type { RealAgentReadiness, RealAgents } from "./real-agent.js";
import { createShutdown, RUNTIME_STOP, type Shutdown } from "./shutdown.js";
import { claimWorkflowTurns, settleWorkflows } from "./workflow-scheduler.js";
import { summarizeWorkflows, type WorkflowTally } from "./workflow-summary.js";
import { buildTurnInput, commitWorkflowAttempt } from "./workflow-turns.js";
import { type DelegationOptions, WorkflowView, workflowSettings } from "./workflow-view.js";

// Runtime loop (M1-D6, LD-T1, phase F2): take the lease, apply the queue, run the ready tasks, and wait for new work for
// `idleExitMs` before the lease is released. `idleExitMs` 0 is `haril run`: it stops as soon as nothing is claimable.
// Several attempts are in flight at once (docs/modos-y-delegacion.md 3.9): the loop keeps a registry of live attempts,
// wakes when one settles, at each poll and on a nudge, and closes each attempt in the turn after it settled. Standalone
// tasks keep their lane of one attempt at a time, exactly as before; the turns of running workflows start as
// selectClaims allows (the workflow scheduler), each claimed atomically under the lease's epoch. Node runs one thread,
// so the store's writes stay sequential: the concurrency is the agents' processes. The queue is checked while attempts
// run, so a runtime.stop reaches them within one poll.
const LEASE_TTL_MS = 30_000;
// The runtime checks its own queue at this interval. The no-polling rule (H6) binds clients, not the runtime.
const POLL_MS = 1_000;
// The lease is renewed at this interval, not at every poll: a third of the TTL, and ten times fewer writes than polls,
// so an idle runtime does not compete for the write lock with the CLI and the shell every second.
const HEARTBEAT_MS = 10_000;

// Renews the lease when its interval has passed since the last renewal (the first call always renews). The interval
// is HEARTBEAT_MS, or a third of the TTL when the TTL is shorter (tests), so the lease never lapses between renewals.
function leaseHeartbeat(store: Store, clock: Clock, epoch: number, ttlMs: number): () => void {
  const intervalMs = Math.min(HEARTBEAT_MS, Math.floor(ttlMs / 3));
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const now = clock.now();
    if (now - last < intervalMs) return;
    store.runtime.heartbeat(epoch, ttlMs);
    last = now;
  };
}

export interface RunLoopOptions {
  readonly store: Store;
  readonly agentRuntime: AgentRuntime;
  readonly clock: Clock;
  readonly pid: number;
  readonly nodeVersion: string;
  readonly onEvent: (event: RunEvent) => void;
  // Real agents (M2-T6). Without them, every agent keeps the simulated behaviour of M1.
  readonly realAgents?: Pick<RealAgents, "readiness" | "runtime">;
  // The host handler of haril_propose_plan (LD-T4) that the agent runtimes were given. The loop opens it for each plan
  // attempt and reports its proposals. Without it, no plan attempt can show a proposal, so every one fails.
  readonly planProposals?: PlanProposals;
  // ARCH 4.2: how long the runtime waits after its last activity before it exits. Defaults to 0 (`haril run`).
  readonly idleExitMs?: number;
  // Clients subscribed to this runtime (LD-T2, ARCH 4.2). Defaults to the subscribers of the control channel.
  readonly hasSubscribers?: () => boolean;
  // The control channel (LD-T2, ARCH 4.3): opened once the lease is taken and closed before the lease is released.
  // Its clients only wake the loop, and a nudge makes it check the queue at once. Without it, the loop only polls.
  readonly control?: Pick<
    ControlServer,
    "start" | "close" | "notify" | "subscriberCount" | "onNudge"
  >;
  // The ordered-stop control (ARCH 4.2). Defaults to a control nobody requests.
  readonly shutdown?: Shutdown;
  // The memory provider of this runtime (MC-T4). Defaults to the Null provider: no memory can be configured yet.
  readonly memory?: RuntimeMemory;
  // haril shell started this runtime (LD-T6, ADR-0022): the start is recorded as runtime.started_by_shell, with the pid
  // and the epoch, once the lease is held.
  readonly startedByShell?: boolean;
  // The host handler of the delegation tools (phase F2) that the agent runtimes were given. The loop opens a window for
  // each workflow turn and applies its decided call when the turn ends. Without it, a workflow turn hears no call.
  readonly delegationTools?: DelegationTools;
  // The limits and models of workflows (phase F2; haril.json's delegation section arrives in F7).
  readonly delegation?: DelegationOptions;
  // Test seams: the lease TTL and the poll interval default to the production values.
  readonly leaseTtlMs?: number;
  readonly pollMs?: number;
}

// memory: what a runtime that exits leaves for memory (MC-T4 fix): the tasks that wait for it and the queued writes,
// which the next runtime resumes. memoryLeftLine says it. workflows: the workflow turns it closed and how the workflows
// it moved ended (phase F2b).
export type RunLoopResult =
  | { readonly kind: "busy"; readonly pid: number }
  | {
      readonly kind: "idle" | "stopped";
      readonly summary: RunSummary;
      readonly workflows: WorkflowTally;
      readonly memory: MemoryLeft;
    };

export async function runUntilIdle(options: RunLoopOptions): Promise<RunLoopResult> {
  const { store } = options;
  const shutdown = options.shutdown ?? createShutdown();
  const ttlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
  const grant = store.runtime.acquire({
    pid: options.pid,
    nodeVersion: options.nodeVersion,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs,
  });
  if (!grant.ok) return { kind: "busy", pid: grant.error.pid };

  const epoch = grant.value.epoch;
  const events: RunEvent[] = [];
  const emit = (event: RunEvent): void => {
    events.push(event);
    options.onEvent(event);
    // Every event reaches the subscribers as its type and task id only, followed by a wake (LD-T2).
    options.control?.notify(controlEventOf(event));
  };
  // Checked once per run: the prerequisites of the real agents do not change while the loop runs.
  const setup = options.realAgents?.readiness();
  const stopNotice = shutdown.onRequest((reason) => emit({ type: "runtime.stopping", reason }));
  let channelOpen = false;
  try {
    if (options.startedByShell === true) {
      recordStartedByShell(store, grant.value.instanceId, options.pid, epoch);
    }
    channelOpen = await openChannel(options.control);
    // M1-T7: attempts orphaned by a previous runtime go back to the queue before anything is claimed.
    for (const recovered of store.runtime.reconcile(epoch, MAX_INFRA_RESTARTS)) {
      emit(recoveryEvent(recovered));
      if (recovered.outcome === "failed") {
        denyPlansOfFailedTask(store, recovered.taskId, "infra_restarts_exhausted");
      }
    }
    // The lease heartbeat runs before memory starts: memory calls it before each provider call (MC-T4 fix).
    const beat = leaseHeartbeat(store, options.clock, epoch, ttlMs);
    beat();
    // MC-T4, ARCH 7.5 and R-O7: the last step of the start is memory. The outbox rows a previous runtime left sending go
    // back to pending, the provider is checked and recorded for haril memory status, and the outbox drains if it is up.
    const runtimeMemory = options.memory ?? defaultRuntimeMemory(options.clock);
    const memory = createMemoryService({
      store,
      provider: runtimeMemory.provider,
      ids: runtimeMemory.ids,
      hasher: runtimeMemory.hasher,
      clock: options.clock,
      epoch,
      jitter: backoffJitter,
      heartbeat: beat,
    });
    emitMemoryTick(await memory.start(), emit);
    // serve() releases the lease itself, cleanly, on idle and on a stop.
    const kind = await serve(options, shutdown, { epoch, beat, emit, setup, memory });
    return {
      kind,
      summary: summarizeRun(events),
      workflows: summarizeWorkflows(events),
      memory: memoryLeftOf(store, memory.state),
    };
  } finally {
    stopNotice();
    // The channel closes before the lease is released (ARCH 4.3). Its files are removed only while they still belong to
    // this runtime, so a successor that took the lease in the meantime keeps its own.
    if (channelOpen) await options.control?.close();
    // An exception leaves the lease to be released as a crash would not be: this release is unclean. After serve()
    // released it, the epoch is no longer active and the store refuses the release, which is expected.
    releaseLease(store, epoch, false);
  }
}

// A channel that cannot open (its endpoint is taken, for instance) leaves the runtime working: the queue is still
// polled, and only the wake-ups are lost. Returns whether the channel is open.
async function openChannel(control: RunLoopOptions["control"]): Promise<boolean> {
  if (control === undefined) return false;
  try {
    await control.start();
    return true;
  } catch {
    return false;
  }
}

interface ServeContext {
  readonly epoch: number;
  // Renews the lease when due (HEARTBEAT_MS); called at every poll and every attempt tick.
  readonly beat: () => void;
  readonly emit: (event: RunEvent) => void;
  readonly setup: RealAgentReadiness | undefined;
  readonly memory: MemoryService;
}

// One attempt in flight (3.9: the registry runId -> attempt). `abort` reaches its agent once it started; `settled`
// holds its outcome once the agent run ended, and the loop closes it in its next turn.
interface LiveAttempt {
  readonly runId: string;
  readonly claimed: ClaimedTask;
  readonly workflow: LiveWorkflowTurn | null;
  abort: () => void;
  settled: AgentOutcome | null;
}

interface LiveWorkflowTurn {
  readonly workflowId: string;
  readonly startedAt: number;
  readonly close: () => TurnWindowReport;
}

// The loop of one lease: drain the queue, claim and start, close what settled, and wait while the runtime is not idle.
async function serve(
  options: RunLoopOptions,
  shutdown: Shutdown,
  context: ServeContext,
): Promise<"idle" | "stopped"> {
  const { store, clock } = options;
  const { epoch, beat, emit, setup, memory } = context;
  const idleExitMs = options.idleExitMs ?? 0;
  const pollMs = options.pollMs ?? POLL_MS;
  const control = options.control;
  const hasSubscribers = options.hasSubscribers ?? (() => (control?.subscriberCount() ?? 0) > 0);
  // A nudge ends the wait before the poll interval does (LD-T2).
  const onNudge = (listener: () => void): (() => void) =>
    control?.onNudge(listener) ?? (() => undefined);
  const reported = new Set<string>();
  const live = new Map<string, LiveAttempt>();
  const done: LiveAttempt[] = [];
  let wake: (() => void) | null = null;
  const settle = (attempt: LiveAttempt, outcome: AgentOutcome): void => {
    attempt.settled = outcome;
    done.push(attempt);
    const waiting = wake;
    wake = null;
    waiting?.();
  };
  const launch = (attempt: LiveAttempt, run: (attempt: LiveAttempt) => Promise<AgentOutcome>) => {
    live.set(attempt.runId, attempt);
    void run(attempt).then(
      (outcome) => settle(attempt, outcome),
      (error: unknown) =>
        settle(attempt, {
          status: "failed",
          code: "runtime.attempt_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
    );
  };
  let idleSince = clock.now();
  for (;;) {
    beat();
    // The attempts that settled since the last turn close first, oldest first, so what they free or create is seen below.
    for (let attempt = done.shift(); attempt !== undefined; attempt = done.shift()) {
      live.delete(attempt.runId);
      if (attempt.workflow === null) closeStandalone(options, shutdown, context, attempt);
      else closeWorkflowTurn(options, shutdown, context, attempt, attempt.workflow);
    }
    // The standalone lane runs one attempt at a time, as before: decisions and memory wait while it is busy.
    const standaloneBusy = [...live.values()].some((attempt) => attempt.workflow === null);
    // Decisions first: a granted plan is queued in this turn and applied by the queue step right after it (LD-T3).
    const decided = standaloneBusy ? 0 : applyDecidedApprovals(store, epoch, emit);
    const applied = decided + applyQueuedCommands(store, epoch, emit, shutdown);
    if (shutdown.requested) {
      // ARCH 4.2: each attempt in flight was aborted when the stop was requested; the lease goes once they all closed.
      if (live.size > 0) {
        await waitForAttempts(clock, pollMs, (resolve) => {
          wake = done.length > 0 ? null : resolve;
          if (done.length > 0) resolve();
        });
        continue;
      }
      store.runtime.release(epoch, true);
      return "stopped";
    }

    for (const blocked of store.tasks.promote().blocked) {
      emit({
        type: "task.blocked",
        taskId: blocked.taskId,
        goal: blocked.goal,
        reason: "dep_failed",
      });
    }
    if (!standaloneBusy) {
      // Before the claim: while memory is down, a task that requires it waits as blocked(memory_unavailable) and the
      // others run (MEM-08); the turn also checks the provider and drains the outbox when either is due.
      emitMemoryTick(await memory.tick(), emit);
    }
    for (const ended of settleWorkflows(store, epoch, clock, options.delegation)) {
      emit({ type: "workflow.state", ...ended });
    }

    // A real-agent task that cannot run yet is never claimed (M2-T6, restored by M3-T7): it stays ready and is
    // reported once as skipped, and the claim leaves it out.
    const notRunnable = skipUnrunnableRealTasks(store, setup, reported, emit);
    if (!standaloneBusy) {
      const globalMissing = setup !== undefined && !setup.ok;
      const claimed = store.tasks.claimNext(
        epoch,
        globalMissing ? REAL_AGENT_REFS : [],
        notRunnable,
        { standaloneOnly: true },
      );
      if (claimed !== undefined) {
        launch(newAttempt(claimed, null), (attempt) =>
          startStandalone(options, shutdown, context, attempt),
        );
      }
    }
    for (const turn of claimWorkflowTurns(store, epoch, options.delegation, new Set(notRunnable))) {
      const window = startWorkflowWindow(options, turn.claimed, turn.workflowId);
      launch(newAttempt(turn.claimed, window), (attempt) =>
        startWorkflowTurn(options, shutdown, context, attempt, turn.workflowId),
      );
    }

    if (live.size > 0) {
      // Wait for an attempt to settle, a poll, a nudge or a stop, whichever comes first.
      if (done.length === 0) {
        await waitForWake(clock, pollMs, shutdown, onNudge, (resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      idleSince = clock.now();
      continue;
    }

    if (applied > 0 || hasSubscribers()) idleSince = clock.now();
    if (clock.now() - idleSince >= idleExitMs) {
      // The queue check and the release are one transaction (ARCH 4.2). A command that arrived meanwhile keeps the
      // lease, and the next turn applies it.
      if (store.runtime.releaseIfIdle(epoch)) return "idle";
      continue;
    }
    await sleepUnlessWoken(clock, pollMs, shutdown, onNudge);
  }
}

function newAttempt(claimed: ClaimedTask, workflow: LiveWorkflowTurn | null): LiveAttempt {
  return { runId: claimed.runId, claimed, workflow, abort: () => undefined, settled: null };
}

// The tasks memory moved: a blocked one is reported like any blocked task; a released one is ready again.
function emitMemoryTick(tick: MemoryTick, emit: (event: RunEvent) => void): void {
  for (const blocked of tick.blocked) {
    emit({
      type: "task.blocked",
      taskId: blocked.taskId,
      goal: blocked.goal,
      reason: "memory_unavailable",
    });
  }
}

function claimedEvent(claimed: ClaimedTask): RunEvent {
  return {
    type: "task.claimed",
    taskId: claimed.taskId,
    goal: claimed.goal,
    // M1-T8: the number shown is the charged attempts plus one. `attempt` also counts orphan recoveries,
    // which charge nothing, so showing it would print "attempt 2/1" after a crash.
    attempt: claimed.attemptsUsed + 1,
    maxAttempts: claimed.maxAttempts,
  };
}

// Starts one standalone task: its claim is told, and its attempt runs (a plan attempt inside its proposal window).
function startStandalone(
  options: RunLoopOptions,
  shutdown: Shutdown,
  context: ServeContext,
  attempt: LiveAttempt,
): Promise<AgentOutcome> {
  context.emit(claimedEvent(attempt.claimed));
  return executePlannedAttempt(options, shutdown, context.emit, attempt);
}

// Records the outcome of a standalone attempt. A stop that cancels the attempt returns the task to ready uncharged.
function closeStandalone(
  options: RunLoopOptions,
  shutdown: Shutdown,
  context: ServeContext,
  attempt: LiveAttempt,
): void {
  const { store } = options;
  const { emit } = context;
  const claimed = attempt.claimed;
  const outcome = attempt.settled as AgentOutcome;
  if (shutdown.requested && outcome.status !== "succeeded") {
    // ARCH 4.2 step 3: the run ends as cancelled and its task returns to ready; no attempt and no infra restart.
    const returned = store.runs.cancel(claimed.runId, "shutdown");
    emit({ type: "task.returned", taskId: returned.taskId, goal: returned.goal });
    return;
  }

  // M3-D7: the host checks the acceptance of a succeeded attempt; the agent never judges its own work.
  const verification =
    outcome.status === "succeeded" ? verifyAttempt(store, claimed, outcome.summary) : undefined;
  if (verification !== undefined) recordVerification(store, claimed, verification);
  const completion = completionFor(claimed.runId, outcome, verification);
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
    emit({
      type: "task.failed",
      taskId: result.taskId,
      goal: result.goal,
      code,
      ...(result.failureReason === "verification_exhausted"
        ? { reason: result.failureReason, verifyRetries: result.verifyRetries }
        : {}),
    });
    // LD-T4: a plan task that failed for good leaves no plan to approve. Between retries the plan stays requested, since
    // the next attempt proposes it again and finds the same approval.
    denyPlansOfFailedTask(store, result.taskId, code);
  }
}

// The window of a workflow turn's tool calls (phase F2), opened at its claim.
function startWorkflowWindow(
  options: RunLoopOptions,
  claimed: ClaimedTask,
  workflowId: string,
): LiveWorkflowTurn {
  const close = options.delegationTools?.open({
    projectId: claimed.projectId,
    taskId: claimed.taskId,
    runId: claimed.runId,
    workflowId,
  });
  return {
    workflowId,
    startedAt: options.clock.now(),
    close: close ?? (() => ({ action: null, refusals: [] })),
  };
}

// Starts one workflow turn: its input is built from the store, rendered into its prompt and handed to its agent.
async function startWorkflowTurn(
  options: RunLoopOptions,
  shutdown: Shutdown,
  context: ServeContext,
  attempt: LiveAttempt,
  workflowId: string,
): Promise<AgentOutcome> {
  const { store, clock } = options;
  const claimed = attempt.claimed;
  context.emit(claimedEvent(claimed));
  const view = WorkflowView.load(store, workflowId);
  const task = view?.task(claimed.taskId);
  if (view === undefined || task === undefined) {
    return {
      status: "failed",
      code: "delegation.input_failed",
      message: `task ${claimed.taskId} is not a turn of workflow ${workflowId}`,
    };
  }
  const settings = workflowSettings(view.workflow, options.delegation);
  const delegation = buildTurnInput(view, task, settings, clock.now());
  const spec = buildAgentSpec(
    { ...claimed, delegation },
    { runId: claimed.runId, attempt: claimed.attempt },
  );
  return await runAttempt(runtimeFor(options, claimed), clock, spec, shutdown, attempt);
}

// Closes a workflow turn: its decided call, its run and its usage row in one transaction (workflow-turns.ts). A stop that
// cancels the attempt returns the turn to ready uncharged, and its call is dropped: the rerun makes it again.
function closeWorkflowTurn(
  options: RunLoopOptions,
  shutdown: Shutdown,
  context: ServeContext,
  attempt: LiveAttempt,
  turn: LiveWorkflowTurn,
): void {
  const { store, clock } = options;
  const { emit, epoch } = context;
  const outcome = attempt.settled as AgentOutcome;
  const report = turn.close();
  const claimed = attempt.claimed;
  if (shutdown.requested && outcome.status !== "succeeded") {
    const returned = store.runs.cancel(claimed.runId, "shutdown");
    emit({ type: "task.returned", taskId: returned.taskId, goal: returned.goal });
    return;
  }
  const before = store.workflows.get(turn.workflowId)?.state;
  const task = store.workflows.tasks(turn.workflowId).find((row) => row.taskId === claimed.taskId);
  let taskState: "completed" | "failed";
  let outcomeText: string;
  try {
    const result = commitWorkflowAttempt(
      {
        store,
        epoch,
        clock,
        ...(options.delegation === undefined ? {} : { options: options.delegation }),
      },
      { claimed, workflowId: turn.workflowId, startedAt: turn.startedAt },
      outcome,
      report,
    );
    taskState = result.taskState;
    outcomeText = result.outcome;
  } catch (error) {
    // Nothing of the commit was written (one transaction): the run closes as failed on its own, and the workflow
    // continues as after any failed turn.
    if (error instanceof StoreError && error.code === "store.fenced") throw error;
    const message = error instanceof Error ? error.message : String(error);
    store.runs.complete({
      runId: claimed.runId,
      outcome: "failed",
      error: { code: "delegation.commit_failed", message },
      endCause: "exit",
    });
    taskState = "failed";
    outcomeText = `commit_failed: ${message}`;
  }
  emit({
    type: "workflow.turn",
    taskId: claimed.taskId,
    goal: claimed.goal,
    role: task?.role ?? "executor",
    taskState,
    outcome: outcomeText,
  });
  const after = store.workflows.get(turn.workflowId);
  if (after !== undefined && after.state !== before && after.state !== "running") {
    emit({
      type: "workflow.state",
      workflowId: after.workflowId,
      state: after.state,
      reason: after.stopReason,
    });
  }
}

// Applies every queued command, oldest first. A runtime.stop that applies requests the ordered stop (ARCH 4.2).
function applyQueuedCommands(
  store: Store,
  epoch: number,
  emit: (event: RunEvent) => void,
  shutdown: Shutdown,
): number {
  let applied = 0;
  for (let next = store.commands.applyNext(epoch); next !== undefined; ) {
    applied += 1;
    emit(
      next.outcome === "applied"
        ? {
            type: "command.applied",
            commandId: next.commandId,
            commandType: next.type,
            taskIds: next.taskIds,
          }
        : {
            type: "command.rejected",
            commandId: next.commandId,
            commandType: next.type,
            reason: next.reason ?? "",
          },
    );
    if (next.type === RUNTIME_STOP && next.outcome === "applied") shutdown.request("command");
    next = store.commands.applyNext(epoch);
  }
  return applied;
}

function verifyAttempt(store: Store, claimed: ClaimedTask, outputText: string): Verification {
  return evaluateAcceptance(claimed.acceptance, {
    readFile: projectFileReader(store, claimed.projectId),
    outputText,
  });
}

// A task without checks leaves no verify event: its unverified completion is in the result (M3-D7).
function recordVerification(store: Store, claimed: ClaimedTask, verification: Verification): void {
  if (verification.checks.length === 0) return;
  store.events.append({
    aggregateType: "task",
    aggregateId: claimed.taskId,
    type: verification.verified ? "verify.passed" : "verify.failed",
    actorKind: "system",
    actorId: "runtime",
    payload: { attempt: claimed.attempt, ...verificationPayload(verification) },
    projectId: claimed.projectId,
    taskId: claimed.taskId,
    runId: claimed.runId,
  });
}

// The ready tasks of a real agent that cannot run now: a setup problem applies to all of them, and a task's own
// model is checked against the providers (M3-T7). Each is reported once per run with what is missing and how to add
// it. A bare model id needs the live catalogs, so it is resolved at start, not here.
function skipUnrunnableRealTasks(
  store: Store,
  setup: RealAgentReadiness | undefined,
  reported: Set<string>,
  emit: (event: RunEvent) => void,
): string[] {
  if (setup === undefined) return [];
  const excluded: string[] = [];
  for (const task of store.tasks.list()) {
    if (task.state !== "ready" || !isRealAgent(task.agentRef)) continue;
    const problem = setup.ok
      ? modelProblemOf(store.tasks.get(task.taskId)?.model ?? null, setup.providers)
      : setup;
    if (problem === undefined) continue;
    excluded.push(task.taskId);
    if (reported.has(task.taskId)) continue;
    reported.add(task.taskId);
    emit({
      type: "task.skipped",
      taskId: task.taskId,
      goal: task.goal,
      what: problem.what,
      fix: problem.fix,
    });
  }
  return excluded;
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

// A plan attempt (LD-T4) runs inside a proposal window: each proposal it records is told to subscribers at once, and a
// success that recorded none fails as plan.not_proposed. The window carries the task's model, which the plan's tasks
// inherit once it is granted (LD-T7a). Every other attempt runs as it is.
async function executePlannedAttempt(
  options: RunLoopOptions,
  shutdown: Shutdown,
  emit: (event: RunEvent) => void,
  attempt: LiveAttempt,
): Promise<AgentOutcome> {
  const task = attempt.claimed;
  const spec = buildAgentSpec(task, { runId: task.runId, attempt: task.attempt });
  const runtime = runtimeFor(options, task);
  if (task.kind !== "plan")
    return await runAttempt(runtime, options.clock, spec, shutdown, attempt);
  const close = options.planProposals?.open(
    { projectId: task.projectId, taskId: task.taskId, runId: task.runId, model: task.model },
    (proposal) => emit({ type: "approval.requested", ...proposal }),
  );
  let report: PlanAttemptReport = { proposed: false };
  let outcome: AgentOutcome;
  try {
    outcome = await runAttempt(runtime, options.clock, spec, shutdown, attempt);
  } finally {
    report = close?.() ?? report;
  }
  return planAttemptOutcome(task.kind, outcome, report.proposed, report.lastRefusal);
}

function runtimeFor(options: RunLoopOptions, task: ClaimedTask): AgentRuntime {
  return options.realAgents !== undefined && isRealAgent(task.agentRef)
    ? options.realAgents.runtime
    : options.agentRuntime;
}

// One attempt: start, handshake (before any prompt), prompt, settle within the timeout, dispose. A shutdown aborts the
// run in flight; the handle settles it as aborted, and the race with `settled` keeps a handshake that never answers
// from holding the stop. While it runs, the registry's entry can abort it (3.9).
async function runAttempt(
  agentRuntime: AgentRuntime,
  clock: Clock,
  spec: AgentSpec,
  shutdown: Shutdown,
  attempt: LiveAttempt,
): Promise<AgentOutcome> {
  const started = await agentRuntime.start(spec);
  if (!started.ok) {
    return { status: "failed", code: started.error.code, message: started.error.message };
  }
  const handle = started.value;
  // A failed abort call is covered by `settled` and by dispose below.
  attempt.abort = () => {
    handle.abort().catch(() => undefined);
  };
  const stopping = shutdown.onRequest(() => attempt.abort());
  try {
    return await Promise.race([drive(handle, spec, clock), handle.settled]);
  } finally {
    stopping();
    attempt.abort = () => undefined;
    await handle.dispose();
  }
}

async function drive(handle: AgentHandle, spec: AgentSpec, clock: Clock): Promise<AgentOutcome> {
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

// Waits `ms` of clock time, or until a stop is requested, or until a nudge arrives, whichever comes first (LD-T2).
// Every listener is removed when the wait ends, so the loop does not accumulate them.
function sleepUnlessWoken(
  clock: Clock,
  ms: number,
  shutdown: Shutdown,
  onNudge: (listener: () => void) => () => void,
): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribeStop: () => void = () => undefined;
    let unsubscribeNudge: () => void = () => undefined;
    const finish = (): void => {
      cancel();
      unsubscribeStop();
      unsubscribeNudge();
      resolve();
    };
    const cancel = clock.schedule(ms, finish);
    unsubscribeStop = shutdown.onRequest(finish);
    unsubscribeNudge = onNudge(finish);
  });
}

// Waits like sleepUnlessWoken, and also until an attempt in flight settles: `register` hands the loop the function that
// ends the wait.
function waitForWake(
  clock: Clock,
  ms: number,
  shutdown: Shutdown,
  onNudge: (listener: () => void) => () => void,
  register: (resolve: () => void) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribeStop: () => void = () => undefined;
    let unsubscribeNudge: () => void = () => undefined;
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      cancel();
      unsubscribeStop();
      unsubscribeNudge();
      resolve();
    };
    const cancel = clock.schedule(ms, finish);
    unsubscribeStop = shutdown.onRequest(finish);
    unsubscribeNudge = onNudge(finish);
    register(finish);
  });
}

// While a stop waits for the attempts it aborted: until one settles, or the poll interval passes.
function waitForAttempts(
  clock: Clock,
  ms: number,
  register: (resolve: () => void) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      cancel();
      resolve();
    };
    const cancel = clock.schedule(ms, finish);
    register(finish);
  });
}

// An audit event of the lease just taken: the shell may only start a runtime this way, and the event says it did.
function recordStartedByShell(store: Store, instanceId: string, pid: number, epoch: number): void {
  store.events.append({
    aggregateType: "runtime",
    aggregateId: instanceId,
    type: "runtime.started_by_shell",
    actorKind: "system",
    actorId: "runtime",
    audit: true,
    payload: { pid, epoch },
  });
}

function releaseLease(store: Store, epoch: number, cleanExit: boolean): void {
  try {
    store.runtime.release(epoch, cleanExit);
  } catch (error) {
    // Already lost to a takeover, or released by serve(): nothing left to release.
    if (!(error instanceof StoreError && error.code === "store.fenced")) throw error;
  }
}
