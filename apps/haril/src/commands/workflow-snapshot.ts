import type {
  WaitExplanation,
  WorkflowGit,
  WorkflowNode,
  WorkflowSnapshot,
} from "@haril/contracts";
import {
  type CapacityWait,
  explainWait,
  explainWorkflow,
  visibleText,
  type WaitSettled,
} from "@haril/core";
import type {
  AuditRecord,
  Store,
  UsageRecord,
  WorkflowRecord,
  WorkflowTaskRecord,
} from "@haril/core/ports";

// A workflow as WorkflowSnapshot v1 (ADR-0021), built from the store, and its text tree. One node per thread (an agent
// across its turns): its state is the state of its latest turn, read with its audits (an executor whose latest turn was
// rejected and escalated waits for its delegator). Labels follow creation order: o1, d1.., e1.., aN for the auditor of
// eN, fa for the final auditor. haril workflow demo prints it; haril workflow show and watch print it (phase F5b).

export interface ThreadView {
  readonly threadId: string;
  readonly code: string;
  readonly label: string;
  readonly role: WorkflowTaskRecord["role"];
  readonly layer: 1 | 2 | 3;
  readonly parentThreadId: string | null;
  readonly auditedThreadId: string | null;
  // In creation order.
  readonly turns: readonly WorkflowTaskRecord[];
}

const LIVE_TURN = new Set<WorkflowTaskRecord["state"]>(["pending", "ready", "running"]);

const ROLE_LABEL: Readonly<Record<WorkflowTaskRecord["role"], string>> = {
  orchestrator: "Orchestrator",
  delegator: "Delegator",
  executor: "Executor",
  auditor: "Auditor",
};

// The threads of a workflow in the order their first turn was created, with their codes and labels.
export function threadsOf(tasks: readonly WorkflowTaskRecord[]): ThreadView[] {
  const byTask = new Map(tasks.map((task) => [task.taskId, task]));
  const groups = new Map<string, WorkflowTaskRecord[]>();
  for (const task of [...tasks].sort((a, b) => a.createdSeq - b.createdSeq)) {
    const list = groups.get(task.threadId) ?? [];
    list.push(task);
    groups.set(task.threadId, list);
  }
  const counters = { orchestrator: 0, delegator: 0, executor: 0, final: 0 };
  const codeOf = new Map<string, string>();
  const threads: ThreadView[] = [];
  for (const [threadId, turns] of groups) {
    const first = turns[0] as WorkflowTaskRecord;
    const parent = first.parentTaskId === null ? undefined : byTask.get(first.parentTaskId);
    const parentThreadId = parent?.threadId ?? null;
    const subject = first.auditedTaskId === null ? undefined : byTask.get(first.auditedTaskId);
    const auditedThreadId = subject?.threadId ?? null;
    let code: string;
    let label: string;
    if (first.role === "auditor") {
      const subjectCode = auditedThreadId === null ? undefined : codeOf.get(auditedThreadId);
      if (subject?.role === "executor" && subjectCode !== undefined) {
        code = `a${subjectCode.slice(1)}`;
        label = `Auditor of ${subjectCode}`;
      } else {
        counters.final += 1;
        code = counters.final === 1 ? "fa" : `fa${counters.final}`;
        label = "Final auditor";
      }
    } else {
      counters[first.role] += 1;
      code = `${first.role.charAt(0)}${counters[first.role]}`;
      label = `${ROLE_LABEL[first.role]} ${counters[first.role]}`;
    }
    codeOf.set(threadId, code);
    threads.push({
      threadId,
      code,
      label,
      role: first.role,
      layer: first.layer,
      parentThreadId,
      auditedThreadId,
      turns,
    });
  }
  return threads;
}

export interface SnapshotOptions {
  readonly now: number;
  // The quota of a model's account, when known (null says "sin dato").
  readonly quotaOf?: (
    model: string,
  ) => { window5hPct: number | null; weeklyPct: number | null } | null;
  readonly quota?: WorkflowSnapshot["quota"];
  // How many tokens a real run's context holds (its Pi session, phase F7); null when unknown.
  readonly contextUsedOf?: (runId: string) => number | null;
}

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function limitOf(
  limits: Readonly<Record<string, unknown>>,
  path: readonly string[],
): number | null {
  let value: unknown = limits;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "number" ? value : null;
}

interface NodeContext {
  readonly workflow: WorkflowRecord;
  readonly threads: ReadonlyMap<string, ThreadView>;
  readonly threadOfTask: ReadonlyMap<string, ThreadView>;
  readonly audits: readonly AuditRecord[];
  readonly usage: readonly UsageRecord[];
  readonly memos: ReadonlyMap<string, string | null>;
  // The model a parent proposed for a child, by proposalKey (null: it left the choice to the table).
  readonly proposed: ReadonlyMap<string, string | null>;
  // The reasoning level each attempt ran at, by task, when the runtime knew it: the level its layer asked for and Pi ran
  // at (event run.started, phase F7), else the gateway's default level (event model.selected).
  readonly levels: ReadonlyMap<string, string | null>;
  // The compaction threshold each real attempt was launched with, by task (event run.started, phase F7).
  readonly compactAts: ReadonlyMap<string, number>;
  readonly options: SnapshotOptions;
  readonly store: Store;
  readonly tasks: readonly WorkflowTaskRecord[];
  readonly cooldowns: readonly { model: string; until: number; reason: string }[];
  readonly runtimeAlive: boolean;
  // The turns stopped because no model could run them, with what the last check found.
  readonly capacityWaits: ReadonlyMap<string, CapacityWait>;
}

function proposalKey(delegationId: string, localId: string): string {
  return `${delegationId}\u0000${localId}`;
}

// Where a thread's model came from (3.11): the user pinned it, its parent proposed it and the Core accepted it as is, or
// the difficulty table chose it (also when the parent's choice was replaced).
function modelSourceOf(thread: ThreadView, context: NodeContext): WorkflowNode["modelSource"] {
  const latest = thread.turns[thread.turns.length - 1] as WorkflowTaskRecord;
  if (latest.modelPinned) return "pinned";
  const made = [...thread.turns].reverse().find((turn) => turn.delegationId !== null);
  const localId = thread.turns[0]?.localId ?? null;
  const proposed =
    made?.delegationId === null || made?.delegationId === undefined || localId === null
      ? undefined
      : context.proposed.get(proposalKey(made.delegationId, localId));
  return proposed !== undefined && proposed !== null && proposed === latest.model
    ? "parent"
    : "table";
}

// The level of the thread's newest attempt that recorded one.
function levelOf(thread: ThreadView, context: NodeContext): string | null {
  for (const turn of [...thread.turns].reverse()) {
    const level = context.levels.get(turn.taskId);
    if (level !== undefined) return level;
  }
  return null;
}

function clockOf(ms: number): string {
  const date = new Date(ms);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

// Retries of an executor thread: its relaunched turns, not counting a reformulation after an escalation.
function retriesOf(thread: ThreadView, audits: readonly AuditRecord[]): number {
  if (thread.role !== "executor") return 0;
  const turnIds = new Set(thread.turns.map((turn) => turn.taskId));
  const escalations = audits.filter(
    (audit) =>
      audit.subjectTaskId !== null &&
      turnIds.has(audit.subjectTaskId) &&
      audit.reworkAction === "escalate",
  ).length;
  return Math.max(0, thread.turns.length - 1 - escalations);
}

function auditSummary(audit: AuditRecord): string {
  const met = audit.reasons.filter((reason) => reason.ok).length;
  return audit.reasons.length === 0
    ? audit.verdict
    : `${met} of ${audit.reasons.length} criteria met`;
}

// The compaction threshold a workflow kept for a layer when it started (P11; phase F7), else null.
function keptThreshold(limits: unknown, role: WorkflowTaskRecord["role"]): number | null {
  const kept = (limits as { context?: { compactAtTokens?: unknown; perLayer?: unknown } } | null)
    ?.context;
  const own = (kept?.perLayer as Record<string, unknown> | undefined)?.[role];
  const value = typeof own === "number" ? own : kept?.compactAtTokens;
  return typeof value === "number" && value > 0 ? value : null;
}

// The detail's context bar (3.12, 7.6): how full the node's last attempt was against its layer's threshold. The fill is
// the Pi session's last reply when there is one, else the attempt's own tokens (a fake agent's single reply); with
// either part unknown the snapshot says so (null).
function contextOf(
  thread: ThreadView,
  rows: readonly UsageRecord[],
  context: NodeContext,
): WorkflowNode["context"] {
  const last = [...rows].reverse().find((row) => row.kind === "agent_run");
  if (last === undefined) return null;
  const threshold =
    (last.taskId === null ? undefined : context.compactAts.get(last.taskId)) ??
    keptThreshold(context.workflow.limits, thread.role);
  const fromSession =
    last.runId === null ? null : (context.options.contextUsedOf?.(last.runId) ?? null);
  const used =
    fromSession ?? (last.tokensIn === null ? null : last.tokensIn + (last.tokensOut ?? 0));
  return threshold === null || used === null ? null : { used, threshold };
}

// How a turn that ended sits in its delegation, read from the state nodeOf gave its thread.
function settledOf(
  thread: ThreadView,
  latest: WorkflowTaskRecord,
  state: WorkflowNode["state"],
  waitingReason: string | null,
): WaitSettled | null {
  if (state === "closed") return "closed_idle";
  if (latest.state === "failed" && state === "done") return "audit_rejected";
  if (latest.state !== "completed") return null;
  if (state === "failed") return "audit_failed";
  if (state !== "waiting") return null;
  if (thread.role === "orchestrator") return "waits_final_audit";
  return waitingReason === "waits for its audit" ? "waits_audit" : "escalated";
}

// The agent running in this workflow that writes a surface this turn wants to write too. Surfaces are globs, so only the
// same glob counts as a certain hold; another overlap has no named holder.
function surfaceHolder(
  latest: WorkflowTaskRecord,
  context: NodeContext,
): { readonly code: string; readonly model: string | null } | null {
  const wanted = new Set(latest.surfaceWrite);
  const holder = context.tasks.find(
    (task) =>
      task.taskId !== latest.taskId &&
      task.state === "running" &&
      task.surfaceWrite.some((surface) => wanted.has(surface)),
  );
  const thread = holder === undefined ? undefined : context.threadOfTask.get(holder.taskId);
  return thread === undefined || holder === undefined
    ? null
    : { code: thread.code, model: holder.model };
}

function capacityOf(
  role: WorkflowTaskRecord["role"],
  context: NodeContext,
): { readonly live: number; readonly max: number } | null {
  const key = { executor: "executors", auditor: "auditors", delegator: "delegators" } as const;
  if (role === "orchestrator") return null;
  const max = limitOf(context.workflow.limits as Readonly<Record<string, unknown>>, [
    "maxConcurrent",
    key[role],
  ]);
  if (max === null) return null;
  const live = context.tasks.filter((task) => task.role === role && task.state === "running");
  return { live: live.length, max };
}

function explanationOf(
  thread: ThreadView,
  latest: WorkflowTaskRecord,
  settled: WaitSettled | null,
  context: NodeContext,
): WaitExplanation {
  const { workflow, threads, threadOfTask, options } = context;
  const detail = context.store.tasks.get(latest.taskId);
  const byId = new Map(context.tasks.map((task) => [task.taskId, task]));
  return explainWait({
    task: {
      state: latest.state,
      blockReason: latest.blockReason,
      cooldownUntil: latest.cooldownUntil,
      retryReason: detail?.retryReason ?? null,
      attempt: latest.attempt,
      maxAttempts: detail?.maxAttempts ?? null,
      model: latest.model,
      parentCode:
        thread.parentThreadId === null ? null : (threads.get(thread.parentThreadId)?.code ?? null),
      failure: detail?.error?.code ?? detail?.failureReason ?? null,
      settled,
    },
    workflow: { id: workflow.workflowId, state: workflow.state, stopReason: workflow.stopReason },
    dependencies: latest.dependsOn.flatMap((dependency) => {
      const task = byId.get(dependency.taskId);
      const owner = threadOfTask.get(dependency.taskId);
      return task === undefined || owner === undefined
        ? []
        : [{ code: owner.code, state: task.state }];
    }),
    cooldowns: context.cooldowns,
    holder: latest.blockReason === "surface_conflict" ? surfaceHolder(latest, context) : null,
    capacity: capacityOf(thread.role, context),
    runtimeAlive: context.runtimeAlive,
    capacityWait:
      latest.state === "blocked" ? (context.capacityWaits.get(latest.taskId) ?? null) : null,
    now: options.now,
  });
}

function nodeOf(thread: ThreadView, context: NodeContext): WorkflowNode {
  const { workflow, audits, usage, options } = context;
  const latest = thread.turns[thread.turns.length - 1] as WorkflowTaskRecord;
  const turnIds = new Set(thread.turns.map((turn) => turn.taskId));
  const rows = usage.filter((row) => row.threadId === thread.threadId);
  const subjectAudits = audits.filter(
    (audit) => audit.subjectTaskId !== null && turnIds.has(audit.subjectTaskId),
  );
  const ownAudits = audits.filter((audit) => turnIds.has(audit.auditorTaskId));
  const latestAudit =
    thread.role === "executor"
      ? subjectAudits[subjectAudits.length - 1]
      : ownAudits[ownAudits.length - 1];
  const latestTurnAudit = subjectAudits.find((audit) => audit.subjectTaskId === latest.taskId);
  const closed = rows.some((row) => row.taskId === latest.taskId && row.outcome === "closed_idle");
  const depLabels = latest.dependsOn
    .map((dependency) => context.threadOfTask.get(dependency.taskId)?.code)
    .filter((code): code is string => code !== undefined);

  let state: WorkflowNode["state"];
  let waitingReason: string | null = null;
  switch (latest.state) {
    case "running":
      state = "running";
      break;
    case "completed":
      state = "done";
      if (thread.role === "executor") {
        if (latestTurnAudit === undefined) {
          state = "waiting";
          waitingReason = "waits for its audit";
        } else if (latestTurnAudit.reworkAction === "fail") {
          state = "failed";
        } else if (latestTurnAudit.reworkAction === "escalate") {
          state = "waiting";
          waitingReason = "escalated to its delegator";
        }
      } else if (thread.role === "orchestrator" && workflow.state === "running") {
        state = "waiting";
        waitingReason = "waits for the final audit";
      }
      break;
    case "failed":
      // An auditor turn that rejected ends failed (its turn is the gate of the step's dependents), but it did its job.
      state = closed
        ? "closed"
        : thread.role === "auditor" &&
            ownAudits.some((audit) => audit.auditorTaskId === latest.taskId)
          ? "done"
          : "failed";
      break;
    case "pending":
      if (
        thread.turns.length > 1 &&
        (thread.role === "orchestrator" || thread.role === "delegator")
      ) {
        state = "waiting";
        waitingReason = "waits for its children";
      } else {
        state = "queued";
        waitingReason =
          thread.role === "auditor"
            ? `waits for ${depLabels.join(", ") || "its executor"} to finish`
            : `depends on ${depLabels.join(", ")}`;
      }
      break;
    case "ready":
      state = "queued";
      waitingReason =
        workflow.state === "awaiting_human"
          ? "waits until the workflow continues"
          : "ready, waiting for capacity";
      break;
    case "blocked":
      if (latest.blockReason === "cooldown") {
        // 3.11: its model is cooling down (a 402 or 429) or over its quota; it runs again when that ends.
        state = "waiting";
        waitingReason =
          latest.cooldownUntil === null
            ? "waits for its model's cooldown"
            : `cooldown until ${clockOf(latest.cooldownUntil)} (${latest.model ?? "its model"})`;
        break;
      }
      state = latest.blockReason === "awaiting_human" ? "awaiting_human" : "failed";
      waitingReason =
        latest.blockReason === "dep_failed" ? "a dependency failed" : latest.blockReason;
      break;
    default:
      state = "cancelled";
  }

  const settled = settledOf(thread, latest, state, waitingReason);
  // The latest turn that ran (a turn that never ran, such as the auditor of a closed attempt, is skipped).
  const lastStarted = thread.turns.reduce(
    (found, turn, index) => (turn.attempt > 0 ? index + 1 : found),
    1,
  );
  const last = rows[rows.length - 1];
  const model = latest.model ?? "(none)";
  return {
    id: thread.code,
    parentId:
      thread.parentThreadId === null
        ? null
        : (context.threads.get(thread.parentThreadId)?.code ?? null),
    auditedId:
      thread.auditedThreadId === null
        ? null
        : (context.threads.get(thread.auditedThreadId)?.code ?? null),
    threadId: thread.threadId,
    depth: 0,
    layer: thread.layer,
    role: thread.role,
    label: thread.label,
    goal: thread.turns[0]?.goal ?? "",
    state,
    model,
    modelSource: modelSourceOf(thread, context),
    thinkingLevel: levelOf(thread, context),
    tokens: sum(rows.map((row) => row.tokensIn)) + sum(rows.map((row) => row.tokensOut)),
    elapsedMs: rows.length === 0 ? null : sum(rows.map((row) => row.durationMs)),
    lastProgress:
      last === undefined ? null : { at: last.endedAt ?? last.ts, text: last.outcome ?? last.kind },
    // Only a live turn is checked again by the watchdog; an ended one keeps its last schedule in the store.
    nextCheckAt: LIVE_TURN.has(latest.state) ? latest.nextCheckAt : null,
    context: contextOf(thread, rows, context),
    quota: options.quotaOf?.(model) ?? null,
    difficulty:
      latest.difficulty === null
        ? null
        : { estimated: latest.difficulty, reason: latest.difficultyReason ?? "" },
    files: { write: [...latest.surfaceWrite], read: [...latest.surfaceRead] },
    memo: context.memos.get(thread.threadId) ?? null,
    audit:
      latestAudit === undefined
        ? null
        : {
            verdict: latestAudit.verdict,
            summary: auditSummary(latestAudit),
            retries: retriesOf(thread, audits),
          },
    waitingReason,
    explanation: explanationOf(thread, latest, settled, context),
    turn: { index: lastStarted, of: thread.turns.length },
  };
}

// An event that carries its own line (a watchdog verdict, 3.16: "e1 active, continues") is shown as that line, which
// starts with the node's id as the console's detail view reads it; any other event lists its fields.
export function eventText(payload: Readonly<Record<string, unknown>>): string {
  if (typeof payload.text === "string") return payload.text;
  return Object.entries(payload)
    .filter(([key]) => key !== "workflowId")
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
}

// The git side of a workflow that writes (phase F8): its base, its integration branch and what was merged into it; null
// for a read-only workflow.
function gitOf(store: Store, workflow: WorkflowRecord): WorkflowGit | null {
  if (workflow.baseBranch === null || workflow.baseSha === null) return null;
  const worktrees = store.worktrees.list({ workflowId: workflow.workflowId });
  const integration = worktrees.find((record) => record.kind === "integration");
  const executors = worktrees.filter((record) => record.kind === "executor");
  return {
    baseBranch: workflow.baseBranch,
    baseSha: workflow.baseSha,
    integrationBranch: integration?.branch ?? `haril/${workflow.workflowId}/integration`,
    integrationHead: integration?.headSha ?? null,
    merged: executors.filter((record) => record.mergedAt !== null).length,
    unmerged: executors
      .filter((record) => record.mergedAt === null && record.headSha !== null)
      .map((record) => record.branch),
    worktrees: worktrees.filter((record) => record.state === "active").length,
  };
}

// Whether a runtime holds the lease now. Without one, nothing in the queue starts.
function runtimeAliveOf(store: Store, now: number): boolean {
  const lease = store.runtime.leaseSummary();
  return lease.status === "active" && lease.expiresAt > now;
}

export function buildWorkflowSnapshot(
  store: Store,
  workflowId: string,
  options: SnapshotOptions,
): WorkflowSnapshot {
  const workflow = store.workflows.get(workflowId);
  if (workflow === undefined) throw new Error(`no workflow ${workflowId}`);
  const tasks = store.workflows.tasks(workflowId);
  const threads = threadsOf(tasks);
  const threadMap = new Map(threads.map((thread) => [thread.threadId, thread]));
  const threadOfTask = new Map<string, ThreadView>();
  for (const thread of threads)
    for (const turn of thread.turns) threadOfTask.set(turn.taskId, thread);
  const audits = store.workflows.audits(workflowId);
  const usage = store.usageLog.usage({ workflowId });
  const memos = new Map<string, string | null>();
  const proposed = new Map<string, string | null>();
  for (const delegation of store.workflows.delegations(workflowId)) {
    memos.set(delegation.threadId, delegation.memo);
    const payload = delegation.payload as Record<string, unknown> | null;
    const items = payload?.delegations ?? payload?.assignments;
    for (const item of Array.isArray(items) ? items : []) {
      const child = item as { localId?: unknown; model?: unknown };
      if (typeof child.localId !== "string") continue;
      proposed.set(
        proposalKey(delegation.delegationId, child.localId),
        typeof child.model === "string" ? child.model : null,
      );
    }
  }
  const projectEvents = store.events.list({ projectId: workflow.projectId });
  const levels = new Map<string, string | null>();
  const compactAts = new Map<string, number>();
  const capacityWaits = new Map<string, CapacityWait>();
  for (const event of projectEvents) {
    // A later block is a plain one, unless the runtime's check writes its own line right after it.
    if (event.taskId !== null && event.taskId !== undefined) {
      if (event.type === "task.blocked") capacityWaits.delete(event.taskId);
      if (event.type === "capacity.waiting") {
        capacityWaits.set(event.taskId, event.payload as unknown as CapacityWait);
      }
    }
    const payload = event.payload as {
      workflowId?: unknown;
      thinkingLevel?: unknown;
      compactAtTokens?: unknown;
    };
    if (event.taskId === null || event.taskId === undefined) continue;
    if (event.type === "model.selected" && payload.workflowId === workflowId) {
      levels.set(
        event.taskId,
        typeof payload.thinkingLevel === "string" ? payload.thinkingLevel : null,
      );
    } else if (event.type === "run.started") {
      // The level the agent's layer asked for wins over the gateway's default (null: none was asked for).
      if (typeof payload.thinkingLevel === "string")
        levels.set(event.taskId, payload.thinkingLevel);
      if (typeof payload.compactAtTokens === "number") {
        compactAts.set(event.taskId, payload.compactAtTokens);
      }
    }
  }
  const context: NodeContext = {
    workflow,
    threads: threadMap,
    threadOfTask,
    audits,
    usage,
    memos,
    proposed,
    levels,
    compactAts,
    options,
    store,
    tasks,
    cooldowns: store.quota.cooldowns(options.now),
    runtimeAlive: runtimeAliveOf(store, options.now),
    capacityWaits,
  };

  // Depth-first: each thread followed by its children, in creation order.
  const children = new Map<string | null, ThreadView[]>();
  for (const thread of threads) {
    const list = children.get(thread.parentThreadId) ?? [];
    list.push(thread);
    children.set(thread.parentThreadId, list);
  }
  const nodes: WorkflowNode[] = [];
  const visit = (thread: ThreadView, depth: number): void => {
    nodes.push({ ...nodeOf(thread, context), depth });
    for (const child of children.get(thread.threadId) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);

  const limits = workflow.limits as Readonly<Record<string, unknown>>;
  const live = (role: WorkflowTaskRecord["role"]) =>
    tasks.filter((task) => task.role === role && task.state === "running").length;
  const events = projectEvents
    .filter(
      (event) =>
        event.aggregateId === workflowId ||
        (event.payload as { workflowId?: unknown }).workflowId === workflowId,
    )
    .filter((event) => event.type !== "task.created")
    .slice(-40)
    .map((event) => ({ at: event.ts, type: event.type, text: eventText(event.payload) }));

  // A flow that cannot go on until a model frees says so, whatever else it still has running.
  const noCapacity = nodes
    .map((node) => node.explanation)
    .find((item) => item?.code === "blocked_no_capacity");

  return {
    schemaVersion: 1,
    demo: workflow.simulated,
    workflow: {
      id: workflow.workflowId,
      goal: workflow.goal,
      state: workflow.state,
      startedAt: workflow.createdAt,
      elapsedMs: Math.max(0, (workflow.endedAt ?? options.now) - workflow.createdAt),
      autonomy: { mode: workflow.autonomy.mode, stops: [...workflow.autonomy.stops] },
      orchestratorModel: workflow.orchestratorModel,
      stopReason: workflow.stopReason,
      explanation:
        workflow.state === "running" && noCapacity !== undefined
          ? noCapacity
          : explainWorkflow({
              id: workflow.workflowId,
              state: workflow.state,
              stopReason: workflow.stopReason,
            }),
    },
    git: gitOf(store, workflow),
    totals: {
      tokensUsed: sum(usage.map((row) => row.tokensIn)) + sum(usage.map((row) => row.tokensOut)),
      tokensBudget: limitOf(limits, ["maxWorkflowTokens"]),
      agentsCreated: workflow.agentsCreated,
      agentsCap: limitOf(limits, ["maxAgentsPerWorkflow"]) ?? 0,
      queued: tasks.filter((task) => task.state === "ready" || task.state === "pending").length,
      retries: threads.reduce((total, thread) => total + retriesOf(thread, audits), 0),
      escalations: audits.filter((audit) => audit.reworkAction === "escalate").length,
    },
    capacity: {
      executors: {
        live: live("executor"),
        max: limitOf(limits, ["maxConcurrent", "executors"]) ?? 0,
      },
      auditors: { live: live("auditor"), max: limitOf(limits, ["maxConcurrent", "auditors"]) ?? 0 },
      delegators: {
        live: live("delegator"),
        max: limitOf(limits, ["maxConcurrent", "delegators"]) ?? 0,
      },
    },
    nodes,
    quota: options.quota ?? [],
    events,
    usage: usage.map((row) => ({
      at: row.ts,
      kind: row.kind,
      role: row.role ?? row.kind,
      model: row.modelServed ?? row.modelRequested ?? "",
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      durationMs: row.durationMs,
      difficulty: row.difficultyEst,
      outcome: row.outcome,
    })),
  };
}

function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

function kilo(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

function note(node: WorkflowNode): string {
  if (node.role === "executor" && node.audit !== null) {
    const retries = node.audit.retries;
    const tail = retries === 0 ? "" : ` after ${retries} ${retries === 1 ? "retry" : "retries"}`;
    if (node.state === "waiting") return node.waitingReason ?? "";
    return `${node.audit.verdict}${tail}`;
  }
  if (node.role === "auditor" && node.audit !== null)
    return `${node.audit.verdict}, ${node.audit.summary}`;
  return node.waitingReason ?? "";
}

// The tree, one line per thread, with ASCII branches so any terminal draws it.
export function treeLines(snapshot: WorkflowSnapshot): string[] {
  const { nodes } = snapshot;
  const width = (pick: (node: WorkflowNode) => string) =>
    Math.max(0, ...nodes.map((node) => Array.from(pick(node)).length));
  const prefixes = new Map<string, string>();
  const lines: string[] = [];
  const rows = nodes.map((node, index) => {
    const parentPrefix = node.parentId === null ? "" : (prefixes.get(node.parentId) ?? "");
    const siblings = nodes.filter((other) => other.parentId === node.parentId);
    const lastSibling = siblings[siblings.length - 1] === node;
    const branch = node.parentId === null ? "" : `${parentPrefix}${lastSibling ? "`- " : "+- "}`;
    prefixes.set(
      node.id,
      node.parentId === null ? "" : `${parentPrefix}${lastSibling ? "   " : "|  "}`,
    );
    return { node, head: `${branch}${node.id}`, index };
  });
  const headWidth = Math.max(...rows.map((row) => row.head.length), 0);
  const roleWidth = width((node) => node.role);
  const stateWidth = width((node) => node.state);
  const modelWidth = width((node) => node.model);
  for (const { node, head } of rows) {
    const cells = [
      head.padEnd(headWidth),
      node.role.padEnd(roleWidth),
      node.state.padEnd(stateWidth),
      node.model.padEnd(modelWidth),
      node.modelSource.padEnd(6),
      kilo(node.tokens).padStart(6),
      `turn ${node.turn?.index ?? 1}/${node.turn?.of ?? 1}`,
      note(node),
    ];
    lines.push(visibleText(cells.join("  ").trimEnd()));
  }
  return lines;
}

export function headerLines(snapshot: WorkflowSnapshot, label: string): string[] {
  const { workflow } = snapshot;
  const autonomy =
    workflow.autonomy.mode === "autonomous"
      ? "autonomous"
      : `stops at ${workflow.autonomy.stops.join(", ")}`;
  const git = snapshot.git ?? null;
  const branch =
    git === null
      ? []
      : [
          visibleText(
            `branch     ${git.integrationBranch} (from ${git.baseBranch} ${git.baseSha.slice(0, 7)}; ${git.merged} ${git.merged === 1 ? "step" : "steps"} merged${git.integrationHead === null ? ", nothing yet" : ""})`,
          ),
          ...(git.unmerged.length === 0
            ? []
            : [visibleText(`unmerged   ${git.unmerged.join(", ")}`)]),
        ];
  return [
    visibleText(`workflow ${workflow.id}  ${workflow.state}  (${label})`),
    visibleText(`goal       ${workflow.goal}`),
    visibleText(`autonomy   ${autonomy} · orchestrator ${workflow.orchestratorModel} (pinned)`),
    ...branch,
    `elapsed    ${clock(workflow.elapsedMs)}`,
  ];
}
