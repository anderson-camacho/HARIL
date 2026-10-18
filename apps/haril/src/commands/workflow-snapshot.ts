import type { WorkflowNode, WorkflowSnapshot } from "@haril/contracts";
import { visibleText } from "@haril/core";
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
// eN, fa for the final auditor. The haril workflow demo prints it; `haril workflow show` (phase F5b) will reuse it.

export interface ThreadView {
  readonly threadId: string;
  readonly code: string;
  readonly label: string;
  readonly role: WorkflowTaskRecord["role"];
  readonly layer: 1 | 2 | 3;
  readonly parentThreadId: string | null;
  // In creation order.
  readonly turns: readonly WorkflowTaskRecord[];
}

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
    let code: string;
    let label: string;
    if (first.role === "auditor") {
      const parentCode = parentThreadId === null ? undefined : codeOf.get(parentThreadId);
      if (parent?.role === "executor" && parentCode !== undefined) {
        code = `a${parentCode.slice(1)}`;
        label = `Auditor of ${parentCode}`;
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
  readonly options: SnapshotOptions;
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
      state = closed ? "closed" : "failed";
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
      waitingReason = "ready, waiting for capacity";
      break;
    case "blocked":
      state = latest.blockReason === "awaiting_human" ? "awaiting_human" : "failed";
      waitingReason =
        latest.blockReason === "dep_failed" ? "a dependency failed" : latest.blockReason;
      break;
    default:
      state = "cancelled";
  }

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
    threadId: thread.threadId,
    depth: 0,
    layer: thread.layer,
    role: thread.role,
    label: thread.label,
    goal: thread.turns[0]?.goal ?? "",
    state,
    model,
    modelSource: latest.modelPinned ? "pinned" : "table",
    thinkingLevel: null,
    tokens: sum(rows.map((row) => row.tokensIn)) + sum(rows.map((row) => row.tokensOut)),
    elapsedMs: rows.length === 0 ? null : sum(rows.map((row) => row.durationMs)),
    lastProgress:
      last === undefined ? null : { at: last.endedAt ?? last.ts, text: last.outcome ?? last.kind },
    nextCheckAt: latest.nextCheckAt,
    context: null,
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
    turn: { index: lastStarted, of: thread.turns.length },
  };
}

function eventText(payload: Readonly<Record<string, unknown>>): string {
  return Object.entries(payload)
    .filter(([key]) => key !== "workflowId")
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
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
  for (const delegation of store.workflows.delegations(workflowId))
    memos.set(delegation.threadId, delegation.memo);
  const context: NodeContext = {
    workflow,
    threads: threadMap,
    threadOfTask,
    audits,
    usage,
    memos,
    options,
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
  const events = store.events
    .list({ projectId: workflow.projectId })
    .filter(
      (event) =>
        event.aggregateId === workflowId ||
        (event.payload as { workflowId?: unknown }).workflowId === workflowId,
    )
    .filter((event) => event.type !== "task.created")
    .slice(-40)
    .map((event) => ({ at: event.ts, type: event.type, text: eventText(event.payload) }));

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
    },
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
  return [
    visibleText(`workflow ${workflow.id}  ${workflow.state}  (${label})`),
    visibleText(`goal       ${workflow.goal}`),
    visibleText(`autonomy   ${autonomy} · orchestrator ${workflow.orchestratorModel} (pinned)`),
    `elapsed    ${clock(workflow.elapsedMs)}`,
  ];
}
