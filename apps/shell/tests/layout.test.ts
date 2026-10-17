import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { followCursor, packTabs } from "../src/layout.js";

// Layout helpers (TUI-T3): the tab strip wraps to the terminal width and the body window follows the cursor.

const LABELS = [
  "Projects",
  "Tasks",
  "Agents",
  "Tokens",
  "Events",
  "Models",
  "Config",
  "Themes",
  "Memory",
  "Services",
  "Terminals",
];

describe("packTabs", () => {
  it("wraps the tab labels so no line is wider than the terminal, and keeps every tab in order", () => {
    const lines = packTabs(LABELS, 30);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(visibleWidth(line.map((tab) => tab.text).join("  "))).toBeLessThanOrEqual(30);
    }
    const indexes = lines.flat().map((tab) => tab.index);
    expect(indexes).toEqual(LABELS.map((_, index) => index));
  });

  it("keeps one line when the terminal is wide enough", () => {
    expect(packTabs(LABELS, 200)).toHaveLength(1);
  });
});

describe("followCursor", () => {
  it("keeps the cursor line inside the window and clamps the offset", () => {
    expect(followCursor(0, 0, 5, 20)).toBe(0);
    expect(followCursor(0, 7, 5, 20)).toBe(3);
    expect(followCursor(3, 1, 5, 20)).toBe(1);
    expect(followCursor(10, 19, 5, 20)).toBe(15);
    expect(followCursor(4, 2, 5, 3)).toBe(0);
  });
});
