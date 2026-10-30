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
    mode: "ACTION",
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
    expect(none.hits.map((hit) => hit.target)).toEqual(["mode", "model", "stop"]);
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

describe("mode and STOP ALL in the bar (F4)", () => {
  it("shows the mode with a hit-box, and the button at the right end", () => {
    const layout = renderBarLayout(bar({ mode: "CONSULT" }), 140, THEME);
    const line = layout.lines[0] ?? "";
    const mode = layout.hits.find((hit) => hit.target === "mode");
    const stop = layout.hits.find((hit) => hit.target === "stop");
    expect(hitText(line, mode ?? { start: 0, end: 0 })).toBe("MODE: CONSULT");
    expect(hitText(line, stop ?? { start: 0, end: 0 })).toBe("■ STOP ALL");
    expect(stop?.end).toBe(140);
    expect(stripAnsi(line).endsWith("■ STOP ALL")).toBe(true);
  });

  it("says when chat rows could not be logged, and drops that note first", () => {
    const wide = renderBarLayout(bar({ logFailures: 2 }), 160, THEME);
    expect(stripAnsi(wide.lines[0] ?? "")).toContain("log ✗ 2");
    const none = renderBarLayout(bar({ logFailures: 0 }), 160, THEME);
    expect(stripAnsi(none.lines[0] ?? "")).not.toContain("log ✗");
  });

  it("never drops the button, however narrow the bar", () => {
    for (const width of [12, 20, 30, 44, 60, 80]) {
      const layout = renderBarLayout(bar({ mode: "DELEGATION" }), width, THEME);
      const line = layout.lines[0] ?? "";
      const stop = layout.hits.find((hit) => hit.target === "stop");
      expect(hitText(line, stop ?? { start: 0, end: 0 }), String(width)).toBe("■ STOP ALL");
      expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
    }
  });
});

// The status of the console lives in one of two places. With the right sidebar open on MAIN it is there, and the bar is
// the compact one-liner; in any other case (sidebar closed, terminal too small, another tab selected) the bar is the
// full one: two lines, with a count of the warnings the sidebar would list.
describe("the bar: compact beside the sidebar, full anywhere else", () => {
  it("is two lines when the status is not in the sidebar: the bar and the folder line", () => {
    const layout = renderBarLayout(bar({ cwd: "fake-cwd", branch: "main" }), 140, THEME);
    expect(layout.lines).toHaveLength(2);
    const text = layout.lines.map(stripAnsi).join("\n");
    expect(text).toContain("fake-project");
    expect(text).toContain("fake-cwd (main)");
    // Compact is opt-in: a bar built without the flag is the full one.
    expect(renderBarLayout(bar({ compact: false }), 140, THEME).lines).toHaveLength(2);
  });

  describe("compact", () => {
    const compact = (overrides: Partial<BarFacts> = {}, width = 140) =>
      renderBarLayout(
        bar({ compact: true, cwd: "fake-cwd", branch: "main", warnings: 3, ...overrides }),
        width,
        THEME,
      );

    it("is one line: HARIL, mode and model · level on the left; ctx, cost, runtime and STOP ALL on the right", () => {
      const layout = compact();
      expect(layout.lines).toHaveLength(1);
      const line = stripAnsi(layout.lines[0] ?? "");
      expect(line).toContain("◆ HARIL");
      expect(line).toContain("MODE: ACTION");
      expect(line).toContain("Gemini1/gemini-3-flash · medium");
      expect(line).toContain("ctx ");
      expect(line).toContain("$0.000");
      expect(line).toContain("runtime idle");
      expect(line.endsWith("■ STOP ALL")).toBe(true);
      expect(line.indexOf("MODE: ACTION")).toBeLessThan(line.indexOf("Gemini1/gemini-3-flash"));
      expect(line.indexOf("Gemini1/gemini-3-flash")).toBeLessThan(line.indexOf("ctx "));
    });

    it("has no place, folder, branch or status line, and does not repeat the warnings the sidebar lists", () => {
      const layout = compact({ logFailures: 2, statuses: ["indexer: ready"] });
      const text = layout.lines.map(stripAnsi).join("\n");
      for (const absent of ["fake-project", "fake-cwd", "(main)", "indexer", "warning", "log ✗"]) {
        expect(text, absent).not.toContain(absent);
      }
    });

    it("still tells the human that approvals wait, since the sidebar block does not show them", () => {
      expect(stripAnsi(compact({ pending: 2 }).lines[0] ?? "")).toContain("2 pending");
      expect(stripAnsi(compact({ pending: 0 }).lines[0] ?? "")).not.toContain("pending");
      expect(stripAnsi(compact({ pending: undefined }).lines[0] ?? "")).not.toContain("approvals");
    });

    it("keeps every hit-box on its one line, and never drops the button, however narrow", () => {
      for (const width of [12, 20, 30, 44, 60, 80, 140]) {
        const layout = compact({}, width);
        expect(layout.lines, String(width)).toHaveLength(1);
        const line = layout.lines[0] ?? "";
        expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
        expect(layout.hits.every((hit) => hit.row === 0)).toBe(true);
        const stop = layout.hits.find((hit) => hit.target === "stop");
        expect(hitText(line, stop ?? { start: 0, end: 0 }), String(width)).toBe("■ STOP ALL");
      }
      const wide = compact();
      const line = wide.lines[0] ?? "";
      expect(wide.hits.map((hit) => hit.target)).toEqual(["mode", "model", "level", "stop"]);
      const model = wide.hits.find((hit) => hit.target === "model");
      expect(hitText(line, model ?? { start: 0, end: 0 })).toBe("Gemini1/gemini-3-flash");
    });

    it("draws nothing for a width that cannot hold a bar", () => {
      expect(renderBarLayout(bar({ compact: true }), 0, THEME)).toEqual({ lines: [], hits: [] });
    });
  });

  describe("full, with the warnings count", () => {
    const full = (warnings: number | undefined, width = 160) =>
      stripAnsi(renderBarLayout(bar({ warnings }), width, THEME).lines[0] ?? "");

    it("counts the warnings, in the singular and the plural, and shows nothing for none", () => {
      expect(full(1)).toContain("1 warning");
      expect(full(1)).not.toContain("1 warnings");
      expect(full(4)).toContain("4 warnings");
      expect(full(0)).not.toContain("warning");
      expect(full(undefined)).not.toContain("warning");
    });

    it("gives way to the rest of the bar when the width runs out, after the cost and the runtime", () => {
      let seen = 0;
      for (let width = 30; width <= 160; width++) {
        const layout = renderBarLayout(bar({ warnings: 2, pending: 1 }), width, THEME);
        const line = stripAnsi(layout.lines[0] ?? "");
        expect(textWidth(line), String(width)).toBeLessThanOrEqual(width);
        if (line.includes("2 warnings")) {
          seen++;
          // The drop order is log, cost, runtime, warnings, pending, context: warnings outlive the first three.
          expect(line, String(width)).toContain("1 pending");
          expect(line, String(width)).toContain("ctx ");
        }
        expect(layout.lines, String(width)).toHaveLength(2);
        expect(layout.hits.find((hit) => hit.target === "stop")?.end).toBe(width);
      }
      expect(seen).toBeGreaterThan(0);
    });
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
