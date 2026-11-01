import { randomUUID } from "node:crypto";
import {
  HUMAN_REQUEST_KIND,
  type HumanRequest,
  isHumanRequest,
  WRITTEN_ANSWER_PREFIX,
} from "@haril/contracts";
import { classifyGitCommand, isProtectedBranch } from "@haril/core";
import type { ApprovalRecord, Store } from "@haril/core/ports";
import { headBranch, worktreeIdentity } from "@haril/git";
import { appendAgentMessage } from "./agent-messages.js";
import type { TurnWorkspace, Workspaces } from "./worktrees.js";

// The requests to a person (feature haril-factory, F7), on the approvals table. While one is open its workflow waits. When
// a person answers, the runtime runs what was granted (a git action, and only that one), tells the agent's parent what
// happened through the message channel, and lifts the workflow's stop once no other request holds it.
// A grant is a decision about one action in the requesting agent's worktree, not a pass to run a stored argv anywhere. It
// never runs in the person's checkout, and it is judged again when it runs: on the branch the worktree stands on then. What
// is refused then is recorded and told to the parent like any other outcome.
// A wait for a person has no time limit. settleWorkflows looks only at running workflows, and the wall time a workflow
// spent waiting is not charged to it when it goes on (workflowActiveMs), so an answer given hours later is never lost.
// Crashes: a decision with nothing to run is applied in one transaction. A granted action is marked applied first and then
// run, so it runs at most once; a crash in between leaves an answered request nobody closed, and recoverHumanRequests,
// at the start of the next runtime, closes it, saying the outcome is unknown, and never runs it again.

const HUMAN_REQUEST_STOP = "human_request";

export interface GitActionResult {
  readonly exitCode: number | null;
  readonly output: string;
}

type GitAction = NonNullable<HumanRequest["action"]>;

export type GitActionRunner = (
  action: GitAction,
  workspace: Pick<TurnWorkspace, "root" | "gitDir">,
  signal?: AbortSignal,
) => Promise<GitActionResult>;

// What applying a grant needs from the runtime.
export interface HumanGrants {
  readonly workspaces?: Workspaces;
  // In place of the pinned runner (tests).
  readonly runner?: GitActionRunner;
  // A runtime that stops ends the action.
  readonly signal?: AbortSignal;
  // The action in flight, so the runtime does not leave while it runs.
  readonly track?: (work: Promise<void>) => void;
}

function pinnedRunner(workspaces: Workspaces): GitActionRunner {
  return async (action, workspace, signal) => {
    const result = await workspaces.runGit(workspace, action.program, action.args, {
      credentials: true,
      ...(signal === undefined ? {} : { signal }),
    });
    return result.ok
      ? { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` }
      : { exitCode: null, output: result.reason };
  };
}

type GrantCheck =
  | { readonly ok: true; readonly workspace: Pick<TurnWorkspace, "root" | "gitDir"> }
  | { readonly ok: false; readonly why: string };

// Where a grant runs, and whether it still may, read now from git and never from what the agent left in its worktree.
async function checkGrant(
  store: Store,
  approval: ApprovalRecord,
  request: HumanRequest,
  action: GitAction,
  workspaces: Workspaces | undefined,
): Promise<GrantCheck> {
  const task = store.workflows
    .tasks(request.workflowId)
    .find((row) => row.taskId === request.taskId);
  const record =
    task === undefined
      ? undefined
      : store.worktrees
          .list({ workflowId: request.workflowId, kind: "executor", state: "active" })
          .find((row) => row.threadId === task.threadId);
  if (record === undefined) {
    return { ok: false, why: "el agente que lo pidió ya no tiene su worktree" };
  }
  const repo = store.projects.list().find((row) => row.projectId === approval.projectId)?.rootPath;
  if (repo === undefined) return { ok: false, why: "su proyecto ya no está registrado" };
  const git = workspaces?.settings.git ?? {};
  const identity = await worktreeIdentity(repo, record.path, git);
  if (identity === undefined) {
    return { ok: false, why: "su worktree ya no es el que HARIL creó" };
  }
  const current = await headBranch(record.path, {
    ...git,
    gitDir: identity.gitDir,
    workTree: record.path,
  });
  if (current !== record.branch) {
    return {
      ok: false,
      why: `su worktree ya no está en ${record.branch}, sino en ${current ?? "un HEAD suelto"}`,
    };
  }
  if (isProtectedBranch(current)) return { ok: false, why: `está en ${current}` };
  const decision = classifyGitCommand(action.program, action.args, current);
  if (decision.level === "forbidden") return { ok: false, why: decision.why };
  const asked = request.reason === "git_publish" ? "publish" : "destructive";
  if (decision.level !== asked) {
    return { ok: false, why: `se pidió como ${asked} y ahora es ${decision.level}` };
  }
  return { ok: true, workspace: { root: record.path, gitDir: identity.gitDir } };
}

function openHumanRequests(store: Pick<Store, "approvals">, workflowId: string): ApprovalRecord[] {
  return store.approvals
    .list({ status: "requested" })
    .filter(
      (approval) =>
        approval.kind === HUMAN_REQUEST_KIND &&
        isHumanRequest(approval.subject) &&
        approval.subject.workflowId === workflowId,
    );
}

// Records the request and stops its workflow. An invalid record is refused here, by the store, with what is missing.
export function raiseHumanRequest(
  store: Store,
  epoch: number,
  input: {
    readonly projectId: string;
    readonly requestedBy: string;
    readonly request: HumanRequest;
  },
):
  | { readonly ok: true; readonly approvalId: string }
  | { readonly ok: false; readonly reason: string } {
  return store.transaction(() => {
    const raised = store.approvals.requestHuman(input);
    if (!raised.ok) return { ok: false, reason: raised.error.message };
    const workflow = store.workflows.get(input.request.workflowId);
    if (workflow?.state === "running") {
      store.workflows.setState(epoch, {
        workflowId: workflow.workflowId,
        state: "awaiting_human",
        reason: HUMAN_REQUEST_STOP,
      });
    }
    return { ok: true, approvalId: raised.value.approval.approvalId };
  });
}

// What became of a granted action; null when there was nothing to run.
type GrantOutcome =
  | { readonly kind: "ran"; readonly ran: GitActionResult }
  | { readonly kind: "refused"; readonly why: string }
  | { readonly kind: "interrupted" }
  | null;

function answerText(
  approval: ApprovalRecord,
  request: HumanRequest,
  outcome: GrantOutcome,
): string {
  const written = approval.reason?.startsWith(WRITTEN_ANSWER_PREFIX)
    ? approval.reason.slice(WRITTEN_ANSWER_PREFIX.length)
    : null;
  if (written !== null) {
    return `La persona respondió a «${request.needs}»: ${written}. La acción pedida no se ejecutó.`;
  }
  if (approval.status === "denied") {
    return `La persona negó «${request.needs}»${approval.reason === null ? "" : `: ${approval.reason}`}. ${request.ifRefused}`;
  }
  if (outcome === null) return `La persona aprobó «${request.needs}».`;
  if (outcome.kind === "refused") {
    return `La persona aprobó «${request.needs}», pero la acción no se ejecutó: ${outcome.why}.`;
  }
  if (outcome.kind === "interrupted") {
    return `La persona aprobó «${request.needs}», pero el runtime se detuvo mientras se aplicaba: no se sabe si llegó a ejecutarse y no se repite. Compruébalo antes de seguir.`;
  }
  return `La persona aprobó «${request.needs}». Resultado (salida ${outcome.ran.exitCode ?? "sin código"}): ${outcome.ran.output.trim().slice(-500)}`;
}

function close(
  store: Store,
  approval: ApprovalRecord,
  request: HumanRequest,
  outcome: GrantOutcome,
): void {
  const workflow = store.workflows.get(request.workflowId);
  if (workflow === undefined) return;
  if (request.notifyThreadId !== null) {
    appendAgentMessage(store, {
      id: randomUUID(),
      workflowId: workflow.workflowId,
      projectId: workflow.projectId,
      threadId: request.notifyThreadId,
      taskId: request.taskId,
      text: answerText(approval, request, outcome),
      urgent: false,
      from: "runtime",
    });
  }
  // The answer lifts the stop this request set, once nothing else holds it. A stop of another kind stays the person's.
  if (
    workflow.state === "awaiting_human" &&
    workflow.stopReason === HUMAN_REQUEST_STOP &&
    openHumanRequests(store, workflow.workflowId).length === 0
  ) {
    store.commands.enqueue({
      type: "workflow.continue",
      projectId: workflow.projectId,
      args: { workflowId: workflow.workflowId, removeStops: [] },
      idempotencyKey: `human-answer-${approval.approvalId}`,
      requestHash: `human-answer-${approval.approvalId}`,
    });
  }
}

function recordGitAction(
  store: Store,
  approval: ApprovalRecord,
  request: HumanRequest,
  action: GitAction,
  outcome: Exclude<GrantOutcome, null>,
): void {
  const workflow = store.workflows.get(request.workflowId);
  store.events.append({
    aggregateType: "task",
    aggregateId: request.taskId,
    type: "git.action",
    actorKind: "system",
    actorId: "runtime",
    payload: {
      workflowId: request.workflowId,
      approvalId: approval.approvalId,
      level: request.reason === "git_publish" ? "publish" : "destructive",
      command: [action.program, ...action.args].join(" "),
      outcome: outcome.kind,
      exitCode: outcome.kind === "ran" ? outcome.ran.exitCode : null,
      output:
        outcome.kind === "ran"
          ? outcome.ran.output.slice(-4000)
          : outcome.kind === "refused"
            ? `No se ejecutó: ${outcome.why}`
            : "El runtime se detuvo mientras se aplicaba: no se sabe si llegó a ejecutarse.",
      ...(outcome.kind === "refused" ? { why: outcome.why } : {}),
      grantedBy: approval.decidedBy,
    },
    ...(workflow === undefined ? {} : { projectId: workflow.projectId }),
    taskId: request.taskId,
  });
}

// Applies one answered request, fenced by its epoch. Answers whether this call applied it. A granted action runs outside
// the loop's turn, and its workflow goes on when it ends.
export function applyHumanRequest(
  store: Store,
  epoch: number,
  approval: ApprovalRecord,
  grants: HumanGrants,
  onDone: () => void,
): boolean {
  const request = isHumanRequest(approval.subject) ? approval.subject : null;
  const action = approval.status === "granted" ? (request?.action ?? null) : null;
  if (request === null || action === null) {
    const marked = store.transaction(() => {
      if (!store.approvals.markApplied(approval.approvalId, epoch)) return false;
      if (request !== null) close(store, approval, request, null);
      return true;
    });
    if (marked) onDone();
    return marked;
  }
  if (!store.approvals.markApplied(approval.approvalId, epoch)) return false;
  const finish = (outcome: Exclude<GrantOutcome, null>): void => {
    store.transaction(() => {
      recordGitAction(store, approval, request, action, outcome);
      close(store, approval, request, outcome);
    });
    onDone();
  };
  const run = async (): Promise<Exclude<GrantOutcome, null>> => {
    const check = await checkGrant(store, approval, request, action, grants.workspaces);
    if (!check.ok) return { kind: "refused", why: check.why };
    const runner =
      grants.runner ?? (grants.workspaces === undefined ? null : pinnedRunner(grants.workspaces));
    if (runner === null) {
      return { kind: "refused", why: "este runtime no tiene worktrees donde ejecutarla" };
    }
    return { kind: "ran", ran: await runner(action, check.workspace, grants.signal) };
  };
  grants.track?.(
    run()
      .catch(
        (error: unknown): Exclude<GrantOutcome, null> => ({
          kind: "ran",
          ran: {
            exitCode: null,
            output: error instanceof Error ? error.message : String(error),
          },
        }),
      )
      .then(finish)
      // An outcome that could not be written stays unclosed: the next start closes it as interrupted.
      .catch(() => undefined),
  );
  return true;
}

function isClosedAction(store: Store, approval: ApprovalRecord, taskId: string): boolean {
  return store.events.list({ aggregateId: taskId }).some((event) => {
    const payload = event.payload as { approvalId?: unknown };
    return event.type === "git.action" && payload.approvalId === approval.approvalId;
  });
}

// At the start of a runtime, before anything runs: the requests a crash left answered and not closed. A granted action
// whose outcome was never written is closed as interrupted, and is not run again: it may have reached the remote. A
// workflow still stopped for requests that are all answered goes on.
export function recoverHumanRequests(store: Store): number {
  let recovered = 0;
  const answered = store.approvals
    .list({ status: "granted" })
    .filter((approval) => approval.kind === HUMAN_REQUEST_KIND && approval.appliedAt !== null);
  for (const approval of answered) {
    if (!isHumanRequest(approval.subject)) continue;
    const request = approval.subject;
    const action = request.action;
    const workflow = store.workflows.get(request.workflowId);
    if (action === null || workflow === undefined) continue;
    if (workflow.state !== "awaiting_human" && workflow.state !== "running") continue;
    if (isClosedAction(store, approval, request.taskId)) continue;
    store.transaction(() => {
      recordGitAction(store, approval, request, action, { kind: "interrupted" });
      close(store, approval, request, { kind: "interrupted" });
    });
    recovered += 1;
  }
  const decided = new Set(
    store.approvals
      .listUnapplied()
      .flatMap((approval) =>
        isHumanRequest(approval.subject) ? [approval.subject.workflowId] : [],
      ),
  );
  for (const workflow of store.workflows.list({ state: "awaiting_human" })) {
    if (workflow.stopReason !== HUMAN_REQUEST_STOP || decided.has(workflow.workflowId)) continue;
    if (openHumanRequests(store, workflow.workflowId).length > 0) continue;
    const key = `human-recover-${workflow.workflowId}-${store.events.list({ aggregateId: workflow.workflowId }).length}`;
    store.commands.enqueue({
      type: "workflow.continue",
      projectId: workflow.projectId,
      args: { workflowId: workflow.workflowId, removeStops: [] },
      idempotencyKey: key,
      requestHash: key,
    });
    recovered += 1;
  }
  return recovered;
}
