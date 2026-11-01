import {
  type DelegationSettings,
  type FactoryColumn,
  type FactoryModel,
  HUMAN_REQUEST_KIND,
  isHumanRequest,
  type WaitExplanation,
  type WorkflowNode,
  type WorkflowSnapshot,
} from "@haril/contracts";
import type {
  ApprovalRecord,
  AuditRecord,
  ProjectRecord,
  Store,
  WorkflowRecord,
  WorkflowTaskRecord,
} from "@haril/core/ports";
import { delegationSettingsOf } from "../delegation-section.js";
import { agentMessages } from "../runtime/agent-messages.js";
import { resultText, WorkflowView } from "../runtime/workflow-view.js";
import { buildFactoryQuota } from "./factory-quota.js";
import { buildFactorySystem } from "./factory-system.js";
import { buildWorkflowSnapshot, eventText, type SnapshotOptions } from "./workflow-snapshot.js";

// The factory's read model (feature haril-factory, F3): the workflows of a project, or of them all, as the console's
// factory view draws them. A task is an agent's work: one card per thread, showing its latest turn. It is built on each
// workflow's WorkflowSnapshot, so a node's state and explanation mean the same in both views. It reads the store only.

// Older ended workflows are left out: the view is about the work at hand, and each one costs a read on every tick.
const RECENT_ENDED_WORKFLOWS = 10;
const RECENT_EVENTS = 300;
const SAID_MAX_CHARS = 600;
const ENDED: ReadonlySet<WorkflowRecord["state"]> = new Set(["completed", "failed", "stopped"]);
// The person, as the card of a failed root task names who has it now.
const THE_PERSON = "tú";

export interface FactoryModelOptions {
  readonly now: number;
  readonly project?: ProjectRecord;
  readonly contextUsedOf?: SnapshotOptions["contextUsedOf"];
  // The snapshots of workflows that ended, kept between reads: they do not change any more.
  readonly endedSnapshots?: Map<string, WorkflowSnapshot>;
  // haril.json's settings in effect; default: its defaults.
  readonly settings?: DelegationSettings;
}

function chosenWorkflows(store: Store, project: ProjectRecord | undefined): WorkflowRecord[] {
  const rows = store.workflows.list(
    project === undefined ? undefined : { projectId: project.projectId },
  );
  const byNewest = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  const live = byNewest.filter((row) => !ENDED.has(row.state));
  const ended = byNewest.filter((row) => ENDED.has(row.state)).slice(0, RECENT_ENDED_WORKFLOWS);
  return [...live, ...ended];
}

function snapshotOf(
  store: Store,
  workflow: WorkflowRecord,
  options: FactoryModelOptions,
): WorkflowSnapshot {
  const kept = options.endedSnapshots?.get(workflow.workflowId);
  if (kept !== undefined) return kept;
  const snapshot = buildWorkflowSnapshot(store, workflow.workflowId, {
    now: options.now,
    ...(options.contextUsedOf === undefined ? {} : { contextUsedOf: options.contextUsedOf }),
  });
  if (ENDED.has(workflow.state)) options.endedSnapshots?.set(workflow.workflowId, snapshot);
  return snapshot;
}

// A person's request that is still open, by the task that made it.
function openRequests(store: Store): ReadonlyMap<string, ApprovalRecord> {
  const out = new Map<string, ApprovalRecord>();
  for (const approval of store.approvals.list({ status: "requested" })) {
    if (approval.kind === HUMAN_REQUEST_KIND && isHumanRequest(approval.subject)) {
      out.set(approval.subject.taskId, approval);
    }
  }
  return out;
}

function requestExplanation(approval: ApprovalRecord): WaitExplanation | null {
  if (!isHumanRequest(approval.subject)) return null;
  const { needs, why, ifRefused } = approval.subject;
  return {
    code: "human_request",
    what: needs,
    why,
    systemAction: `Responde en la fábrica, o con \`haril factory answer ${approval.approvalId} approve|deny|write\`. Si no: ${ifRefused}`,
    needsHuman: true,
    until: null,
  };
}

function columnOf(
  node: WorkflowNode,
  latest: WorkflowTaskRecord,
  workflow: WorkflowRecord,
): FactoryColumn {
  // Everything still open in a workflow that is not running waits for that, whatever else it waits for.
  const held = workflow.state !== "running";
  switch (node.state) {
    case "running":
      return "en_curso";
    case "waiting":
      return held || latest.state === "blocked" ? "detenidas" : "en_curso";
    case "queued":
      return held ? "detenidas" : "por_hacer";
    case "awaiting_human":
    case "cancelled":
      return "detenidas";
    case "failed":
      return latest.state === "blocked" ? "detenidas" : "errores";
    case "closed":
      return "errores";
    case "done":
      return "hechas";
  }
}

interface CriteriaCount {
  readonly passed: number;
  readonly total: number;
}

function criteriaOf(audit: AuditRecord): CriteriaCount {
  return {
    passed: audit.reasons.filter((reason) => reason.ok).length,
    total: audit.reasons.length,
  };
}

// The criteria of each subject's newest audit: an attempt that was reworked no longer counts against the work.
function latestCriteria(audits: readonly AuditRecord[]): Map<string, CriteriaCount> {
  const out = new Map<string, CriteriaCount>();
  for (const audit of audits) {
    if (audit.reasons.length === 0) continue;
    out.set(audit.subjectTaskId ?? `workflow:${audit.auditId}`, criteriaOf(audit));
  }
  return out;
}

function summed(rows: Iterable<CriteriaCount>): CriteriaCount | null {
  let passed = 0;
  let total = 0;
  for (const row of rows) {
    passed += row.passed;
    total += row.total;
  }
  return total === 0 ? null : { passed, total };
}

function fallbackExplanation(snapshot: WorkflowSnapshot): WaitExplanation {
  return (
    snapshot.workflow.explanation ?? {
      code: "unexplained",
      what: "Sin explicación",
      why: "El flujo no registró una explicación.",
      systemAction: "Revisa `haril events`.",
      needsHuman: false,
      until: null,
    }
  );
}

// The agents whose open turns this turn depends on.
function waitedAgents(
  latest: WorkflowTaskRecord,
  turns: readonly WorkflowTaskRecord[],
  nodes: readonly WorkflowNode[],
): string[] {
  const open = new Set(["pending", "ready", "running", "blocked"]);
  const threads = latest.dependsOn.flatMap((dependency) => {
    const turn = turns.find((row) => row.taskId === dependency.taskId);
    return turn !== undefined && open.has(turn.state) ? [turn.threadId] : [];
  });
  return [
    ...new Set(
      threads.flatMap((threadId) => {
        const node = nodes.find((row) => row.threadId === threadId);
        return node === undefined ? [] : [node.id];
      }),
    ),
  ];
}

interface Built {
  readonly workflow: FactoryModel["workflows"][number];
  readonly tasks: FactoryModel["tasks"];
  readonly agents: FactoryModel["agents"];
  readonly edges: FactoryModel["edges"];
  readonly requests: FactoryModel["humanRequests"];
  // The agent's code of each of its turns, for the event log.
  readonly agentOfTask: ReadonlyMap<string, string>;
  readonly agentOfThread: ReadonlyMap<string, string>;
}

function buildWorkflow(
  store: Store,
  record: WorkflowRecord,
  projectSlug: string,
  options: FactoryModelOptions,
): Built {
  const snapshot = snapshotOf(store, record, options);
  const view = WorkflowView.load(store, record.workflowId);
  const turns = store.workflows.tasks(record.workflowId);
  const audits = store.workflows.audits(record.workflowId);
  const criteria = latestCriteria(audits);
  const fallback = fallbackExplanation(snapshot);
  const agentOfTask = new Map<string, string>();
  const agentOfThread = new Map<string, string>();
  const tasks: FactoryModel["tasks"][number][] = [];
  const agents: FactoryModel["agents"][number][] = [];
  const edges: FactoryModel["edges"][number][] = [];
  const requests: FactoryModel["humanRequests"][number][] = [];
  const asked = openRequests(store);
  const workflowEvents = store.events.list({ aggregateId: record.workflowId });

  for (const node of snapshot.nodes) {
    const ownTurns = turns.filter((turn) => turn.threadId === node.threadId);
    const latest = ownTurns[ownTurns.length - 1];
    if (latest === undefined) continue;
    for (const turn of ownTurns) agentOfTask.set(turn.taskId, node.id);
    agentOfThread.set(node.threadId, node.id);
    const open = ownTurns.flatMap((turn) => {
      const found = asked.get(turn.taskId);
      return found === undefined ? [] : [found];
    })[0];
    const column = open === undefined ? columnOf(node, latest, record) : "detenidas";
    const explanation =
      (open === undefined ? null : requestExplanation(open)) ?? node.explanation ?? fallback;
    const localId = ownTurns[0]?.localId ?? null;
    const notes = workflowEvents.flatMap((event) => {
      if (!event.type.startsWith("note.")) return [];
      const payload = event.payload as { localId?: unknown; text?: unknown };
      return payload.localId === localId && localId !== null && typeof payload.text === "string"
        ? [payload.text]
        : [];
    });
    const model = latest.model;
    const newestCriteria = [...ownTurns]
      .reverse()
      .map((turn) => criteria.get(turn.taskId))
      .find((found) => found !== undefined);
    const times = ownTurns.flatMap((turn) => [turn.createdAt, turn.completedAt ?? 0]);
    tasks.push({
      id: latest.taskId,
      workflowId: record.workflowId,
      title: node.goal,
      state: latest.state,
      column,
      role: view?.roleOf(latest) ?? node.role,
      agent: node.id,
      delegatedBy: node.parentId,
      returnedTo: column === "errores" ? (node.parentId ?? THE_PERSON) : null,
      model,
      attempts: ownTurns.reduce((total, turn) => total + turn.attempt, 0),
      maxAttempts: store.tasks.get(latest.taskId)?.maxAttempts ?? null,
      context: node.context,
      tokens: node.tokens,
      criteria: newestCriteria ?? null,
      explanation,
      notes,
      closedAt: column === "hechas" ? (latest.completedAt ?? null) : null,
      updatedAt: Math.max(...times, node.lastProgress?.at ?? 0),
    });
    agents.push({
      workflowId: record.workflowId,
      code: node.id,
      role: view?.roleOf(latest) ?? node.role,
      status: node.state,
      taskId: latest.taskId,
      task: node.goal,
      model,
      tokens: node.tokens,
      elapsedMs: node.elapsedMs,
      context: node.context,
      parent: node.parentId,
      depth: node.depth,
      waitingFor: waitedAgents(latest, turns, snapshot.nodes),
      activity: node.lastProgress?.text ?? null,
      said: ownTurns.flatMap((turn) => {
        const text = resultText(turn.result);
        return text === null || text.trim() === "" || turn.completedAt === null
          ? []
          : [{ at: turn.completedAt, text: text.slice(0, SAID_MAX_CHARS) }];
      }),
    });
    if (node.parentId !== null) {
      edges.push({ workflowId: record.workflowId, parent: node.parentId, child: node.id });
    }
    if (latest.state === "blocked" && latest.blockReason === "awaiting_human") {
      requests.push({
        kind: "task",
        id: latest.taskId,
        workflowId: record.workflowId,
        projectSlug,
        title: `${node.id}: ${node.goal}`,
        explanation,
        at: latest.createdAt,
        request: null,
      });
    }
  }

  if (record.state === "awaiting_human") {
    requests.unshift({
      kind: "stop",
      id: record.workflowId,
      workflowId: record.workflowId,
      projectSlug,
      title: record.goal,
      explanation: fallback,
      at: Math.max(record.createdAt, ...tasks.map((task) => task.updatedAt)),
      request: null,
    });
  }

  const closedTasks = tasks.filter((task) => task.column === "hechas").length;
  return {
    workflow: {
      id: record.workflowId,
      projectSlug,
      goal: record.goal,
      state: record.state,
      stopReason: record.stopReason,
      explanation: fallback,
      startedAt: record.createdAt,
      elapsedMs: snapshot.workflow.elapsedMs,
      tokensUsed: snapshot.totals.tokensUsed,
      tokensBudget: snapshot.totals.tokensBudget,
      agentsCreated: snapshot.totals.agentsCreated,
      agentsCap: snapshot.totals.agentsCap,
      closedTasks,
      totalTasks: tasks.length,
      criteria: summed(criteria.values()),
    },
    tasks,
    agents,
    edges,
    requests,
    agentOfTask,
    agentOfThread,
  };
}

function approvalRequest(
  approval: ApprovalRecord,
  projectSlug: string,
): FactoryModel["humanRequests"][number] {
  const planned = (approval.subject as { tasks?: unknown }).tasks;
  const tasks = Array.isArray(planned) ? (planned as { goal?: unknown }[]) : [];
  const first = tasks.find((task) => typeof task.goal === "string")?.goal as string | undefined;
  const count = `${tasks.length} ${tasks.length === 1 ? "tarea" : "tareas"}`;
  return {
    kind: "approval",
    id: approval.approvalId,
    workflowId: null,
    projectSlug,
    title: first === undefined ? `Plan de ${count}` : `Plan de ${count}: ${first}`,
    request: null,
    explanation: {
      code: "approval_requested",
      what: "Un plan espera tu aprobación",
      why: `Se propuso un plan de ${count} y nada corre hasta que respondas.`,
      systemAction: `Pulsa a o d, o ejecuta \`haril approve ${approval.approvalId}\` o \`haril deny ${approval.approvalId}\`.`,
      needsHuman: true,
      until: null,
    },
    at: approval.requestedAt,
  };
}

function humanRequest(
  approval: ApprovalRecord,
  projectSlug: string,
): FactoryModel["humanRequests"][number] | null {
  if (!isHumanRequest(approval.subject)) return null;
  const {
    reason,
    who,
    delegatedBy,
    task,
    doing,
    needs,
    why,
    ifRefused,
    blocks,
    action,
    workflowId,
  } = approval.subject;
  return {
    kind: "human",
    id: approval.approvalId,
    workflowId,
    projectSlug,
    title: `${who}: ${needs}`,
    explanation: requestExplanation(approval) as WaitExplanation,
    at: approval.requestedAt,
    request: {
      reason,
      who,
      delegatedBy,
      task,
      doing,
      needs,
      why,
      ifRefused,
      blocks: [...blocks],
      action: action === null ? null : [action.program, ...action.args].join(" "),
    },
  };
}

function eventsOf(
  store: Store,
  projectIds: readonly string[],
  built: readonly Built[],
): FactoryModel["events"] {
  const shown = new Set(built.map((item) => item.workflow.id));
  const agentOfTask = new Map(built.flatMap((item) => [...item.agentOfTask]));
  return projectIds
    .flatMap((projectId) => store.events.list({ projectId, limit: RECENT_EVENTS }))
    .flatMap((event) => {
      const payload = event.payload as Readonly<Record<string, unknown>>;
      const named = typeof payload.workflowId === "string" ? payload.workflowId : null;
      const workflowId = named ?? (shown.has(event.aggregateId) ? event.aggregateId : null);
      if (workflowId === null || !shown.has(workflowId) || event.type === "task.created") return [];
      return [
        {
          at: event.ts,
          type: event.type,
          text: eventText(payload),
          workflowId,
          agent:
            event.taskId === null || event.taskId === undefined
              ? null
              : (agentOfTask.get(event.taskId) ?? null),
        },
      ];
    })
    .sort((a, b) => a.at - b.at)
    .filter(
      // A stop for capacity is checked every minute: only its last line says something.
      (event, index, rows) =>
        event.type !== "capacity.waiting" ||
        !rows
          .slice(index + 1)
          .some((later) => later.type === event.type && later.agent === event.agent),
    )
    .slice(-RECENT_EVENTS);
}

// Who moved where: a turn's model replaced by another, and any handoff an agent recorded.
function handoffsOf(
  store: Store,
  projectIds: readonly string[],
  built: readonly Built[],
): FactoryModel["handoffs"] {
  const shown = new Set(built.map((item) => item.workflow.id));
  const agentOfTask = new Map(built.flatMap((item) => [...item.agentOfTask]));
  return projectIds
    .flatMap((projectId) => store.events.list({ projectId, limit: RECENT_EVENTS }))
    .flatMap((event) => {
      const kind =
        event.type === "model.substituted"
          ? ("model" as const)
          : event.type.includes("handoff")
            ? ("agent" as const)
            : null;
      if (kind === null) return [];
      const payload = event.payload as Readonly<Record<string, unknown>>;
      const workflowId =
        typeof payload.workflowId === "string" ? payload.workflowId : event.aggregateId;
      const { from, to, taskId, reason } = payload;
      if (!shown.has(workflowId) || typeof from !== "string" || typeof to !== "string") return [];
      const task = event.taskId ?? (typeof taskId === "string" ? taskId : null);
      return [
        {
          at: event.ts,
          workflowId,
          agent: task === null ? null : (agentOfTask.get(task) ?? null),
          kind,
          from,
          to,
          reason: typeof reason === "string" ? reason : null,
        },
      ];
    })
    .sort((a, b) => a.at - b.at);
}

function messagesOf(store: Store, built: readonly Built[]): FactoryModel["messages"] {
  return built.flatMap((item) => {
    const view = WorkflowView.load(store, item.workflow.id);
    if (view === undefined) return [];
    return agentMessages(store, item.workflow.id).map((message) => ({
      id: message.id,
      workflowId: item.workflow.id,
      agent: item.agentOfThread.get(message.threadId) ?? message.threadId,
      text: message.text,
      urgent: message.urgent,
      from: message.from,
      at: message.at,
      state: message.state,
    }));
  });
}

function gitActionsOf(
  store: Store,
  projectIds: readonly string[],
  built: readonly Built[],
): FactoryModel["gitActions"] {
  const agentOfTask = new Map(built.flatMap((item) => [...item.agentOfTask]));
  return projectIds
    .flatMap((projectId) => store.events.list({ projectId, limit: RECENT_EVENTS }))
    .flatMap((event) => {
      if (event.type !== "git.action") return [];
      const payload = event.payload as Readonly<Record<string, unknown>>;
      return [
        {
          at: event.ts,
          workflowId: typeof payload.workflowId === "string" ? payload.workflowId : null,
          agent:
            event.taskId === null || event.taskId === undefined
              ? null
              : (agentOfTask.get(event.taskId) ?? null),
          level: typeof payload.level === "string" ? payload.level : "free",
          command: typeof payload.command === "string" ? payload.command : "",
          exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
          output: typeof payload.output === "string" ? payload.output : "",
        },
      ];
    })
    .sort((a, b) => a.at - b.at);
}

export function buildFactoryModel(store: Store, options: FactoryModelOptions): FactoryModel {
  const { project } = options;
  const projects = project === undefined ? store.projects.list() : [project];
  const slugOf = new Map(projects.map((item) => [item.projectId, item.slug]));
  const built = chosenWorkflows(store, project).map((record) =>
    buildWorkflow(store, record, slugOf.get(record.projectId) ?? record.projectId, options),
  );
  const approvals = store.approvals
    .list({
      status: "requested",
      ...(project === undefined ? {} : { projectId: project.projectId }),
    })
    .filter((approval) => approval.kind !== HUMAN_REQUEST_KIND)
    .map((approval) =>
      approvalRequest(approval, slugOf.get(approval.projectId) ?? approval.projectId),
    );
  const asks = store.approvals
    .list({
      status: "requested",
      ...(project === undefined ? {} : { projectId: project.projectId }),
    })
    .filter((approval) => approval.kind === HUMAN_REQUEST_KIND)
    .flatMap((approval) => {
      const row = humanRequest(approval, slugOf.get(approval.projectId) ?? approval.projectId);
      return row === null ? [] : [row];
    });
  const agents = built.flatMap((item) => item.agents);
  const settings = options.settings ?? delegationSettingsOf(undefined);
  const quota = buildFactoryQuota(store, options.now, agents, settings.quota);
  return {
    schemaVersion: 1,
    generatedAt: options.now,
    project: project?.slug ?? null,
    workflows: built.map((item) => item.workflow),
    tasks: built.flatMap((item) => item.tasks),
    agents,
    edges: built.flatMap((item) => item.edges),
    events: eventsOf(
      store,
      projects.map((item) => item.projectId),
      built,
    ),
    handoffs: handoffsOf(
      store,
      projects.map((item) => item.projectId),
      built,
    ),
    messages: messagesOf(store, built),
    gitActions: gitActionsOf(
      store,
      projects.map((item) => item.projectId),
      built,
    ),
    quota,
    system: buildFactorySystem(store, options.now, quota, settings),
    humanRequests: [...asks, ...approvals, ...built.flatMap((item) => item.requests)],
  };
}
