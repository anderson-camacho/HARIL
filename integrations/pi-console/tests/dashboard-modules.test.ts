import { afterEach, beforeEach, describe, expect, it } from "vitest";
import harilConsole from "../src/console.js";
import { DASHBOARD_AREAS, type DashboardFacts, renderDashboardLayout } from "../src/dashboard.js";
import { type DashboardActionHost, openDashboardActionMenu } from "../src/dashboard-actions.js";
import { controlsFor } from "../src/dashboard-controls.js";
import { emptyDashboardData } from "../src/dashboard-data.js";
import { initialOrchestrationState } from "../src/orchestration-state.js";
import type { ConsoleTheme } from "../src/pi-types.js";
import { createTabPicker, initialTabPickerIndex } from "../src/tab-picker.js";
import { stripAnsi } from "../src/text.js";
import { fakeContext, fakePi } from "./fake-pi.js";

// The console's modules after F5b (spec 7.8, P19): WORKFLOWS is retired, a workflow is seen in ORCHESTRATION, and the
// methodologies (with the HARIL command list) are browsed from TOOLS, as they were from WORKFLOWS. Alt+H opens the
// focused area picker; arrows wrap across its five areas.

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
    expect(text).toContain("Alt+H to choose area");
  });

  it("registers one area-picker shortcut and a /command each but /workflows", async () => {
    const fake = fakePi();
    harilConsole(fake.pi);
    const ctx = fakeContext();
    await fake.fire("session_start", { reason: "startup" }, ctx);
    expect([...fake.shortcuts.keys()].filter((key) => key.startsWith("ctrl+shift+"))).toEqual([]);
    expect(fake.shortcuts.has("alt+h")).toBe(true);
    expect(fake.commands.has("workflows")).toBe(false);
    for (const area of DASHBOARD_AREAS) expect(fake.commands.has(area)).toBe(true);
  });

  it("starts on the current area, wraps left and right, confirms with Enter, and cancels with Esc", () => {
    expect(initialTabPickerIndex("tools")).toBe(3);
    const results: unknown[] = [];
    const picker = createTabPicker("tools", (result) => results.push(result));
    expect(picker.render(80).join("\n")).toContain("TOOLS");
    picker.handleInput("\u001b[C");
    expect(picker.render(80).join("\n")).toContain("EVERYWHERE");
    picker.handleInput("\u001b[C");
    expect(picker.render(80).join("\n")).toContain("AGENTS");
    picker.handleInput("\u001b[D");
    expect(picker.render(80).join("\n")).toContain("EVERYWHERE");
    picker.handleInput("\r");
    picker.handleInput("\u001b[C");
    expect(results).toEqual([{ type: "open", area: "everywhere" }]);

    const cancelled: unknown[] = [];
    const cancelPicker = createTabPicker("tools", (result) => cancelled.push(result));
    cancelPicker.handleInput("\u001b");
    expect(cancelled).toEqual([{ type: "cancel" }]);
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
