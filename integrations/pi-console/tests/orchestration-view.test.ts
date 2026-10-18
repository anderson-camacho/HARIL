import { describe, expect, it } from "vitest";
import {
  ASCII_GLYPHS,
  orchestrationGlyphs,
  type RenderedBlock,
  UNICODE_GLYPHS,
} from "../src/orchestration-draw.js";
import {
  initialOrchestrationState,
  ORCHESTRATION_VIEWS,
  type OrchestrationState,
  orchestrationClick,
  reduceOrchestration,
} from "../src/orchestration-state.js";
import {
  renderLiveView,
  renderOrchestrationSummary,
  renderOrchestrationView,
} from "../src/orchestration-view.js";
import { stripAnsi, textWidth } from "../src/text.js";

// The renderers are pure: a state, a size and a glyph set in, lines and hit-boxes out. Every line must fit the width
// Pi renders at, because Pi's TUI does not cut a line that is wider than the terminal.

const NOW = 1_800_000_000_000;
const UNICODE_STATE_GLYPHS = ["●", "○", "✓", "✗", "■", "‖", "→"];
const SIZES = [
  { width: 80, height: 24 },
  { width: 140, height: 45 },
  { width: 140, height: 30 },
] as const;

function demoState(): OrchestrationState {
  return reduceOrchestration(initialOrchestrationState(), { type: "toggle-demo", now: NOW }).state;
}

function plain(block: RenderedBlock): string[] {
  return block.lines.map((line) => stripAnsi(line));
}

function select(state: OrchestrationState, id: string): OrchestrationState {
  return orchestrationClick(state, { kind: "node", id }, NOW, "view").state;
}

function lineWith(lines: readonly string[], text: string): string {
  const found = lines.find((line) => line.includes(text));
  if (found === undefined) throw new Error(`no line contains ${text}`);
  return found;
}

function expectFits(block: RenderedBlock, width: number): void {
  for (const line of plain(block)) expect(textWidth(line)).toBeLessThanOrEqual(width);
  for (const hit of block.hits) {
    expect(hit.start).toBeGreaterThanOrEqual(0);
    expect(hit.end).toBeLessThanOrEqual(width);
    expect(hit.end).toBeGreaterThan(hit.start);
    expect(hit.row).toBeLessThan(block.lines.length);
  }
}

function hitText(block: RenderedBlock, index: number): string {
  const hit = block.hits[index];
  if (hit === undefined) throw new Error("no hit");
  return stripAnsi(block.lines[hit.row] ?? "").slice(hit.start, hit.end);
}

describe("orchestration full view", () => {
  for (const { width, height } of SIZES) {
    it(`fits ${width}x${height} in every view, in Unicode and ASCII`, () => {
      for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
        let state = demoState();
        for (const view of ORCHESTRATION_VIEWS) {
          state = orchestrationClick(state, { kind: "view", view }, NOW, "view").state;
          const block = renderOrchestrationView(state, width, height, glyphs);
          expect(block.lines).toHaveLength(height);
          expectFits(block, width);
        }
      }
    });
  }

  it("shows the views, the metrics, the stop button, the key hints and the DEMO label", () => {
    for (const { width, height } of SIZES) {
      const text = plain(renderOrchestrationView(demoState(), width, height, UNICODE_GLYPHS)).join(
        "\n",
      );
      for (const label of ["Tree", "Queue", "Quota", "Log", "Stop all", "Esc", "wf_ab12"])
        expect(text).toContain(label);
      expect(text).toMatch(/By layer|Layers/);
      expect(text).toContain("DEMO · sample data, not real");
      expect(text).toMatch(/138k/);
      expect(text).toMatch(/3 of 5|3\/5/);
      expect(text).toMatch(/Queued 3|queued 3/);
    }
  });

  it("marks every state with a glyph and a text, never color only", () => {
    const lines = plain(renderOrchestrationView(demoState(), 140, 45, UNICODE_GLYPHS));
    expect(lineWith(lines, "o1 Orchestrator")).toMatch(/○ o1 Orchestrator.*waiting for children/);
    expect(lineWith(lines, "d1 Delegator 1")).toMatch(/● d1 Delegator 1.*working/);
    expect(lineWith(lines, "e3 Executor")).toMatch(/✓ e3 Executor.*done/);
    expect(lineWith(lines, "a1 Auditor")).toMatch(/○ a1 Auditor.*queued/);
    expect(lineWith(lines, "e5 Executor")).toMatch(/● e5 Executor.*17 min without activity/);

    const after = reduceOrchestration(demoState(), { type: "simulate-watchdog" }).state;
    const closed = plain(renderOrchestrationView(after, 140, 45, UNICODE_GLYPHS));
    expect(lineWith(closed, "e5 Executor")).toMatch(/✗ e5 Executor.*closed: no progress/);
    const stopped = reduceOrchestration(demoState(), { type: "stop-all" }).state;
    const cancelled = plain(renderOrchestrationView(stopped, 140, 45, UNICODE_GLYPHS));
    expect(lineWith(cancelled, "d1 Delegator 1")).toMatch(/■ d1 Delegator 1.*cancelled/);
  });

  it("shows the selected node's detail: goal, model, files, difficulty, context, quota, progress, check, memo", () => {
    for (const { width, height } of SIZES) {
      const state = select(demoState(), "d1");
      const text = plain(renderOrchestrationView(state, width, height, UNICODE_GLYPHS)).join("\n");
      expect(text).toContain("Primary button: color and states");
      expect(text).toMatch(/Model\s+mid-model · high \(from parent\)/);
      expect(text).toMatch(/Difficulty\s+medium · three files/);
      expect(text).toMatch(/Context\s+41k of 300k/);
      expect(text).toMatch(/5h\s+38%/);
      expect(text).toMatch(/Weekly\s+52%/);
      expect(text).toMatch(/Progress\s+9 s ago · assigned 3 executors/);
      expect(text).toMatch(/Next check\s+in 12 min/);
      expect(text).toMatch(/Memo\s+Integrate e1, e2 and e3/);
      expect(text).toMatch(/Reads\s+src\/theme\.ts/);
    }
  });

  it("draws the context bar and the 80% mark on the quota bars", () => {
    const text = plain(
      renderOrchestrationView(select(demoState(), "d2"), 140, 45, UNICODE_GLYPHS),
    ).join("\n");
    expect(text).toMatch(/Context\s+33k of 300k\s+▰▱{9}/);
    expect(text).toMatch(/5h\s+83%\s+▰{8}│▰▱/);
    expect(text).toMatch(/Weekly\s+41%\s+▰{4}▱{4}│▱▱/);
  });

  it("says n/a for a quota without data and never invents a value", () => {
    const text = plain(
      renderOrchestrationView(select(demoState(), "e1"), 140, 45, UNICODE_GLYPHS),
    ).join("\n");
    expect(text).toMatch(/5h\s+n\/a/);
    expect(text).toMatch(/Weekly\s+n\/a/);
    expect(text).toMatch(/Audit\s+n\/a/);
  });

  it("shows the audit of a finished node and the queue reason of a waiting one", () => {
    const done = plain(
      renderOrchestrationView(select(demoState(), "e3"), 140, 45, UNICODE_GLYPHS),
    ).join("\n");
    expect(done).toMatch(/Audit\s+approved · approved after 1 retry/);
    const queued = plain(
      renderOrchestrationView(select(demoState(), "e2"), 140, 45, UNICODE_GLYPHS),
    );
    expect(queued.join("\n")).toMatch(/depends on e1/);
  });

  it("shows the recent events newest first", () => {
    const text = plain(renderOrchestrationView(demoState(), 140, 45, UNICODE_GLYPHS));
    expect(lineWith(text, "Events")).toMatch(
      /delegation\.applied d1 \(3\) · audit\.verdict a3 approved · watchdog\.checked e4 active/,
    );
  });

  it("renders the quota and log views with their rows", () => {
    const quota = orchestrationClick(demoState(), { kind: "view", view: "quota" }, NOW, "view");
    const quotaText = plain(renderOrchestrationView(quota.state, 140, 45, UNICODE_GLYPHS));
    expect(lineWith(quotaText, "claude · account 2")).toMatch(/83%/);
    expect(lineWith(quotaText, "codex · account 1")).toMatch(/n\/a/);

    const log = orchestrationClick(demoState(), { kind: "filter", filter: "chat" }, NOW, "view");
    const logText = plain(renderOrchestrationView(log.state, 80, 24, UNICODE_GLYPHS)).join("\n");
    expect(logText).toContain("question about e5");
    expect(logText).not.toContain("delegated to 2 threads");
  });

  it("maps every hit-box to the label drawn under it", () => {
    for (const { width, height } of SIZES) {
      const block = renderOrchestrationView(
        select(demoState(), "e3"),
        width,
        height,
        UNICODE_GLYPHS,
      );
      const viewHit = block.hits.findIndex(
        (hit) => hit.target.kind === "view" && hit.target.view === "quota",
      );
      expect(hitText(block, viewHit)).toContain("Quota");
      const stopHit = block.hits.findIndex((hit) => hit.target.kind === "stop");
      expect(hitText(block, stopHit)).toContain("Stop all");
      const closeHit = block.hits.findIndex((hit) => hit.target.kind === "close");
      expect(hitText(block, closeHit)).toContain("Close");
      const rowHit = block.hits.findIndex(
        (hit) => hit.target.kind === "node" && hit.target.id === "e3",
      );
      expect(hitText(block, rowHit)).toContain("e3");
      for (const kind of ["live", "demo", "watchdog", "reset", "filter"])
        expect(block.hits.some((hit) => hit.target.kind === kind)).toBe(true);
    }
  });

  it("shows an honest empty state without a workflow", () => {
    const block = renderOrchestrationView(initialOrchestrationState(), 80, 24, UNICODE_GLYPHS);
    expectFits(block, 80);
    const text = plain(block).join("\n");
    expect(text).toContain("No workflows yet.");
    expect(text).not.toMatch(/DEMO|wf_ab12|138k|e5/);
    expect(block.hits.some((hit) => hit.target.kind === "demo")).toBe(true);
    expect(block.hits.some((hit) => hit.target.kind === "close")).toBe(true);
  });
});

describe("orchestration panel summary", () => {
  it("keeps the DEMO label visible at narrow widths, in the summary and the compact view", () => {
    for (const width of [60, 40]) {
      const summary = renderOrchestrationSummary(demoState(), width, 4, UNICODE_GLYPHS);
      expectFits(summary, width);
      expect(plain(summary).join("\n")).toContain("DEMO · sample data, not real");
      const compact = renderOrchestrationView(demoState(), width, 24, UNICODE_GLYPHS);
      expectFits(compact, width);
      expect(plain(compact).join("\n")).toContain("DEMO · sample data, not real");
    }
  });

  it("fits the module width and the line budget it is given", () => {
    for (const width of [76, 136]) {
      for (const maxLines of [3, 4, 8]) {
        const block = renderOrchestrationSummary(demoState(), width, maxLines, UNICODE_GLYPHS);
        expect(block.lines.length).toBeLessThanOrEqual(maxLines);
        expectFits(block, width);
      }
    }
  });

  it("shows the header metrics, the view buttons, open and stop, and a compact tree", () => {
    const block = renderOrchestrationSummary(demoState(), 76, 8, UNICODE_GLYPHS);
    const text = plain(block).join("\n");
    expect(text).toContain("DEMO · sample data, not real");
    expect(text).toMatch(/138k/);
    expect(text).toMatch(/exec 3\/5|Executors 3 of 5/);
    expect(text).toMatch(/aud 0\/5|Auditors 0 of 5/);
    expect(text).toMatch(/agents 11\/100|Agents 11 of 100/);
    expect(text).toContain("o1 Orchestrator");
    for (const kind of ["view", "open", "stop", "node"])
      expect(block.hits.some((hit) => hit.target.kind === kind)).toBe(true);
    const openHit = block.hits.findIndex((hit) => hit.target.kind === "open");
    expect(hitText(block, openHit)).toContain("Open full view");
    const stopHit = block.hits.findIndex((hit) => hit.target.kind === "stop");
    expect(hitText(block, stopHit)).toContain("■ Stop all");
    const rowHit = block.hits.findIndex((hit) => hit.target.kind === "node");
    expect(hitText(block, rowHit)).toContain("o1");
    expect(block.hits.filter((hit) => hit.target.kind === "view")).toHaveLength(5);
  });

  it("empty state shows the honest message and no demo numbers", () => {
    const block = renderOrchestrationSummary(initialOrchestrationState(), 76, 8, UNICODE_GLYPHS);
    expectFits(block, 76);
    const text = plain(block).join("\n");
    expect(text).toContain("No workflows yet. Use /delegate to start one.");
    expect(text).not.toMatch(/DEMO|wf_ab12|138k|11\/100|Executors/);
    expect(block.hits.some((hit) => hit.target.kind === "node")).toBe(false);
    expect(block.hits.some((hit) => hit.target.kind === "open")).toBe(true);
    expect(block.hits.some((hit) => hit.target.kind === "stop")).toBe(true);
  });
});

describe("orchestration live view", () => {
  it("in demo shows the header, the timeline and a simulated transcript, labeled DEMO", () => {
    for (const { width, height } of SIZES) {
      const state = select(demoState(), "e1");
      const block = renderLiveView(state, width, height, UNICODE_GLYPHS);
      expectFits(block, width);
      expect(block.lines.length).toBeLessThanOrEqual(height);
      const text = plain(block).join("\n");
      expect(text).toContain("DEMO · sample data, not real");
      expect(text).not.toContain("sample transcript");
      expect(text).toMatch(/Executor e1/);
      expect(text).toContain("fast-model");
      expect(text).toContain("medium");
      expect(text).toMatch(/● working/);
      expect(text).toContain("12k tokens");
      expect(text).toMatch(/context 12k of 300k/);
      expect(text).toContain("Timeline");
      expect(text).toMatch(/assistant/);
      expect(text).toMatch(/tool\s+edit src\/theme\.ts/);
      expect(block.hits.some((hit) => hit.target.kind === "back")).toBe(true);
    }
  });

  it("without a workflow says there is none yet", () => {
    const block = renderLiveView(initialOrchestrationState(), 80, 24, UNICODE_GLYPHS);
    expectFits(block, 80);
    expect(plain(block).join("\n")).toContain("No workflows yet. Use /delegate to start one.");
  });

  it("in demo with nothing live in the view says so, labeled DEMO", () => {
    // After a demo Stop all the Queue lists no node, so the live view has no agent to show.
    let state = reduceOrchestration(demoState(), { type: "stop-all" }).state;
    state = reduceOrchestration(state, { type: "set-view", view: "queue" }).state;
    state = reduceOrchestration(state, { type: "toggle-live" }).state;
    const block = renderLiveView(state, 80, 24, UNICODE_GLYPHS);
    expectFits(block, 80);
    const text = plain(block).join("\n");
    expect(text).toContain("DEMO · sample data, not real");
    expect(text).toContain("Nothing live to show");
    expect(text).not.toContain("No workflows yet");
    expect(block.hits.some((hit) => hit.target.kind === "back")).toBe(true);
  });
});

describe("orchestration ASCII fallback", () => {
  it("is chosen by HARIL_CONSOLE_ASCII=1 and Unicode otherwise", () => {
    expect(orchestrationGlyphs({ HARIL_CONSOLE_ASCII: "1" })).toBe(ASCII_GLYPHS);
    expect(orchestrationGlyphs({ HARIL_CONSOLE_ASCII: "true" })).toBe(ASCII_GLYPHS);
    expect(orchestrationGlyphs({})).toBe(UNICODE_GLYPHS);
    expect(orchestrationGlyphs({ HARIL_CONSOLE_ASCII: "0" })).toBe(UNICODE_GLYPHS);
  });

  it("draws no Unicode state glyph and keeps glyph plus text", () => {
    const watched = reduceOrchestration(demoState(), { type: "simulate-watchdog" }).state;
    const blocks = [
      renderOrchestrationView(watched, 140, 45, ASCII_GLYPHS),
      renderOrchestrationView(watched, 80, 24, ASCII_GLYPHS),
      renderOrchestrationSummary(watched, 76, 8, ASCII_GLYPHS),
      renderLiveView(watched, 80, 24, ASCII_GLYPHS),
      renderOrchestrationView(
        reduceOrchestration(watched, { type: "stop-all" }).state,
        140,
        45,
        ASCII_GLYPHS,
      ),
    ];
    for (const block of blocks) {
      const text = plain(block).join("\n");
      for (const glyph of UNICODE_STATE_GLYPHS) expect(text).not.toContain(glyph);
    }
    const lines = plain(blocks[0] as RenderedBlock);
    expect(lineWith(lines, "d1 Delegator 1")).toMatch(/\* d1 Delegator 1.*working/);
    expect(lineWith(lines, "e3 Executor")).toMatch(/v e3 Executor.*done/);
    expect(lineWith(lines, "e5 Executor")).toMatch(/x e5 Executor.*closed: no progress/);
    expect(lines.join("\n")).toContain("# Stop all");
  });
});
