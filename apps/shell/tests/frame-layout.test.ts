import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  bar,
  box,
  fitLine,
  joinColumns,
  joinThreeColumns,
  type Line,
  lineText,
  padLine,
} from "../src/frame-layout.js";

// The frame's layout helpers (LD-T6b-1): a titled box, two columns joined line by line and a bar with a left and a
// right part. They work on segments of text and tone; every text goes through fit, so none is wider than asked and
// none keeps a control character.

const text = (value: string): Line => [{ text: value, tone: "text" }];

describe("fitLine and padLine", () => {
  it("cut a line of several segments to the width and mark the cut", () => {
    const line: Line = [
      { text: "abc", tone: "accent" },
      { text: "defgh", tone: "muted" },
    ];
    expect(lineText(fitLine(line, 6))).toBe("abcde…");
    expect(lineText(fitLine(line, 0))).toBe("");
    expect(lineText(padLine(text("ab"), 5))).toBe("ab   ");
    expect(lineText(padLine(line, 4))).toBe("abc…");
  });

  it("replace control characters, as fit does", () => {
    expect(lineText(fitLine(text("a\x1b[2Jb"), 10))).toBe("a?[2Jb");
  });
});

describe("box", () => {
  it("draws the borders with the title in the top one; every line is exactly the width", () => {
    const lines = box("Status", [text("branch main"), text("changes 2")], 20).map(lineText);
    expect(lines).toEqual([
      "┌─ Status ─────────┐",
      "│ branch main      │",
      "│ changes 2        │",
      "└──────────────────┘",
    ]);
  });

  it("draws a footer in the bottom border and cuts it like the title (LD-T6b-2)", () => {
    expect(box("Input", [text("> goal")], 20, "Esc keys").map(lineText)).toEqual([
      "┌─ Input ──────────┐",
      "│ > goal           │",
      "└─ Esc keys ───────┘",
    ]);
    const cut = box(undefined, [], 16, "Esc keys · / commands · Ctrl+C quit").map(lineText);
    for (const line of cut) expect(visibleWidth(line)).toBe(16);
    expect(cut[1]).toBe("└─ Esc keys … ─┘");
  });

  it("cuts a long title and a long line instead of widening the box", () => {
    const lines = box("A very long box title", [text("x".repeat(40))], 16).map(lineText);
    for (const line of lines) expect(visibleWidth(line)).toBe(16);
    expect(lines[0]).toMatch(/^┌─ A very lo…[ ─]*┐$/);
    expect(lines[1]).toBe(`│ ${"x".repeat(11)}… │`);
  });

  it("keeps its border tone apart from the tone of its text", () => {
    const [top, body] = box("T", [[{ text: "v", tone: "ok" }]], 8);
    expect(top?.[0]?.tone).toBe("border");
    expect(body?.map((segment) => segment.tone)).toContain("ok");
  });
});

describe("joinColumns", () => {
  it("pads both columns and gives exactly the height asked, one space between them", () => {
    const lines = joinColumns([text("left one"), text("left two")], 10, [text("right")], 6, 3).map(
      lineText,
    );
    expect(lines).toEqual(["left one   right ", "left two         ", "                 "]);
  });

  it("cuts a column line that is wider than its column", () => {
    const [line] = joinColumns([text("abcdefghij")], 5, [text("xyz")], 3, 1).map(lineText);
    expect(line).toBe("abcd… xyz");
  });
});

describe("joinThreeColumns (three-pane feasibility spike)", () => {
  it("reserves independent left, chat and right widths on every row", () => {
    const rows = joinThreeColumns(
      [text("plugins"), text("Git")],
      10,
      [text("conversation"), text("Pi streaming")],
      14,
      [text("orchestration")],
      12,
      3,
    ).map(lineText);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => visibleWidth(row) === 38)).toBe(true);
    expect(rows[0]?.slice(0, 10).trimEnd()).toBe("plugins");
    expect(rows[0]?.slice(11, 25).trimEnd()).toBe("conversation");
    expect(rows[0]?.slice(26)).toBe("orchestrati…");
    expect(rows[1]?.slice(26)).toBe(" ".repeat(12));
    expect(rows[2]).toBe(" ".repeat(38));
  });

  it("clips one pane without moving neighbors and keeps segment tones", () => {
    const lines = joinThreeColumns(
      [[{ text: "界世界", tone: "accent" }]],
      5,
      [[{ text: "chat", tone: "text" }]],
      6,
      [[{ text: "agents", tone: "ok" }]],
      6,
      1,
    );
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lineText(lines[0] ?? []))).toBe(19);
    expect(lines[0]?.map((part) => part.tone)).toContain("accent");
    expect(lines[0]?.map((part) => part.tone)).toContain("ok");
    expect(lineText(lines[0] ?? []).endsWith("agents")).toBe(true);
  });

  it("rejects invalid geometry before writing terminal output", () => {
    expect(() => joinThreeColumns([], -1, [], 10, [], 10, 20)).toThrow(RangeError);
    expect(() => joinThreeColumns([], 4, [], 4, [], 4, 1.5)).toThrow(RangeError);
  });
});

describe("bar", () => {
  it("puts the left part at the start and the right part at the end", () => {
    expect(lineText(bar(text("left"), text("right"), 16))).toBe("left       right");
  });

  it("cuts the left part when both do not fit, so the right part stays whole", () => {
    expect(lineText(bar(text("a long left part"), text("q quit"), 14))).toBe("a long… q quit");
  });
});
