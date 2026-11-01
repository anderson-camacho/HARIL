import type { DelegationMessageView, Store } from "@haril/core/ports";
import type { Task, WorkflowView } from "./workflow-view.js";

// A person's messages to an agent (feature haril-factory, F7), kept as events of its workflow, so they outlive a restart:
// agent.message when written, agent.message.delivered when a turn's prompt carried it, agent.message.applied when that
// turn closed. One attempt takes one prompt (integrations/agent-pi: "a run takes one prompt", agent.prompt_repeated), so a
// message reaches the agent at the next turn boundary, or at once with --urgent, which stops the attempt and resumes it
// with the message.

export type MessageState = "waiting" | "delivered" | "applied";

export interface AgentMessage {
  readonly id: string;
  readonly threadId: string;
  readonly text: string;
  readonly urgent: boolean;
  readonly from: string;
  readonly at: number;
  readonly state: MessageState;
}

export function appendAgentMessage(
  store: Pick<Store, "events">,
  input: {
    readonly id: string;
    readonly workflowId: string;
    readonly projectId: string;
    readonly threadId: string;
    readonly taskId: string;
    readonly text: string;
    readonly urgent: boolean;
    readonly from: string;
  },
): void {
  store.events.append({
    aggregateType: "workflow",
    aggregateId: input.workflowId,
    type: "agent.message",
    actorKind: input.from === "runtime" ? "system" : "user",
    actorId: input.from,
    payload: {
      workflowId: input.workflowId,
      messageId: input.id,
      threadId: input.threadId,
      text: input.text,
      urgent: input.urgent,
    },
    projectId: input.projectId,
    taskId: input.taskId,
  });
}

// Every message of a workflow, oldest first, with how far it got.
export function agentMessages(store: Pick<Store, "events">, workflowId: string): AgentMessage[] {
  const events = store.events.list({ aggregateId: workflowId });
  const delivered = new Set<string>();
  const applied = new Set<string>();
  for (const event of events) {
    const id = (event.payload as { messageId?: unknown }).messageId;
    if (typeof id !== "string") continue;
    if (event.type === "agent.message.delivered") delivered.add(id);
    if (event.type === "agent.message.applied") applied.add(id);
  }
  return events.flatMap((event) => {
    if (event.type !== "agent.message") return [];
    const payload = event.payload as {
      messageId?: unknown;
      threadId?: unknown;
      text?: unknown;
      urgent?: unknown;
    };
    if (
      typeof payload.messageId !== "string" ||
      typeof payload.threadId !== "string" ||
      typeof payload.text !== "string"
    ) {
      return [];
    }
    return [
      {
        id: payload.messageId,
        threadId: payload.threadId,
        text: payload.text,
        urgent: payload.urgent === true,
        from: event.actorId,
        at: event.ts,
        state: applied.has(payload.messageId)
          ? ("applied" as const)
          : delivered.has(payload.messageId)
            ? ("delivered" as const)
            : ("waiting" as const),
      },
    ];
  });
}

export function waitingMessages(
  store: Pick<Store, "events">,
  workflowId: string,
  threadId: string,
): AgentMessage[] {
  return agentMessages(store, workflowId).filter(
    (message) => message.threadId === threadId && message.state === "waiting",
  );
}

// The messages this turn's prompt carries; each is marked delivered with the turn's run.
export function deliverMessages(
  store: Pick<Store, "events">,
  view: WorkflowView,
  task: Task,
  runId: string,
): DelegationMessageView[] {
  // A message an attempt read and did not finish with (it was stopped) is read again by the next one.
  const messages = agentMessages(store, view.workflow.workflowId).filter(
    (message) => message.threadId === task.threadId && message.state !== "applied",
  );
  for (const message of messages) {
    if (message.state === "waiting") {
      mark(store, view, task, "agent.message.delivered", message.id, runId);
    }
  }
  return messages.map(({ id, text, urgent }) => ({ id, text, urgent }));
}

// The turn that read them closed: what it carried was applied.
export function applyDeliveredMessages(
  store: Pick<Store, "events">,
  view: WorkflowView,
  task: Task,
  runId: string,
): void {
  for (const message of agentMessages(store, view.workflow.workflowId)) {
    if (message.threadId === task.threadId && message.state === "delivered") {
      mark(store, view, task, "agent.message.applied", message.id, runId);
    }
  }
}

function mark(
  store: Pick<Store, "events">,
  view: WorkflowView,
  task: Task,
  type: string,
  messageId: string,
  runId: string,
): void {
  store.events.append({
    aggregateType: "workflow",
    aggregateId: view.workflow.workflowId,
    type,
    actorKind: "system",
    actorId: "runtime",
    payload: { workflowId: view.workflow.workflowId, messageId, runId },
    projectId: view.workflow.projectId,
    taskId: task.taskId,
  });
}
