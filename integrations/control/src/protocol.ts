// The wire format of the control channel: one JSON object per line, UTF-8. Every line is validated as a whole: a
// message with unknown or malformed fields is a protocol error, and the peer that sent it is disconnected.

// A line longer than this is a protocol error. Real messages are a few dozen bytes.
const MAX_LINE_BYTES = 4096;

export type ClientMessage =
  | { readonly type: "hello"; readonly token: string; readonly subscribe: boolean }
  | { readonly type: "nudge" };

export type ServerMessage =
  | { readonly type: "ready" }
  | { readonly type: "wake"; readonly seq: number }
  | {
      readonly type: "event";
      readonly eventType: string;
      readonly taskId?: string;
      readonly seq: number;
    };

export function encodeLine(message: ClientMessage | ServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

// Splits the stream into complete lines. A partial line waits for its newline; one longer than the limit throws.
export class LineReader {
  private pending = "";

  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    const lines = parts.filter((line) => line.trim() !== "");
    const tooLong = [this.pending, ...lines].some(
      (line) => Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES,
    );
    if (tooLong) throw new Error("control line too long");
    return lines;
  }
}

export function parseClientMessage(line: string): ClientMessage | undefined {
  const value = parseObject(line);
  if (value === undefined) return undefined;
  if (value.type === "nudge") return { type: "nudge" };
  if (value.type !== "hello") return undefined;
  if (typeof value.token !== "string") return undefined;
  if (value.subscribe !== undefined && typeof value.subscribe !== "boolean") return undefined;
  return { type: "hello", token: value.token, subscribe: value.subscribe === true };
}

export function parseServerMessage(line: string): ServerMessage | undefined {
  const value = parseObject(line);
  if (value === undefined) return undefined;
  if (value.type === "ready") return { type: "ready" };
  if (value.type === "wake" && typeof value.seq === "number") {
    return { type: "wake", seq: value.seq };
  }
  if (
    value.type === "event" &&
    typeof value.eventType === "string" &&
    typeof value.seq === "number"
  ) {
    const taskId = typeof value.taskId === "string" ? value.taskId : undefined;
    return taskId === undefined
      ? { type: "event", eventType: value.eventType, seq: value.seq }
      : { type: "event", eventType: value.eventType, taskId, seq: value.seq };
  }
  return undefined;
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
