import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { piContextUsed } from "../src/commands/pi-context.js";

// How full a real agent's context is (phase F7): the last reply's usage in its Pi session file, as Pi counts it.

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "haril-pi-context-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function session(runId: string, lines: unknown[]): void {
  const dir = join(dataDir, "runs", runId, "pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-10-18T10-00-00_s1.jsonl"),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
}

describe("a real run's context", () => {
  it("is its last reply's total, or input, output and cache when Pi gave no total", () => {
    session("run-1", [
      { type: "session", id: "s1" },
      { type: "message", message: { role: "assistant", usage: { totalTokens: 1_200 } } },
      { type: "message", message: { role: "toolResult", content: "..." } },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 40_000, output: 900, cacheRead: 2_000, cacheWrite: 100 },
        },
      },
    ]);
    expect(piContextUsed(dataDir, "run-1")).toBe(43_000);
  });

  it("is unknown without a session or a reply with usage", () => {
    expect(piContextUsed(dataDir, "run-none")).toBeNull();
    session("run-2", [{ type: "session", id: "s2" }, "not json"]);
    expect(piContextUsed(dataDir, "run-2")).toBeNull();
  });
});
