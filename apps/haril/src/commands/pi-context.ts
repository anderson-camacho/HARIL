import { closeSync, openSync, readSync, statSync } from "node:fs";
import { sessionFileOf } from "./workflow-tail.js";

// How full a real agent's context is (docs/modos-y-delegacion.md 3.12, 7.6; phase F7): Pi writes each reply to its
// session file (runs/<runId>/pi/*.jsonl, spike S7) with the usage of that request, and the context of a run is its last
// reply's total, as Pi measures it (calculateContextTokens: totalTokens, else input + output + cache reads and writes).
// Only the end of the file is read: a long session never makes a snapshot slow.

const TAIL_BYTES = 512 * 1024;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function contextOfLine(line: string): number | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  const record = entry as { type?: unknown; message?: { role?: unknown; usage?: unknown } } | null;
  if (record?.type !== "message" || record.message?.role !== "assistant") return null;
  const usage = record.message.usage as Record<string, unknown> | undefined;
  if (typeof usage !== "object" || usage === null) return null;
  const total =
    count(usage.totalTokens) ||
    count(usage.input) + count(usage.output) + count(usage.cacheRead) + count(usage.cacheWrite);
  return total > 0 ? total : null;
}

// The context tokens of a run's last reply, or null when the run has no session or no reply with usage yet.
export function piContextUsed(dataDir: string, runId: string): number | null {
  const file = sessionFileOf(dataDir, runId);
  if (file === undefined) return null;
  let text: string;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString("utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const used = contextOfLine((lines[index] as string).trim());
    if (used !== null) return used;
  }
  return null;
}
