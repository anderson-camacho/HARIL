import type { ControlServer } from "@haril/control";
import {
  buildAgentSpec,
  checkHandshake,
  completionFor,
  evaluateAcceptance,
  isRealAgent,
  MAX_INFRA_RESTARTS,
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
import { applyDecidedApprovals } from "./approvals.js";
import { controlEventOf } from "./control-events.js";
import type { RealAgentReadiness, RealAgents } from "./real-agent.js";
import { createShutdown, RUNTIME_STOP, type Shutdown } from "./shutdown.js";

// Runtime loop (M1-D6, LD-T1): take the lease, apply the queue, run the ready tasks, and wait for new work for
// `idleExitMs` before the lease is released. `idleExitMs` 0 is `haril run`: it stops as soon as nothing is claimable.
// Tasks run one at a time (concurrency 1 in M1). The queue is checked while an attempt runs too, so a runtime.stop
// reaches an attempt in flight within one poll.
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
  // Test seams: the lease TTL and the poll interval default to the production values.
  readonly leaseTtlMs?: number;
  readonly pollMs?: number;
}

export type RunLoopResult =
  | { readonly kind: "busy"; readonly pid: number }
  | { readonly kind: "idle"; readonly summary: RunSummary }
  | { readonly kind: "stopped"; readonly summary: RunSummary };

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
    channelOpen = await openChannel(options.control);
    // M1-T7: attempts orphaned by a previous runtime go back to the queue before anything is claimed.
    for (const recovered of store.runtime.reconcile(epoch, MAX_INFRA_RESTARTS)) {
      emit(recoveryEvent(recovered));
    }
    // serve() releases the lease itself, cleanly, on idle and on a stop.
    const beat = leaseHeartbeat(store, options.clock, epoch, ttlMs);
    const kind = await serve(options, shutdown, { epoch, beat, emit, setup });
    return { kind, summary: summarizeRun(events) };
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
}

// The loop of one lease: drain the queue, claim and run, and wait while the runtime is not idle.
async function serve(
  options: RunLoopOptions,
  shutdown: Shutdown,
  context: ServeContext,
): Promise<"idle" | "stopped"> {
  const { store, clock } = options;
  const { epoch, beat, emit, setup } = context;
  const idleExitMs = options.idleExitMs ?? 0;
  const pollMs = options.pollMs ?? POLL_MS;
  const control = options.control;
  const hasSubscribers = options.hasSubscribers ?? (() => (control?.subscriberCount() ?? 0) > 0);
  // A nudge ends the wait before the poll interval does (LD-T2).
  const onNudge = (listener: () => void): (() => void) =>
    control?.onNudge(listener) ?? (() => undefined);
  const reported = new Set<string>();
  let idleSince = clock.now();
  for (;;) {
    beat();
    // Decisions first: a granted plan is queued in this turn and applied by the queue step right after it (LD-T3).
    const decided = applyDecidedApprovals(store, epoch, emit);
    const applied = decided + applyQueuedCommands(store, epoch, emit, shutdown);
    if (shutdown.requested) {
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

    // A real-agent task that cannot run yet is never claimed (M2-T6, restored by M3-T7): it stays ready and is
    // reported once as skipped, and the claim leaves it out.
    const notRunnable = skipUnrunnableRealTasks(store, setup, reported, emit);
    const globalMissing = setup !== undefined && !setup.ok;
    const claimed = store.tasks.claimNext(epoch, globalMissing ? REAL_AGENT_REFS : [], notRunnable);
    if (claimed !== undefined) {
      await runClaimed(options, shutdown, context, claimed);
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

// Runs one claimed task and records its outcome. A stop that cancels the attempt returns the task to ready uncharged.
async function runClaimed(
  options: RunLoopOptions,
  shutdown: Shutdown,
  context: ServeContext,
  claimed: ClaimedTask,
): Promise<void> {
  const { store } = options;
  const { epoch, beat, emit } = context;
  emit({
    type: "task.claimed",
    taskId: claimed.taskId,
    goal: claimed.goal,
    // M1-T8: the number shown is the charged attempts plus one. `attempt` also counts orphan recoveries,
    // which charge nothing, so showing it would print "attempt 2/1" after a crash.
    attempt: claimed.attemptsUsed + 1,
    maxAttempts: claimed.maxAttempts,
  });

  const outcome = await executeAttempt(options, shutdown, { epoch, beat }, emit, claimed);
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
    emit({ type: "task.failed", taskId: result.taskId, goal: result.goal, code });
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

// While an attempt runs, the lease is renewed and the queue is checked each poll, so a long attempt keeps its lease and
// a runtime.stop reaches it. The stop itself is handled by runAttempt through the shutdown control.
async function executeAttempt(
  options: RunLoopOptions,
  shutdown: Shutdown,
  lease: { readonly epoch: number; readonly beat: () => void },
  emit: (event: RunEvent) => void,
  task: ClaimedTask,
): Promise<AgentOutcome> {
  const pollMs = options.pollMs ?? POLL_MS;
  const tick = setInterval(() => {
    try {
      lease.beat();
      applyQueuedCommands(options.store, lease.epoch, emit, shutdown);
    } catch {
      // A fenced epoch is reported by the next turn of the loop, which is the one that must stop.
    }
  }, pollMs);
  try {
    return await runAttempt(runtimeFor(options, task), options.clock, task, shutdown);
  } finally {
    clearInterval(tick);
  }
}

function runtimeFor(options: RunLoopOptions, task: ClaimedTask): AgentRuntime {
  return options.realAgents !== undefined && isRealAgent(task.agentRef)
    ? options.realAgents.runtime
    : options.agentRuntime;
}

// One attempt: start, handshake (before any prompt), prompt, settle within the timeout, dispose. A shutdown aborts the
// run in flight; the handle settles it as aborted, and the race with `settled` keeps a handshake that never answers
// from holding the stop.
async function runAttempt(
  agentRuntime: AgentRuntime,
  clock: Clock,
  task: ClaimedTask,
  shutdown: Shutdown,
): Promise<AgentOutcome> {
  const spec = buildAgentSpec(task, { runId: task.runId, attempt: task.attempt });
  const started = await agentRuntime.start(spec);
  if (!started.ok) {
    return { status: "failed", code: started.error.code, message: started.error.message };
  }
  const handle = started.value;
  // A failed abort call is covered by `settled` and by dispose below.
  const stopping = shutdown.onRequest(() => {
    handle.abort().catch(() => undefined);
  });
  try {
    return await Promise.race([drive(handle, spec, clock), handle.settled]);
  } finally {
    stopping();
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

function releaseLease(store: Store, epoch: number, cleanExit: boolean): void {
  try {
    store.runtime.release(epoch, cleanExit);
  } catch (error) {
    // Already lost to a takeover, or released by serve(): nothing left to release.
    if (!(error instanceof StoreError && error.code === "store.fenced")) throw error;
  }
}
