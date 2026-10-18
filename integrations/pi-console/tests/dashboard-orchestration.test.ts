import { describe, expect, it } from "vitest";
import { type DashboardFacts, renderDashboardLayout } from "../src/dashboard.js";
import { controlsFor } from "../src/dashboard-controls.js";
import { emptyDashboardData } from "../src/dashboard-data.js";
import { initialOrchestrationState, reduceOrchestration } from "../src/orchestration-state.js";
import { DEMO_LABEL, EMPTY_MESSAGE } from "../src/orchestration-view.js";
import type { ConsoleTheme } from "../src/pi-types.js";
import { stripAnsi, textWidth } from "../src/text.js";

// The ORCHESTRATION module panel: the workflow summary framed inside the dashboard box, the project's secondary line
// below it and the module controls, with the summary's hit-boxes moved to the box's rows and columns.

const NOW = 1_800_000_000_000;
const THEME: ConsoleTheme = { fg: (_color, text) => text, bold: (text) => text };

function facts(demo: boolean, projectSlug: string | undefined = "fake-project"): DashboardFacts {
  const orchestration = demo
    ? reduceOrchestration(initialOrchestrationState(), { type: "toggle-demo", now: NOW }).state
    : initialOrchestrationState();
  return {
    project: projectSlug ?? "fake-folder",
    cwd: "fake-cwd",
    branch: "main",
    modelLevel: "fake-model · no reasoning",
    providers: [],
    runtime: "idle",
    runtimeAvailable: true,
    pending: 0,
    context: "unavailable",
    cost: "$0.000",
    activeTools: [],
    tools: [],
    commands: [],
    mcpServers: [],
    extensionStatuses: [],
    memory: "not loaded",
    data: { ...emptyDashboardData(projectSlug), loadedAt: NOW },
    loading: false,
    orchestration,
    asciiGlyphs: false,
  };
}

describe("ORCHESTRATION module panel", () => {
  it("without demo shows the honest empty state, the project line and every control", () => {
    for (const height of [24, 40]) {
      const layout = renderDashboardLayout("orchestration", facts(false), 80, THEME, height);
      const lines = layout.lines.map(stripAnsi);
      for (const line of lines) expect(textWidth(line)).toBe(80);
      const text = lines.join("\n");
      expect(text).toContain(EMPTY_MESSAGE);
      expect(text).not.toMatch(/DEMO|wf_ab12|138k/);
      expect(text).toMatch(
        /Project fake-project · 0 tasks · 0 queued commands · approvals 0 pending/,
      );
      for (const label of [
        "[D] View complete details",
        "[V] Open orchestration view",
        "[M] Demo on (sample data)",
        "[A] Review approvals (0)",
        "[T] Inspect project tasks",
        "[G] Queue a goal for planning",
        "[E] Project event history",
        "[R] Refresh data",
      ])
        expect(text).toContain(label);
      const kinds = layout.orchestrationHits.map((hit) => hit.target.kind);
      expect(kinds).toEqual(["open", "stop"]);
    }
  });

  it("with demo shows the summary and maps its hit-boxes to the labels inside the box", () => {
    const layout = renderDashboardLayout("orchestration", facts(true), 80, THEME, 40);
    const lines = layout.lines.map(stripAnsi);
    for (const line of lines) expect(textWidth(line)).toBe(80);
    const text = lines.join("\n");
    expect(text).toContain(DEMO_LABEL);
    expect(text).toMatch(/138k/);
    expect(text).toContain("[M] Demo off (sample data)");
    const label = (index: number): string => {
      const hit = layout.orchestrationHits[index];
      if (hit === undefined) throw new Error("no hit");
      return (lines[hit.row] ?? "").slice(hit.start, hit.end);
    };
    const find = (kind: string): number =>
      layout.orchestrationHits.findIndex((hit) => hit.target.kind === kind);
    expect(label(find("open"))).toBe("[Open full view]");
    expect(label(find("stop"))).toBe("[■ Stop all]");
    expect(label(find("node"))).toContain("o1 Orchestrator");
    expect(label(find("view"))).toBe("[Tree]");
    for (const hit of layout.orchestrationHits) {
      expect(hit.start).toBeGreaterThanOrEqual(2);
      expect(hit.end).toBeLessThanOrEqual(78);
    }
    // No summary hit-box overlaps a control's hit-box.
    for (const control of layout.controlHits)
      expect(layout.orchestrationHits.some((hit) => hit.row === control.row)).toBe(false);
  });

  it("an unbound folder still offers the view, the demo and registration", () => {
    const controls = controlsFor("orchestration", emptyDashboardData(), "unknown").map(
      (control) => control.action,
    );
    expect(controls).toEqual([
      "register-project",
      "details",
      "orchestration-view",
      "orchestration-pick",
      "orchestration-demo",
      "refresh",
    ]);
  });

  it("other modules draw no orchestration summary", () => {
    for (const area of ["agents", "automation", "tools", "everywhere"] as const) {
      const layout = renderDashboardLayout(area, facts(true), 80, THEME, 40);
      expect(layout.orchestrationHits).toHaveLength(0);
      expect(layout.lines.map(stripAnsi).join("\n")).not.toContain(DEMO_LABEL);
    }
  });
});
