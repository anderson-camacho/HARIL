// Wire format of the Broker towards Pi: OpenAI chat completions, streamed or not. Everything here is rebuilt
// from the normalized upstream events, so no upstream bytes reach the client as they were received.

export interface ReplyContext {
  readonly id: string;
  readonly created: number;
  readonly model: string;
}

export interface UsageCounts {
  readonly prompt: number;
  readonly completion: number;
}

const DONE = "[DONE]";

function dataEvent(data: string): string {
  return `data: ${data}\n\n`;
}

export const DONE_EVENT = dataEvent(DONE);

export function contentEvent(context: ReplyContext, delta: string): string {
  return dataEvent(
    JSON.stringify({
      id: context.id,
      object: "chat.completion.chunk",
      created: context.created,
      model: context.model,
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
    }),
  );
}

export function finishEvent(context: ReplyContext, finishReason: string): string {
  return dataEvent(
    JSON.stringify({
      id: context.id,
      object: "chat.completion.chunk",
      created: context.created,
      model: context.model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    }),
  );
}

export function usageEvent(context: ReplyContext, usage: UsageCounts): string {
  return dataEvent(
    JSON.stringify({
      id: context.id,
      object: "chat.completion.chunk",
      created: context.created,
      model: context.model,
      choices: [],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
      },
    }),
  );
}

// A stream error after the 200 status: Pi reads `error.message` in this path (ADR-0005 BR-7).
export function errorEvent(type: string, message: string): string {
  return dataEvent(JSON.stringify({ error: { message, type } }));
}

export function completion(
  context: ReplyContext,
  text: string,
  finishReason: string,
  usage: UsageCounts | undefined,
): Record<string, unknown> {
  return {
    id: context.id,
    object: "chat.completion",
    created: context.created,
    model: context.model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason },
    ],
    ...(usage === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            total_tokens: usage.prompt + usage.completion,
          },
        }),
  };
}

export function errorBody(type: string, message: string): Record<string, unknown> {
  return { error: { type, message } };
}
