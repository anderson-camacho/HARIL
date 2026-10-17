import { describe, expect, it } from "vitest";
import { type FrameFacts, rightColumn } from "../src/frame-view.js";

// The Connect box of the right column (MC-T4): the memory row shows the provider and its health from the store, as
// haril memory status does, and an outbox row appears only while rows wait for delivery. mcp and profile stay M4.

function facts(memory: FrameFacts["memory"]): FrameFacts {
  return {
    project: "demo",
    projectCount: 1,
    rootPath: "/work/demo",
    git: "unknown",
    model: undefined,
    context: undefined,
    tokens: { input: 0, output: 0 },
    runtime: { state: "running", pid: 42, byShell: false, live: true },
    runtimeText: "running (pid 42) · live",
    isolation: "N0",
    approvals: 0,
    projects: ["demo"],
    tasks: "none yet",
    agents: [],
    version: "0.0.0",
    dataDir: "/data",
    theme: "haril-crimson",
    memory,
  };
}

function connectBox(memory: FrameFacts["memory"]): string[] {
  const lines = rightColumn(facts(memory), 200).map((line) =>
    line.map((segment) => segment.text).join(""),
  );
  const top = lines.findIndex((line) => line.startsWith("┌─ Connect"));
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith("└"));
  return lines.slice(top + 1, bottom);
}

describe("the Connect box (MC-T4)", () => {
  it("names the provider and its health, and leaves mcp and profile for M4", () => {
    expect(connectBox({ provider: "null", health: "active", outboxDepth: 0 })).toEqual([
      expect.stringMatching(/^│ memory +null · active +│$/),
      expect.stringMatching(/^│ mcp +not connected \(M4\) +│$/),
      expect.stringMatching(/^│ profile +not connected \(M4\) +│$/),
    ]);
  });

  it("says degraded, blocked or not checked, and counts the rows still to deliver", () => {
    expect(connectBox({ provider: "fake", health: "degraded", outboxDepth: 3 })).toEqual([
      expect.stringMatching(/^│ memory +fake · degraded +│$/),
      expect.stringMatching(/^│ outbox +3 to deliver +│$/),
      expect.stringMatching(/^│ mcp +not connected \(M4\) +│$/),
      expect.stringMatching(/^│ profile +not connected \(M4\) +│$/),
    ]);
    expect(
      connectBox({ provider: "fake", health: "blocked_by_policy", outboxDepth: 0 })[0],
    ).toMatch(/memory +fake · blocked/);
    expect(connectBox({ provider: "null", health: "not_checked", outboxDepth: 0 })[0]).toMatch(
      /memory +null · not checked/,
    );
  });
});
