import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DashboardFacts, renderDashboardLayout } from "../src/dashboard.js";
import { controlsFor } from "../src/dashboard-controls.js";
import { emptyDashboardData } from "../src/dashboard-data.js";
import {
  openDelegationPanel,
  openDelegationSettings,
  type PanelEffect,
  type PanelState,
  renderDelegationScreen,
} from "../src/delegation-panel.js";
import {
  type DelegationView,
  decodeDelegationView,
  delegationSummary,
  fieldAt,
  parseEntry,
  rangeText,
  sourceText,
  valueText,
} from "../src/delegation-settings.js";
import { initialOrchestrationState } from "../src/orchestration-state.js";
import type { ConsoleContext, ConsoleMouseEvent, ConsoleTheme, PiModel } from "../src/pi-types.js";
import { stripAnsi, textWidth } from "../src/text.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";
import { fakeContext } from "./fake-pi.js";

// The Delegation section of TOOLS (docs/modos-y-delegacion.md 7.7, 7.10; phase F7) with a fake ConsolePi and a fake
// haril CLI: every setting with its value and source, a click or Enter to edit, only the levels a layer's model publishes,
// the change confirmed with its old and new value and saved through `haril config set`.

const FIXTURE = readFileSync(
  new URL("./fixtures/delegation-settings.json", import.meta.url),
  "utf8",
);
const THEME: ConsoleTheme = { fg: (_color, text) => text, bold: (text) => text };

function view(): DelegationView {
  const decoded = decodeDelegationView(JSON.parse(FIXTURE) as unknown);
  if (decoded === undefined) throw new Error("fixture does not decode");
  return decoded;
}

function field(path: string) {
  const found = fieldAt(view(), `delegation.${path}`);
  if (found === undefined) throw new Error(`no field ${path}`);
  return found;
}

const GEMINI: PiModel = {
  provider: "haril-cliproxy",
  id: "Gemini1/gemini-3-flash",
  name: "gemini-3-flash",
  reasoning: true,
  contextWindow: 1_048_576,
  maxTokens: 65_536,
  thinkingLevelMap: {
    off: null,
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  },
} as unknown as PiModel;
const CLAUDE: PiModel = {
  provider: "haril-cliproxy",
  id: "claude-sonnet-4-5",
  name: "claude-sonnet-4-5",
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 64_000,
} as unknown as PiModel;
const NOT_HARIL: PiModel = {
  provider: "anthropic",
  id: "claude-opus",
  name: "claude-opus",
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 32_000,
} as unknown as PiModel;

describe("the delegation settings as the console shows them", () => {
  it("decode HARIL's config get output, every field with its value and source", () => {
    const decoded = view();
    expect(decoded.configPath).toBe("fake-config/haril.json");
    expect(decoded.fields).toHaveLength(45);
    expect(valueText(field("context.perLayer.orchestrator"))).toBe("400,000 tokens");
    expect(sourceText(field("context.perLayer.orchestrator"))).toBe("haril.json");
    expect(valueText(field("context.perLayer.executor"))).toBe("300,000 tokens");
    expect(sourceText(field("context.perLayer.executor"))).toBe("inherits");
    expect(valueText(field("watchdog.intervalMs"))).toBe("15 min");
    expect(valueText(field("quota.switchAtPercent5h"))).toBe("80 %");
    expect(valueText(field("models.layers.delegator.model"))).toBe("not pinned");
    expect(valueText(field("models.layers.delegator.level"))).toBe("gateway default");
    expect(valueText(field("models.allow.executor"))).toBe("every model");
    expect(rangeText(field("limits.maxAuditRetries"))).toBe("0 or 1 (anti-rework: at most 1)");
    expect(decodeDelegationView({ fields: [] })).toBeUndefined();
  });

  it("read what the user types for a number: 400k, 400,000, 15 min", () => {
    expect(parseEntry(field("context.perLayer.orchestrator"), "400k")).toEqual({
      ok: true,
      arg: "400000",
      value: 400_000,
    });
    expect(parseEntry(field("context.compactAtTokens"), "400,000")).toMatchObject({
      arg: "400000",
    });
    expect(parseEntry(field("watchdog.intervalMs"), "15 min")).toMatchObject({ arg: "900000" });
    expect(parseEntry(field("context.perLayer.executor"), "")).toMatchObject({ arg: "null" });
    expect(parseEntry(field("limits.maxAuditRetries"), "2")).toMatchObject({ ok: false });
    expect(parseEntry(field("context.compactAtTokens"), "lots")).toMatchObject({ ok: false });
  });

  it("are summarized in the TOOLS panel, with a control that opens them", () => {
    expect(delegationSummary(view())[0]).toBe(
      "Delegation: compact at 300k (orchestrator 400k) · watchdog 15 min · models set for executor",
    );
    expect(controlsFor("tools", emptyDashboardData(), "idle").map((item) => item.label)).toContain(
      "Delegation settings",
    );
    const facts = {
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
      commands: [],
      mcpServers: [],
      extensionStatuses: [],
      memory: "not loaded",
      data: { ...emptyDashboardData(), loadedAt: 1, delegation: view() },
      loading: false,
      orchestration: initialOrchestrationState(),
      asciiGlyphs: false,
    } satisfies DashboardFacts;
    const text = renderDashboardLayout("tools", facts, 120, THEME, 40)
      .lines.map(stripAnsi)
      .join("\n");
    expect(text).toContain("Delegation: compact at 300k (orchestrator 400k)");
    expect(text).toContain("[S] Delegation settings");
  });
});

describe("the Delegation overlay", () => {
  it("draws every group, the values with their source and the selected row, within its size", () => {
    for (const [width, height] of [
      [80, 24],
      [120, 40],
    ] as const) {
      const state: PanelState = { view: view(), selected: 1, offset: 0 };
      const screen = renderDelegationScreen(state, width, height);
      expect(screen.lines).toHaveLength(height);
      for (const line of screen.lines) expect(textWidth(stripAnsi(line))).toBe(width);
      const text = screen.lines.map(stripAnsi).join("\n");
      expect(text).toContain("DELEGATION SETTINGS");
      expect(text).toContain("CONTEXT");
      expect(text).toMatch(/▶ Compact at, orchestrator +400,000 tokens/);
      expect(text).toContain("[Enter Edit]");
      expect(text).not.toMatch(/\btag\b/i);
    }
    const tall = renderDelegationScreen({ view: view(), selected: 0, offset: 0 }, 120, 80);
    const all = tall.lines.map(stripAnsi).join("\n");
    for (const title of ["LIMITS", "MODELS AND LEVELS", "QUOTA", "WATCHDOG", "AUTONOMY"]) {
      expect(all).toContain(title);
    }
  });

  it("keeps the selected row in sight as it moves down", () => {
    const state: PanelState = { view: view(), selected: 40, offset: 0 };
    const text = renderDelegationScreen(state, 100, 20).lines.map(stripAnsi).join("\n");
    expect(text).toContain("▶");
    expect(state.offset).toBeGreaterThan(0);
  });

  function open(state: PanelState) {
    let component:
      | {
          render(width: number): string[];
          handleInput?(data: string): void;
          handleMouse?(event: ConsoleMouseEvent): unknown;
        }
      | undefined;
    const ctx = {
      ui: {
        custom(factory: (...args: unknown[]) => typeof component) {
          return new Promise((resolve) => {
            component = factory(
              { terminal: { columns: 100, rows: 30 }, requestRender: () => undefined },
              THEME,
              undefined,
              resolve,
            );
          });
        },
      },
    } as unknown as ConsoleContext;
    const result = openDelegationPanel(ctx, state) as Promise<PanelEffect | undefined>;
    const view = () => {
      if (component === undefined) throw new Error("no overlay");
      return component;
    };
    const click = (text: string): void => {
      const lines = view().render(100).map(stripAnsi);
      const y = lines.findIndex((line) => line.includes(text));
      view().handleMouse?.({
        type: "click",
        button: "left",
        x: (lines[y] ?? "").indexOf(text),
        y,
        width: 100,
        height: 30,
        shift: false,
        alt: false,
        ctrl: false,
      });
    };
    return { result, view, click };
  }

  it("edits the setting a click lands on", async () => {
    const overlay = open({ view: view(), selected: 0, offset: 0 });
    overlay.click("Live children of a delegator");
    await expect(overlay.result).resolves.toEqual({
      kind: "edit",
      path: "delegation.limits.maxActiveChildren.delegator",
    });
  });

  it("moves with the arrows and edits with Enter, resets with R, closes with Esc", async () => {
    const enter = open({ view: view(), selected: 0, offset: 0 });
    enter.view().handleInput?.("\u001b[B");
    enter.view().handleInput?.("\r");
    await expect(enter.result).resolves.toEqual({
      kind: "edit",
      path: "delegation.context.perLayer.orchestrator",
    });
    const reset = open({ view: view(), selected: 1, offset: 0 });
    reset.view().handleInput?.("r");
    await expect(reset.result).resolves.toEqual({
      kind: "reset",
      path: "delegation.context.perLayer.orchestrator",
    });
    const close = open({ view: view(), selected: 0, offset: 0 });
    close.click("[Esc Close]");
    await expect(close.result).resolves.toBeUndefined();
  });
});

describe("editing a delegation setting", () => {
  let cli: FakeCli;

  beforeEach(() => {
    cli = installFakeCli();
    cli.answer("config get delegation", { stdout: FIXTURE });
    cli.answer("config set", { stdout: '{"written":true}' });
  });

  afterEach(() => {
    cli.restore();
  });

  // A ctx whose overlay picks `effects` in turn (then closes), and whose dialogs answer from `answers`.
  function scripted(
    effects: (PanelEffect | undefined)[],
    answers: {
      readonly input?: string[];
      readonly select?: ((title: string, options: string[]) => string | undefined)[];
      readonly confirm?: boolean;
      readonly models?: PiModel[];
    },
  ) {
    const ctx = fakeContext("fake-cwd");
    const selects: { title: string; options: string[] }[] = [];
    const confirms: string[] = [];
    const ui = ctx.ui as unknown as Record<string, unknown>;
    ui.custom = async () => effects.shift();
    ui.input = async () => answers.input?.shift();
    ui.select = async (title: string, options: string[]) => {
      selects.push({ title, options });
      return answers.select?.shift()?.(title, options);
    };
    ui.confirm = async (_title: string, message: string) => {
      confirms.push(message);
      return answers.confirm ?? true;
    };
    (ctx as unknown as { modelRegistry: unknown }).modelRegistry = {
      getAll: () => answers.models ?? [],
      getAvailable: () => answers.models ?? [],
      find: () => undefined,
    };
    return { ctx, selects, confirms };
  }

  const sets = () => cli.calls().filter((call) => call.args[1] === "set");

  it("types a layer's threshold, confirms the change with both values and saves it with haril config set", async () => {
    const { ctx, confirms } = scripted(
      [{ kind: "edit", path: "delegation.context.perLayer.executor" }],
      { input: ["400k"] },
    );
    await openDelegationSettings(ctx, { cwd: process.cwd() });
    expect(confirms[0]).toContain("300,000 tokens (inherits)  →  400,000 tokens");
    expect(confirms[0]).toContain("affects new workflows");
    expect(sets().map((call) => call.args)).toEqual([
      ["config", "set", "delegation.context.perLayer.executor", "400000", "--json"],
    ]);
    expect(ctx.notes.at(-1)?.[0]).toContain("saved in haril.json");
  });

  it("refuses more than 1 relaunch before asking HARIL, and saves nothing", async () => {
    const { ctx } = scripted([{ kind: "edit", path: "delegation.limits.maxAuditRetries" }], {
      input: ["2", undefined as unknown as string],
    });
    await openDelegationSettings(ctx, {});
    expect(ctx.notes.some(([text]) => text.includes("0 or 1 (anti-rework"))).toBe(true);
    expect(sets()).toEqual([]);
  });

  it("offers only the levels the layer's model publishes", async () => {
    const { ctx, selects } = scripted(
      [{ kind: "edit", path: "delegation.models.layers.executor.level" }],
      { models: [GEMINI, CLAUDE], select: [(_title, options) => options[4]] },
    );
    await openDelegationSettings(ctx, {});
    expect(selects[0]?.options).toEqual([
      "  Gateway default: no level asked for",
      "  minimal",
      "  low",
      "● medium",
      "  high",
    ]);
    expect(sets().map((call) => call.args[3])).toEqual(["high"]);
  });

  it("picks a layer's model among HARIL's models with credentials, then its level", async () => {
    const { ctx, selects } = scripted(
      [{ kind: "edit", path: "delegation.models.layers.auditor.model" }],
      {
        models: [GEMINI, CLAUDE, NOT_HARIL],
        select: [
          () => "Choose a model",
          (_title, options) => options.find((option) => !option.includes("Gemini1")),
          (_title, options) => options.find((option) => option.includes("claude-sonnet")),
          (_title, options) => options[0],
        ],
      },
    );
    await openDelegationSettings(ctx, {});
    // HARIL's providers and accounts only: a Pi provider of its own (anthropic here) serves no agent.
    expect(selects[1]?.options).toEqual([
      "haril-cliproxy · 1 models",
      "haril-cliproxy · Gemini1 · 1 models",
    ]);
    expect(selects[2]?.options).toEqual([
      "  cliproxy/claude-sonnet-4-5 · ctx 200k · no published levels",
    ]);
    // Claude through the gateway publishes no levels: only the gateway default is offered.
    expect(selects[3]?.options).toEqual(["● Gateway default: no level asked for"]);
    expect(sets().map((call) => call.args.slice(2, 4))).toEqual([
      ["delegation.models.layers.auditor.model", "cliproxy/claude-sonnet-4-5"],
    ]);
  });

  it("resets a value to its default after confirming it", async () => {
    const { ctx, confirms } = scripted(
      [{ kind: "reset", path: "delegation.limits.maxActiveChildren.orchestrator" }],
      {},
    );
    await openDelegationSettings(ctx, {});
    expect(confirms[0]).toContain("3 (haril.json)  →  5 (default)");
    expect(sets().map((call) => call.args)).toEqual([
      ["config", "set", "delegation.limits.maxActiveChildren.orchestrator", "--reset", "--json"],
    ]);
  });

  it("shows but changes nothing in CONSULT mode", async () => {
    const { ctx } = scripted([{ kind: "edit", path: "delegation.context.compactAtTokens" }], {
      input: ["400k"],
    });
    await openDelegationSettings(ctx, { mode: () => "consult" });
    expect(ctx.notes.some(([text]) => text.startsWith("CONSULT mode is read-only"))).toBe(true);
    expect(sets()).toEqual([]);
  });
});
