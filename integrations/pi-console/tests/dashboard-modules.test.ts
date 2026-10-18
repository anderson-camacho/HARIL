import { afterEach, beforeEach, describe, expect, it } from "vitest";
import harilConsole from "../src/console.js";
import { DASHBOARD_AREAS, type DashboardFacts, renderDashboardLayout } from "../src/dashboard.js";
import { type DashboardActionHost, openDashboardActionMenu } from "../src/dashboard-actions.js";
import { controlsFor } from "../src/dashboard-controls.js";
import { emptyDashboardData } from "../src/dashboard-data.js";
import { initialOrchestrationState } from "../src/orchestration-state.js";
import type { ConsoleTheme } from "../src/pi-types.js";
import { stripAnsi } from "../src/text.js";
import { fakeContext, fakePi } from "./fake-pi.js";

// The console's modules after F5b (spec 7.8, P19): WORKFLOWS is retired, a workflow is seen in ORCHESTRATION, and the
// methodologies (with the HARIL command list) are browsed from TOOLS, as they were from WORKFLOWS. Five modules, five
// shortcuts.

const NOW = 1_800_000_000_000;
const THEME: ConsoleTheme = { fg: (_color, text) => text, bold: (text) => text };

function facts(): DashboardFacts {
  return {
    project: "fake-project",
    cwd: "fake-cwd",
    branch: "main",
    modelLevel: "fake-model · no reasoning",
    providers: [],
    runtime: "idle",
    runtimeAvailable: true,
    pending: 0,
    context: "unavailable",
    cost: "$0.000",
    activeTools: ["read"],
    tools: [{ name: "read", active: true }],
    commands: ["haril"],
    mcpServers: [],
    extensionStatuses: [],
    memory: "not loaded",
    data: {
      ...emptyDashboardData("fake-project"),
      loadedAt: NOW,
      methodologies: ["odd · v1 · fixture methodology"],
      methodologyEntries: [
        {
          id: "haril.methodology.odd",
          name: "odd",
          version: "1",
          sha256: "fixture-sha256",
          summary: "fixture methodology",
        },
      ],
      methodologiesAvailable: true,
    },
    loading: false,
    orchestration: initialOrchestrationState(),
    asciiGlyphs: false,
  };
}

const saved = { node: process.env.HARIL_NODE, cli: process.env.HARIL_CLI };

beforeEach(() => {
  delete process.env.HARIL_NODE;
  delete process.env.HARIL_CLI;
});

afterEach(() => {
  if (saved.node !== undefined) process.env.HARIL_NODE = saved.node;
  if (saved.cli !== undefined) process.env.HARIL_CLI = saved.cli;
});

describe("the console's modules", () => {
  it("are five: WORKFLOWS is retired", () => {
    expect([...DASHBOARD_AREAS]).toEqual([
      "agents",
      "orchestration",
      "automation",
      "tools",
      "everywhere",
    ]);
    expect(DASHBOARD_AREAS as readonly string[]).not.toContain("workflows");
  });

  it("browse the methodologies and the HARIL commands from TOOLS", () => {
    const actions = controlsFor("tools", facts().data, "idle").map((control) => control.action);
    expect(actions).toEqual(
      expect.arrayContaining(["toggle-tools", "model-level", "methodologies", "commands"]),
    );
    const text = renderDashboardLayout("tools", facts(), 100, THEME, 40)
      .lines.map(stripAnsi)
      .join("\n");
    expect(text).toContain("Methodologies: 1 HARIL methodologies");
    expect(text).toContain("[B] Browse HARIL methodologies");
    expect(text).toContain("[C] Browse HARIL commands");
    expect(text).toContain("Ctrl+Shift+1..5");
  });

  it("have one shortcut each, Ctrl+Shift+1..5, and a /command each but /workflows", async () => {
    const fake = fakePi();
    harilConsole(fake.pi);
    const ctx = fakeContext();
    await fake.fire("session_start", { reason: "startup" }, ctx);
    const areaShortcuts = [...fake.shortcuts.keys()].filter((key) => key.startsWith("ctrl+shift+"));
    expect(areaShortcuts).toEqual([
      "ctrl+shift+1",
      "ctrl+shift+2",
      "ctrl+shift+3",
      "ctrl+shift+4",
      "ctrl+shift+5",
    ]);
    expect(fake.commands.has("workflows")).toBe(false);
    for (const area of DASHBOARD_AREAS) expect(fake.commands.has(area)).toBe(true);
  });

  it("are the areas the /haril menu offers", async () => {
    const offered: string[][] = [];
    const ctx = fakeContext();
    let step = 0;
    (ctx.ui as { select: unknown }).select = async (_title: string, options: string[]) => {
      offered.push(options);
      step += 1;
      return step === 1 ? "Open an area" : undefined;
    };
    const host = {
      project: undefined,
      orchestrationDemo: () => false,
      runtimeAvailable: () => false,
      runtime: () => "idle",
      mode: () => "action",
      openArea: () => undefined,
    } as unknown as DashboardActionHost;
    await openDashboardActionMenu(ctx, fakePi().pi, host);
    expect(offered[0]).toEqual(
      expect.arrayContaining(["Browse methodologies", "Pick orchestration workflow"]),
    );
    expect(offered[1]).toEqual(["AGENTS", "ORCHESTRATION", "AUTOMATION", "TOOLS", "EVERYWHERE"]);
  });
});
