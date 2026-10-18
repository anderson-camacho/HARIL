import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type RenderedBlock, UNICODE_GLYPHS } from "../src/orchestration-draw.js";
import { parseSnapshotLine, parseTailLine, type TailLine } from "../src/orchestration-feed.js";
import {
  initialOrchestrationState,
  type OrchestrationState,
  orchestrationKey,
  reduceOrchestration,
} from "../src/orchestration-state.js";
import type { WorkflowSnapshot } from "../src/orchestration-types.js";
import {
  DEMO_LABEL,
  LIVE_NO_CONTENT,
  renderLiveView,
  renderOrchestrationSummary,
  renderOrchestrationView,
} from "../src/orchestration-view.js";
import { stripAnsi, textWidth } from "../src/text.js";

// The ORCHESTRATION view on real data (spec 7.6 to 7.9, phase F5b). The fixtures were printed by the real haril CLI on
// a scratch store: `haril workflow show --json` of a fake-agent workflow waiting at after_plan and of the same workflow
// completed, and `haril workflow tail --json` of one node whose run has a Pi session (spike S7's format). The view draws
// what they hold and nothing of the demo; a value they do not have is drawn as n/a.

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = 1_800_000_000_000;

function fixture(name: string): string {
  return readFileSync(join(HERE, "fixtures", name), "utf8");
}

function snapshot(name: string): WorkflowSnapshot {
  const parsed = parseSnapshotLine(JSON.stringify(JSON.parse(fixture(name))));
  if (parsed === undefined) throw new Error(`${name} is not a snapshot`);
  return parsed;
}

function tailLines(): TailLine[] {
  return fixture("tail-e1.jsonl")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parsed = parseTailLine(line);
      if (parsed === undefined) throw new Error(`not a tail line: ${line}`);
      return parsed;
    });
}

function real(name: string): OrchestrationState {
  return reduceOrchestration(initialOrchestrationState(), {
    type: "real-snapshot",
    snapshot: snapshot(name),
    now: NOW,
  }).state;
}

function text(block: RenderedBlock): string {
  return block.lines.map((line) => stripAnsi(line)).join("\n");
}

function expectFits(block: RenderedBlock, width: number): void {
  for (const line of block.lines) expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
}

function select(state: OrchestrationState, id: string): OrchestrationState {
  return reduceOrchestration(state, { type: "select-node", id }).state;
}

// Strings only the demo's sample data holds (orchestration-demo.ts): none may show on a real workflow.
const DEMO_ONLY = [
  DEMO_LABEL,
  "Change the primary button color",
  "tintColor",
  "Button.tsx",
  "mid-model",
  "fast-model",
  "auditor-model",
  "account 1",
  "Simulate watchdog",
];

describe("ORCHESTRATION on a real workflow", () => {
  it("draws the workflow the CLI printed, wide and compact, with no demo value", () => {
    const completed = snapshot("snapshot-completed.json");
    const state = real("snapshot-completed.json");
    for (const [width, height] of [
      [140, 45],
      [80, 30],
    ] as const) {
      const block = renderOrchestrationView(state, width, height, UNICODE_GLYPHS);
      expectFits(block, width);
      const drawn = text(block);
      expect(drawn).toContain(completed.workflow.id);
      expect(drawn).toContain("Summarize the notes");
      expect(drawn).toContain("Executor 1");
      expect(drawn).toContain("Final auditor");
      for (const value of DEMO_ONLY) expect(drawn).not.toContain(value);
    }
    const summary = text(renderOrchestrationSummary(state, 76, 8, UNICODE_GLYPHS));
    expect(summary).toContain(completed.workflow.id);
    for (const value of DEMO_ONLY) expect(summary).not.toContain(value);
  });

  it("shows the detail the snapshot has, and n/a for what it does not have", () => {
    const state = select(real("snapshot-completed.json"), "e1");
    const drawn = text(renderOrchestrationView(state, 140, 45, UNICODE_GLYPHS));
    expect(drawn).toMatch(/Model\s+fake\/high-model · level n\/a/);
    expect(drawn).toMatch(/Writes\s+src\/part-1\/shared\.ts/);
    expect(drawn).toMatch(/Difficulty\s+easy · edits one shared file/);
    expect(drawn).toMatch(/Context\s+n\/a/);
    expect(drawn).toMatch(/5h\s+n\/a/);
    expect(drawn).toMatch(/Weekly\s+n\/a/);
    expect(drawn).toMatch(/Audit\s+approved · 2 of 2 criteria met/);
    expect(drawn).toMatch(/Next check\s+n\/a/);
    expect(drawn).toMatch(/Memo\s+n\/a/);
  });

  it("follows the next snapshot and keeps the selection on its node", () => {
    let state = select(real("snapshot-awaiting.json"), "d1");
    expect(text(renderOrchestrationView(state, 140, 45, UNICODE_GLYPHS))).toContain("awaiting you");
    state = reduceOrchestration(state, {
      type: "real-snapshot",
      snapshot: snapshot("snapshot-completed.json"),
      now: NOW + 5000,
    }).state;
    expect(state.selectedNodeId).toBe("d1");
    expect(state.clock).toBe(NOW + 5000);
    expect(text(renderOrchestrationView(state, 140, 45, UNICODE_GLYPHS))).toContain("completed");
  });

  it("keeps the real workflow aside while the demo shows, and brings it back", () => {
    const id = snapshot("snapshot-completed.json").workflow.id;
    let state = real("snapshot-completed.json");
    state = reduceOrchestration(state, { type: "toggle-demo", now: NOW }).state;
    const demo = text(renderOrchestrationView(state, 140, 45, UNICODE_GLYPHS));
    expect(demo).toContain(DEMO_LABEL);
    expect(demo).not.toContain(id);
    // A snapshot that arrives during the demo waits; it never mixes into the demo's data.
    state = reduceOrchestration(state, {
      type: "real-snapshot",
      snapshot: snapshot("snapshot-awaiting.json"),
      now: NOW + 1000,
    }).state;
    expect(text(renderOrchestrationView(state, 140, 45, UNICODE_GLYPHS))).toContain(DEMO_LABEL);
    state = reduceOrchestration(state, { type: "toggle-demo", now: NOW }).state;
    const back = text(renderOrchestrationView(state, 140, 45, UNICODE_GLYPHS));
    expect(back).not.toContain(DEMO_LABEL);
    expect(back).toContain("awaiting you");
  });

  it("offers the choice of the workflow, and P asks the console for it", () => {
    let state = real("snapshot-completed.json");
    state = reduceOrchestration(state, {
      type: "workflows",
      rows: [{ id: "wf-a", state: "completed", goal: "A", createdAt: 1, stopReason: null }],
    }).state;
    const block = renderOrchestrationView(state, 140, 45, UNICODE_GLYPHS);
    expect(text(block)).toContain("[P Pick workflow]");
    expect(block.hits.some((hit) => hit.target.kind === "pick")).toBe(true);
    expect(orchestrationKey(state, "p", NOW)).toMatchObject({
      handled: true,
      effect: "pick-workflow",
    });
    // No workflow listed any more: the real view empties.
    state = reduceOrchestration(state, { type: "workflows", rows: [] }).state;
    expect(state.snapshot).toBeUndefined();
    expect(text(renderOrchestrationView(state, 80, 24, UNICODE_GLYPHS))).toContain(
      "No workflows yet. Use /delegate to start one.",
    );
  });
});

describe("the live view of a real agent", () => {
  it("takes its lines from haril workflow tail, never from the demo transcript", () => {
    let state = select(real("snapshot-completed.json"), "e1");
    state = reduceOrchestration(state, { type: "toggle-live" }).state;
    state = reduceOrchestration(state, { type: "tail", nodeId: "e1", lines: tailLines() }).state;
    for (const [width, height] of [
      [140, 45],
      [80, 30],
    ] as const) {
      const block = renderLiveView(state, width, height, UNICODE_GLYPHS);
      expectFits(block, width);
      const drawn = text(block);
      expect(drawn).toContain("LIVE · Executor 1 e1");
      expect(drawn).toContain("Activity (Pi session)");
      expect(drawn).toContain('read {"path":"src/part-1/shared.ts"}');
      expect(drawn).toContain("in 1210 · out 48");
      expect(drawn).toContain("Done: the part exports one constant.");
      expect(drawn).toContain("progress: completed");
      for (const value of DEMO_ONLY) expect(drawn).not.toContain(value);
    }
  });

  it("shows only the newest lines that fit, and another node's lines never", () => {
    let state = select(real("snapshot-completed.json"), "e1");
    state = reduceOrchestration(state, { type: "toggle-live" }).state;
    const many = Array.from(
      { length: 80 },
      (_, index): TailLine => ({ at: NOW + index, kind: "assistant", text: `line ${index}` }),
    );
    state = reduceOrchestration(state, { type: "tail", nodeId: "e1", lines: many }).state;
    const drawn = text(renderLiveView(state, 80, 24, UNICODE_GLYPHS));
    expect(drawn).toContain("line 79");
    expect(drawn).not.toContain("line 10 ");
    const other = select(state, "e2");
    expect(text(renderLiveView(other, 80, 24, UNICODE_GLYPHS))).toContain("Content not available");
  });

  it("says content not available when no session was read", () => {
    let state = select(real("snapshot-awaiting.json"), "o1");
    state = reduceOrchestration(state, { type: "toggle-live" }).state;
    const drawn = text(renderLiveView(state, 80, 24, UNICODE_GLYPHS)).replace(/\s+/g, " ");
    expect(drawn).toContain(LIVE_NO_CONTENT);
    expect(drawn).toContain("LIVE · Orchestrator 1 o1");
  });
});
