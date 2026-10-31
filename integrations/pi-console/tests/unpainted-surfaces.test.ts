import { afterEach, describe, expect, it } from "vitest";
import { renderNativeRailContent } from "../src/dashboard.js";
import { emptyDashboardData } from "../src/dashboard-data.js";
import { paddedCell, setHarilPalette } from "../src/dashboard-theme.js";
import { createDockPicker } from "../src/dock-navigation.js";
import { initialOrchestrationState } from "../src/orchestration-state.js";
import { RAIL_BODY_WIDTH } from "../src/rail-metrics.js";
import { stripAnsi, textWidth } from "../src/text.js";

// A background image drawn by the terminal shows only behind cells with the default background, so Future paints no
// surface. The documented exception in the panel is the selected row.
const BACKGROUND_SGR = new RegExp(`${String.fromCharCode(27)}\\[(?:[0-9;]*;)?48;[25];`);

const facts = {
  locale: "es" as const,
  project: "fake",
  cwd: "fake-cwd",
  branch: "main",
  modelLevel: "fake-model · low",
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
  packageWarnings: ["fake package update"],
  memory: "no provider · not checked yet",
  version: "0.0.1",
  contextFiles: ["AGENTS.md"],
  data: emptyDashboardData(),
  loading: false,
  orchestration: initialOrchestrationState(),
  asciiGlyphs: false,
};

describe("Future leaves the terminal's background alone", () => {
  afterEach(() => setHarilPalette("future"));

  it("paints no background in the MAIN panel rows", () => {
    setHarilPalette("future");
    const { lines } = renderNativeRailContent(
      facts,
      "agents",
      RAIL_BODY_WIDTH,
      {},
      { cards: true },
    );
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(line).not.toMatch(BACKGROUND_SGR);
    expect(stripAnsi(lines.join("\n"))).toContain("fake package update");
  });

  it("paints only the selected row, and every other palette keeps its surfaces", () => {
    setHarilPalette("future");
    expect(paddedCell("x", 4, "text", "panel")).not.toMatch(BACKGROUND_SGR);
    expect(paddedCell("x", 4, "text", "base")).not.toMatch(BACKGROUND_SGR);
    expect(paddedCell("x", 4, "text", "selected")).toMatch(BACKGROUND_SGR);
    setHarilPalette("matrix");
    expect(paddedCell("x", 4, "text", "panel")).toMatch(BACKGROUND_SGR);
  });
});

describe("the Alt+L picker", () => {
  it("draws its first row with its text, as wide as the others", () => {
    const picker = createDockPicker(
      [{ id: "main", visible: true } as never, { id: "memory", visible: true } as never],
      "main",
      () => undefined,
      undefined,
      "es",
    );
    const lines = picker.render(48);
    const first = lines.find((line) => stripAnsi(line).includes("1."));
    expect(stripAnsi(first ?? "")).toContain("Principal");
    for (const line of lines) expect(textWidth(stripAnsi(line))).toBe(48);
  });
});
