import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import harilConsole from "../src/console.js";
import {
  DASHBOARD_AREAS,
  type DashboardFacts,
  renderDashboardLayout,
  renderHeaderLayout,
} from "../src/dashboard.js";
import { type DashboardActionHost, openDashboardActionMenu } from "../src/dashboard-actions.js";
import { controlsFor } from "../src/dashboard-controls.js";
import { emptyDashboardData } from "../src/dashboard-data.js";
import { readConsoleLocale } from "../src/locale.js";
import { initialOrchestrationState, reduceOrchestration } from "../src/orchestration-state.js";
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
    const text = renderDashboardLayout("tools", { ...facts(), locale: "en" }, 100, THEME, 40)
      .lines.map(stripAnsi)
      .join("\n");
    expect(text).toContain("Methodologies: 1 HARIL methodologies");
    expect(text).toContain("[B] Browse HARIL methodologies");
    expect(text).toContain("[C] Browse HARIL commands");
    expect(text).toContain("Alt+H to choose area");
  });

  it("defaults direct control and dashboard callers to Spanish without changing mouse action IDs", () => {
    const directFacts = facts();
    const layout = renderDashboardLayout("tools", directFacts, 100, THEME, 40);
    const text = layout.lines.map(stripAnsi).join("\n");
    expect(text).toContain("[S] Ajustes de delegación");
    expect(text).toContain("[B] Explorar metodologías de HARIL");
    expect(text).toContain("[C] Explorar comandos de HARIL");
    expect(controlsFor("tools", directFacts.data, "idle").map((item) => item.label)).toContain(
      "Ajustes de delegación",
    );
    expect(layout.controlHits.map((hit) => hit.action)).toEqual(
      controlsFor("tools", directFacts.data, "idle", true, false, "en").map(
        (control) => control.action,
      ),
    );
    const detailsHit = layout.controlHits.find((hit) => hit.action === "details");
    expect(detailsHit).toBeDefined();
    expect(stripAnsi(layout.lines[detailsHit?.row ?? -1] ?? "")).toContain(
      "[D] Ver detalles completos",
    );
  });

  it("renders English controls only when explicitly configured", () => {
    const englishFacts = { ...facts(), locale: "en" as const };
    const layout = renderDashboardLayout("tools", englishFacts, 100, THEME, 40);
    expect(layout.lines.map(stripAnsi).join("\n")).toContain("[S] Delegation settings");
    expect(
      controlsFor("tools", englishFacts.data, "idle", true, false, "en").map((item) => item.label),
    ).toContain("Delegation settings");
    expect(layout.controlHits.map((hit) => hit.action)).toEqual(
      controlsFor("tools", englishFacts.data, "idle").map((item) => item.action),
    );
  });

  it("decodes only valid persisted console locales", () => {
    expect(readConsoleLocale({ path: "ui.locale", value: "en" })).toBe("en");
    expect(readConsoleLocale({ path: "ui.locale", value: "es" })).toBe("es");
    expect(readConsoleLocale({ path: "other", value: "en" })).toBe("es");
    expect(readConsoleLocale({ path: "ui.locale", value: "fr" })).toBe("es");
    expect(readConsoleLocale(undefined)).toBe("es");
  });

  it("renders a compact mark on narrow terminals and static wordmark on roomy headers", () => {
    const narrow = renderHeaderLayout("1.2.3", 60, facts(), "tools", THEME, 24);
    const medium = renderHeaderLayout("1.2.3", 100, facts(), "tools", THEME, 35);
    const wide = renderHeaderLayout("1.2.3", 140, facts(), "tools", THEME, 45);

    const narrowText = narrow.lines.map(stripAnsi).join("\n");
    const mediumText = medium.lines.map(stripAnsi).join("\n");
    const wideText = wide.lines.map(stripAnsi).join("\n");
    for (const text of [narrowText, mediumText, wideText]) {
      expect(text).toContain("HARIL ◉");
      expect(text).not.toContain("NEURAL LINK");
      expect(text).not.toContain("NEURAL LINK");
      expect(text).toContain("fake-project");
      expect(text).toContain("fake-model · no reasoning");
    }
    expect(narrowText).not.toContain("███████");
    expect(mediumText).toContain("███████");
    expect(wideText).toContain("███████");
    expect(mediumText).toContain("Many minds. One flow.");
    expect(wideText).toContain("Many minds. One flow.");
    expect(wideText).toContain("fake-project");
    expect(wideText).toContain("Pi console active");
    expect(wideText).not.toContain(".-~~~~~~~~~~-.");
    for (const [layout, width] of [
      [narrow, 60],
      [medium, 100],
      [wide, 140],
    ] as const) {
      expect(layout.tabHits.map((hit) => hit.area)).toEqual(DASHBOARD_AREAS);
      expect(layout.tabHits.every((hit) => hit.row >= 0 && hit.end <= width)).toBe(true);
    }
  });

  it("docks mode, extension statuses and provider warnings at the far right", () => {
    const base = facts();
    const observed: DashboardFacts = {
      ...base,
      mode: "DELEGATION",
      extensionStatuses: ["pi-bridge: ready", "indexer: healthy"],
      providerWarnings: ["HARIL provider cliproxy: unreachable"],
      logFailures: 2,
      data: { ...base.data, errors: ["Project status: unavailable"] },
    };
    const layout = renderHeaderLayout("0.21.3", 150, observed, "tools", THEME, 48);
    const text = layout.lines.map(stripAnsi).join("\n");
    expect(text).toContain("HARIL RIGHT RAIL");
    expect(text).toContain("DELEGATION");
    expect(text).toContain("EXTENSIONS · 2 reported statuses");
    expect(text).toContain("pi-bridge: ready");
    expect(text).toContain("WARNINGS · 3");
    expect(text).toContain("HARIL provider cliproxy: unreachable");
    expect(text).toContain("+ 2 more · focus for details");
    expect(text).toContain("Pi console active");
    expect(layout.railHits?.every((hit) => hit.start >= 90)).toBe(true);
    expect(layout.tabHits.map((hit) => hit.area)).toEqual(DASHBOARD_AREAS);
    expect(layout.tabHits.every((hit) => hit.end <= 150 && hit.row < layout.lines.length)).toBe(
      true,
    );
  });

  it("does not mistake missing Pi extension status reports for zero loaded extensions", () => {
    const layout = renderHeaderLayout(
      "0.21.3",
      150,
      { ...facts(), mode: "ACTION" },
      "agents",
      THEME,
      48,
    );
    const text = layout.lines.map(stripAnsi).join("\n");
    expect(text).toContain("EXTENSIONS · 0 reported statuses");
    expect(text).toContain("Loaded extension names: Pi startup");
    expect(text).toContain("WARNINGS · 0");
  });

  it("auto-hides the right rail in narrow or short terminals, and supports manual collapse", () => {
    for (const [width, height, visible] of [
      [90, 40, true],
      [140, 24, true],
      [140, 45, false],
    ] as const) {
      const layout = renderHeaderLayout("0.21.6", width, facts(), "tools", THEME, height, visible);
      expect(layout.railHits).toBeUndefined();
      expect(layout.lines.map(stripAnsi).join("\n")).toContain("Alt+R sidebar");
    }
  });

  it("can show the current workflow as a compact, clickable right-side summary", () => {
    const state = reduceOrchestration(initialOrchestrationState(), {
      type: "toggle-demo",
      now: NOW,
    }).state;
    const layout = renderHeaderLayout(
      "0.21.6",
      160,
      { ...facts(), orchestration: state },
      "orchestration",
      THEME,
      48,
    );
    const text = layout.lines.map(stripAnsi).join("\n");
    expect(text).toContain("RIGHT RAIL · ORCHESTRATION");
    expect(text).toContain("WORKFLOW");
    expect(text).toContain("AGENTS");
    expect(layout.railHits?.length).toBeGreaterThan(5);
  });

  it("registers one area-picker shortcut and a /command each but /workflows", async () => {
    const fake = fakePi();
    harilConsole(fake.pi);
    const ctx = fakeContext();
    await fake.fire("session_start", { reason: "startup" }, ctx);
    expect([...fake.shortcuts.keys()].filter((key) => key.startsWith("ctrl+shift+"))).toEqual([]);
    expect(fake.shortcuts.has("alt+h")).toBe(true);
    expect(fake.shortcuts.has("alt+r")).toBe(true);
    expect(fake.shortcuts.has("alt+f")).toBe(true);
    expect(fake.commands.has("workflows")).toBe(false);
    for (const area of DASHBOARD_AREAS) expect(fake.commands.has(area)).toBe(true);
  });

  it("draws a fixed-width HARIL teal border around the area chooser", () => {
    const picker = createTabPicker("tools", () => undefined);
    const rows = picker.render(80).map(stripAnsi);
    expect(rows[0]).toBe(`╭${"─".repeat(52)}╮`);
    expect(rows.at(-1)).toBe(`╰${"─".repeat(52)}╯`);
    expect(rows.every((row) => row.length === 54)).toBe(true);
    expect(rows.join("\\n")).toContain("HARIL ◉");
    expect(rows.join("\\n")).toContain("▶ TOOLS");
    expect(rows.join("\\n")).toContain("Esc: close");
    for (const width of [12, 19, 30]) {
      const narrow = picker.render(width).map(stripAnsi);
      expect(narrow.every((row) => row.length <= width)).toBe(true);
    }
  });

  it("uses up/down in a vertical list, wraps, supports legacy left/right, Enter and Esc", () => {
    expect(initialTabPickerIndex("tools")).toBe(3);
    const results: unknown[] = [];
    const picker = createTabPicker("tools", (result) => results.push(result));
    expect(picker.render(80).join("\n")).toContain("↑/↓ move");
    picker.handleInput("\u001b[B");
    expect(picker.render(80).join("\n")).toContain("▶ EVERYWHERE");
    picker.handleInput("\u001b[B");
    expect(picker.render(80).join("\n")).toContain("▶ AGENTS");
    picker.handleInput("\u001b[A");
    expect(picker.render(80).join("\n")).toContain("▶ EVERYWHERE");
    picker.handleInput("\u001b[C");
    expect(picker.render(80).join("\n")).toContain("▶ AGENTS");
    picker.handleInput("\u001b[D");
    expect(picker.render(80).join("\n")).toContain("▶ EVERYWHERE");
    picker.handleInput("\r");
    picker.handleInput("\u001b[B");
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
      locale: "en",
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

  it("dispatches translated menu choices through stable action and area IDs", async () => {
    const ctx = fakeContext();
    const selections: { title: string; options: string[] }[] = [];
    let nextChoice = "Actualizar datos";
    (ctx.ui as { select: unknown }).select = async (title: string, options: string[]) => {
      selections.push({ title, options });
      return nextChoice;
    };
    const reload = vi.fn(async () => undefined);
    const refreshStatus = vi.fn(async () => undefined);
    const openArea = vi.fn();
    const host = {
      project: undefined,
      orchestrationDemo: () => false,
      runtimeAvailable: () => false,
      runtime: () => "idle",
      mode: () => "action",
      reload,
      refreshStatus,
      openArea,
    } as unknown as DashboardActionHost;

    await openDashboardActionMenu(ctx, fakePi().pi, host);
    expect(selections[0]?.title).toBe("Controles de la consola HARIL");
    expect(selections[0]?.options).toContain("Actualizar datos");
    expect(selections[0]?.options).toContain("Abrir un área");
    expect(reload).toHaveBeenCalledOnce();
    expect(refreshStatus).toHaveBeenCalledOnce();

    nextChoice = "Abrir un área";
    (ctx.ui as { select: unknown }).select = async (title: string, options: string[]) => {
      selections.push({ title, options });
      return title === "Área del panel" ? "HERRAMIENTAS" : nextChoice;
    };
    await openDashboardActionMenu(ctx, fakePi().pi, host);
    expect(openArea).toHaveBeenCalledWith("tools");
    expect(selections.at(-1)?.options).toContain("HERRAMIENTAS");

    const englishHost = { ...host, locale: "en" } as DashboardActionHost;
    nextChoice = "Refresh data";
    await openDashboardActionMenu(ctx, fakePi().pi, englishHost);
    expect(selections.at(-1)?.options).toContain("Refresh data");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("filters state-changing menu actions by ID in both locales", async () => {
    for (const locale of ["es", "en"] as const) {
      const ctx = fakeContext();
      let options: string[] = [];
      (ctx.ui as { select: unknown }).select = async (_title: string, offered: string[]) => {
        options = offered;
        return undefined;
      };
      const host = {
        locale,
        project: { slug: "fake-project" },
        orchestrationDemo: () => false,
        runtimeAvailable: () => true,
        runtime: () => "idle",
        mode: () => "consult",
      } as unknown as DashboardActionHost;
      await openDashboardActionMenu(ctx, fakePi().pi, host);
      expect(options).toContain(locale === "es" ? "Inspeccionar tareas" : "Inspect tasks");
      expect(options).not.toContain(locale === "es" ? "Encolar un objetivo" : "Queue a goal");
      expect(options).not.toContain(locale === "es" ? "Iniciar runtime" : "Start runtime");
    }
  });

  it.each(["\u001b", "\u001b[27u", "\u001b[27;1u"])(
    "closes full-screen area details on Escape input %s",
    async (input) => {
      const ctx = fakeContext();
      (ctx.ui as { select: unknown }).select = async () => "View area details";
      let handleInput: ((data: string) => void) | undefined;
      let overlayRender: ((width: number) => string[]) | undefined;
      let overlayOptions: unknown;
      (ctx.ui as { custom: unknown }).custom = (
        factory: (...args: unknown[]) => {
          handleInput(data: string): void;
          render(width: number): string[];
        },
        options: unknown,
      ) =>
        new Promise<void>((resolve) => {
          overlayOptions = options;
          const component = factory({ requestRender: () => undefined }, THEME, undefined, () =>
            resolve(),
          );
          handleInput = component.handleInput;
          overlayRender = component.render;
        });
      const host = {
        locale: "en",
        details: () => ({ title: "TOOLS details", lines: ["Deterministic detail"] }),
        mode: () => "action",
        orchestrationDemo: () => false,
        runtimeAvailable: () => false,
        runtime: () => "idle",
      } as unknown as DashboardActionHost;

      const opening = openDashboardActionMenu(ctx, fakePi().pi, host);
      await vi.waitFor(() => expect(handleInput).toBeDefined());
      expect(overlayOptions).toEqual({
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%" },
      });
      const frame = overlayRender?.(60).map(stripAnsi) ?? [];
      expect(frame[0]?.startsWith("╭")).toBe(true);
      expect(frame.at(-1)?.startsWith("╰")).toBe(true);
      expect(frame.every((line) => line.length === 60)).toBe(true);
      expect(frame.join("\\n")).toContain("HARIL ◉ · TOOLS details");
      handleInput?.(input);
      await opening;
    },
  );
});
