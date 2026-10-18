import { describe, expect, it } from "vitest";
import { type DashboardFacts, renderHeaderLayout } from "../src/dashboard.js";
import { emptyDashboardData } from "../src/dashboard-data.js";
import { initialOrchestrationState } from "../src/orchestration-state.js";
import type { ConsoleTheme } from "../src/pi-types.js";
import { stripAnsi, textWidth } from "../src/text.js";
import { type BarFacts, renderBarLayout } from "../src/view.js";

// The model and its reasoning level are always visible (FM): in HARIL's bar as `model · level` (or `model · no
// reasoning`), each clickable, and in the wide and compact headers.

const THEME: ConsoleTheme = { fg: (_color, text) => text, bold: (text) => text };

function bar(overrides: Partial<BarFacts> = {}): BarFacts {
  return {
    place: "fake-project",
    model: "Gemini1/gemini-3-flash",
    level: "medium",
    contextPercent: 12,
    cost: 0,
    pending: 0,
    runtime: "idle",
    cwd: "fake-cwd",
    branch: null,
    statuses: [],
    ...overrides,
  };
}

function hitText(line: string, hit: { start: number; end: number }): string {
  return stripAnsi(line).slice(hit.start, hit.end);
}

describe("HARIL bar", () => {
  it("shows model · level with a hit-box on each", () => {
    const layout = renderBarLayout(bar(), 120, THEME);
    const line = layout.lines[0] ?? "";
    expect(stripAnsi(line)).toContain("Gemini1/gemini-3-flash · medium");
    const model = layout.hits.find((hit) => hit.target === "model");
    const level = layout.hits.find((hit) => hit.target === "level");
    expect(model?.row).toBe(0);
    expect(hitText(line, model ?? { start: 0, end: 0 })).toBe("Gemini1/gemini-3-flash");
    expect(hitText(line, level ?? { start: 0, end: 0 })).toBe("medium");
  });

  it("says no reasoning for a model that does not reason, and no model without one", () => {
    const plain = renderBarLayout(bar({ level: "no reasoning" }), 120, THEME);
    expect(stripAnsi(plain.lines[0] ?? "")).toContain("Gemini1/gemini-3-flash · no reasoning");
    const none = renderBarLayout(bar({ model: undefined, level: undefined }), 120, THEME);
    expect(stripAnsi(none.lines[0] ?? "")).toContain("no model");
    expect(none.hits.map((hit) => hit.target)).toEqual(["model"]);
  });

  it("keeps the hit-boxes inside a narrow bar", () => {
    for (const width of [30, 44]) {
      const layout = renderBarLayout(bar(), width, THEME);
      for (const line of layout.lines)
        expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
      for (const hit of layout.hits) {
        expect(hit.end).toBeLessThanOrEqual(width);
        expect(hit.end).toBeGreaterThan(hit.start);
      }
    }
  });
});

function facts(modelLevel: string): DashboardFacts {
  return {
    project: "fake-project",
    cwd: "fake-cwd",
    branch: "main",
    modelLevel,
    providers: [],
    runtime: "idle",
    runtimeAvailable: true,
    pending: 0,
    context: "12%",
    cost: "$0.000",
    activeTools: [],
    tools: [],
    commands: [],
    mcpServers: [],
    extensionStatuses: [],
    memory: "not loaded",
    data: emptyDashboardData("fake-project"),
    loading: false,
    orchestration: initialOrchestrationState(),
    asciiGlyphs: false,
  };
}

describe("headers", () => {
  it("show the model and its level in the wide and compact layouts", () => {
    const wide = renderHeaderLayout(
      "0.10.0",
      140,
      facts("Gemini1/gemini-3-flash · high"),
      "agents",
      THEME,
      45,
    );
    expect(wide.lines.map(stripAnsi).join("\n")).toContain("Gemini1/gemini-3-flash · high");
    const compact = renderHeaderLayout(
      "0.10.0",
      100,
      facts("Gemini1/claude-sonnet-4-6 · no reasoning"),
      "agents",
      THEME,
      24,
    );
    expect(compact.lines.map(stripAnsi).join("\n")).toContain(
      "Gemini1/claude-sonnet-4-6 · no reasoning",
    );
  });
});
