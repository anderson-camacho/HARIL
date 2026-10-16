// Token estimates are documented upper bounds (ADR-0005 BR-5): UTF-8 bytes divided by 3, rounded up. They are
// deliberately conservative; the upstream usage replaces them when it arrives.
export function tokensForBytes(bytes: number): number {
  return Math.ceil(bytes / 3);
}

// In-flight guard only (BR-7): the Broker already caps max_tokens upstream, so this check catches an upstream that
// ignores the cap. Bytes / 4 (about one token per English word piece) avoids cutting honest streams at ~75% of their
// cap; settlement still uses the conservative bound above when usage is missing, and records any small overrun.
export function streamedOutputTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

// The input is the serialized messages and tools: the framing counts too, so the bound holds.
export function estimateInputTokens(messages: readonly unknown[], tools?: unknown): number {
  const messageBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  const toolBytes = tools === undefined ? 0 : Buffer.byteLength(JSON.stringify(tools), "utf8");
  return tokensForBytes(messageBytes + toolBytes);
}
