// Wire format of the Broker towards the client: the upstream chunks pass through as JSON (the Broker never rebuilds
// them, so tool_calls, finish_reason and usage reach the agent intact); the Broker adds only the framing below.

function dataEvent(data: string): string {
  return `data: ${data}\n\n`;
}

export const DONE_EVENT = dataEvent("[DONE]");

// One upstream chunk, re-emitted as the JSON the upstream sent.
export function chunkEvent(json: unknown): string {
  return dataEvent(JSON.stringify(json));
}

// A stream error after the 200 status: Pi reads `error.message` in this path (ADR-0005 BR-7).
export function errorEvent(type: string, message: string): string {
  return dataEvent(JSON.stringify({ error: { message, type } }));
}

export function errorBody(type: string, message: string): Record<string, unknown> {
  return { error: { type, message } };
}
