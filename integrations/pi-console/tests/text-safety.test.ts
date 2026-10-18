import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// R6 keeps the Core out of the console's package, so the test reads the rule from its source.
import { visibleText } from "../../../packages/core/src/domain/visible-text.js";
import { type RenderedBlock, UNICODE_GLYPHS } from "../src/orchestration-draw.js";
import { parseSnapshotLine } from "../src/orchestration-feed.js";
import { initialOrchestrationState, reduceOrchestration } from "../src/orchestration-state.js";
import { renderLiveView, renderOrchestrationView } from "../src/orchestration-view.js";
import { clipText, plainText } from "../src/text.js";

// Text an agent wrote reaches the console's views (goals, memos, live lines). Escape sequences, C1 controls, bidi
// overrides and isolates, zero-width and tag characters and the line separators must not reach the terminal: they move
// the cursor, set the clipboard, hide words or reorder a line. The console may not import the Core (R6), so it copies
// visibleText's rule; the parity test keeps the two from drifting.

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = 1_800_000_000_000;

// RLO, ZWSP, a tag character, the line separator, OSC 52 (clipboard) and a C1 CSI.
const PROBE = "safe‮evil​wide\u{E0041}tag line\u001b]52;c;aGVsbG8=\u0007clip\u009b31mred";
const FORBIDDEN = ["‮", "​", "\u{E0041}", " ", "\u009b", "\u001b]", "⁦", "‎", "﻿"];

function snapshotWithProbe() {
  const raw = JSON.parse(readFileSync(join(HERE, "fixtures", "snapshot-completed.json"), "utf8"));
  raw.nodes[0].goal = PROBE;
  raw.nodes[0].memo = PROBE;
  raw.workflow.goal = PROBE;
  const parsed = parseSnapshotLine(JSON.stringify(raw));
  if (parsed === undefined) throw new Error("fixture is not a snapshot");
  return parsed;
}

function raw(block: RenderedBlock): string {
  return block.lines.join("\n");
}

describe("agent text in the console views", () => {
  it("never draws escape sequences, C1, bidi, zero-width, tag or separator characters", () => {
    let state = reduceOrchestration(initialOrchestrationState(), {
      type: "real-snapshot",
      snapshot: snapshotWithProbe(),
      now: NOW,
    }).state;
    const first = state.snapshot?.nodes[0]?.id ?? "o1";
    state = reduceOrchestration(state, { type: "select-node", id: first }).state;
    const views = [renderOrchestrationView(state, 140, 45, UNICODE_GLYPHS)];
    views.push(renderOrchestrationView(state, 80, 30, UNICODE_GLYPHS));
    state = reduceOrchestration(state, { type: "toggle-live" }).state;
    state = reduceOrchestration(state, {
      type: "tail",
      nodeId: first,
      lines: [{ at: NOW, kind: "assistant", text: PROBE }],
    }).state;
    views.push(renderLiveView(state, 140, 45, UNICODE_GLYPHS));
    for (const view of views) {
      const drawn = raw(view);
      expect(drawn).toContain("safe");
      for (const bad of FORBIDDEN) expect(drawn.includes(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("follows the Core's visibleText rule, except that it removes escapes and spaces tabs and separators", () => {
    const corpus = [
      "plain ascii",
      "accents: café, niño, Ünïcödé",
      "a‮b‭c‪d⁦e⁩f",
      "zero​width‌and‍join⁠word﻿bom",
      "marks ‎‏",
      "tag\u{E0001}\u{E0041}\u{E007F}",
      "controls \u0000\u0007\u007f\u0085\u009b",
      "emoji ❤️ 👍🏽 👨‍👩‍👧 1️⃣",
      "indic क्‍ष",
      "lone \uD800 surrogate",
      "selector ️ alone",
      "wide 漢字 and 한국어",
    ];
    for (const text of corpus)
      expect(plainText(text), JSON.stringify(text)).toBe(visibleText(text));
    expect(plainText("a b c")).toBe("a b c");
    expect(plainText("a\tb")).toBe("a  b");
    expect(plainText("x\u001b[31my\u001b]0;title\u0007z")).toBe("xyz");
  });

  it("clips a label by code points, so a surrogate pair is never split", () => {
    const text = `${"a".repeat(59)}😀tail`;
    expect(clipText(text, 60)).toBe(`${"a".repeat(59)}😀`);
    expect(clipText("short", 60)).toBe("short");
    expect(clipText(`${"b".repeat(60)}`, 60)).toBe("b".repeat(60));
  });
});
