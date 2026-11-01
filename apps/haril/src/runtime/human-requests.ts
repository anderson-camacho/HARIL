import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  HUMAN_REQUEST_KIND,
  type HumanRequest,
  isHumanRequest,
  WRITTEN_ANSWER_PREFIX,
} from "@haril/contracts";
import type { ApprovalRecord, Store } from "@haril/core/ports";
import { appendAgentMessage } from "./agent-messages.js";

// The requests to a person (feature haril-factory, F7), on the approvals table. While one is open its workflow waits. When
// a person answers, the runtime runs what was granted (a git action, and only that one), tells the agent's parent what
// happened through the message channel, and lifts the workflow's stop once no other request holds it.

export const HUMAN_REQUEST_STOP = "human_request";

const OUTPUT_MAX_CHARS = 4000;
const GIT_ACTION_TIMEOUT_MS = 10 * 60_000;

export interface GitActionResult {
  readonly exitCode: number | null;
  readonly output: string;
}

export type GitActionRunner = (
  action: NonNullable<HumanRequest["action"]>,
  cwd: string,
) => Promise<GitActionResult>;

// A push needs the person's credentials, so unlike an agent's command this keeps the environment. It runs only after a
// person granted exactly this argv; the Core already refused anything that merges or pushes to main.
export const runGitAction: GitActionRunner = (action, cwd) =>
  new Promise((resolve) => {
    let output = "";
    const child = spawn(action.program, action.args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill(), GIT_ACTION_TIMEOUT_MS);
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString("utf8")}`.slice(-OUTPUT_MAX_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output });
    });
  });

export function openHumanRequests(
  store: Pick<Store, "approvals">,
  workflowId: string,
): ApprovalRecord[] {
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
}

function answerText(
  approval: ApprovalRecord,
  request: HumanRequest,
  ran: GitActionResult | null,
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
  if (ran === null) return `La persona aprobó «${request.needs}».`;
  return `La persona aprobó «${request.needs}». Resultado (salida ${ran.exitCode ?? "sin código"}): ${ran.output.trim().slice(-500)}`;
}

function close(
  store: Store,
  approval: ApprovalRecord,
  request: HumanRequest,
  ran: GitActionResult | null,
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
      text: answerText(approval, request, ran),
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

// Applies one answered request. A granted action runs outside the loop's turn, and its workflow goes on when it ends.
export function applyHumanRequest(
  store: Store,
  approval: ApprovalRecord,
  runner: GitActionRunner,
  cwdOf: (projectId: string) => string | undefined,
  onDone: () => void,
): void {
  if (!isHumanRequest(approval.subject)) return;
  const request = approval.subject;
  const action = approval.status === "granted" ? request.action : null;
  const cwd = cwdOf(approval.projectId);
  if (action === null || cwd === undefined) {
    close(store, approval, request, null);
    onDone();
    return;
  }
  void runner(action, cwd)
    .catch(
      (error: unknown): GitActionResult => ({
        exitCode: null,
        output: error instanceof Error ? error.message : String(error),
      }),
    )
    .then((ran) => {
      const workflow = store.workflows.get(request.workflowId);
      store.events.append({
        aggregateType: "task",
        aggregateId: request.taskId,
        type: "git.action",
        actorKind: "system",
        actorId: "runtime",
        payload: {
          workflowId: request.workflowId,
          level: request.reason === "git_publish" ? "publish" : "destructive",
          command: [action.program, ...action.args].join(" "),
          exitCode: ran.exitCode,
          output: ran.output,
          grantedBy: approval.decidedBy,
        },
        ...(workflow === undefined ? {} : { projectId: workflow.projectId }),
        taskId: request.taskId,
      });
      close(store, approval, request, ran);
      onDone();
    });
}
