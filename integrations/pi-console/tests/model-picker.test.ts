import { beforeEach, describe, expect, it } from "vitest";
import { type DashboardActionHost, runDashboardAction } from "../src/dashboard-actions.js";
import { controlsFor } from "../src/dashboard-controls.js";
import { emptyDashboardData } from "../src/dashboard-data.js";
import {
  chooseLevel,
  chooseModel,
  createLevelMemory,
  delegationModelCatalog,
  groupModels,
  type LevelMemory,
  openModelAndLevel,
} from "../src/model-picker.js";
import type { ConsoleContext, ConsolePi, PiModel, ThinkingLevel } from "../src/pi-types.js";

// The model and level selectors (FM): the model selector lists the models Pi can use (getAvailable), grouped by
// provider and account prefix, with their context and levels; the level selector offers only the current model's
// levels. A fake Pi and a scripted select stand in for the terminal.

const FLASH: PiModel = {
  provider: "haril-gw",
  id: "Gemini1/gemini-3-flash",
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  },
  contextWindow: 1_048_576,
};
const FLASH_10: PiModel = { ...FLASH, id: "Gemini10/gemini-3-flash" };
const FLASH_2: PiModel = { ...FLASH, id: "Gemini2/gemini-3-flash" };
const CLAUDE: PiModel = {
  provider: "haril-gw",
  id: "Gemini1/claude-sonnet-4-6",
  reasoning: false,
  contextWindow: 200_000,
};
const NATIVE: PiModel = { provider: "anthropic", id: "claude-native", reasoning: true };
const NO_ACCESS: PiModel = { provider: "locked", id: "fake-no-access", reasoning: true };

let answers: (string | undefined)[];
let prompts: { title: string; options: string[] }[];
let notes: [string, string | undefined][];
let level: ThinkingLevel;
let selected: PiModel[];
let setLevels: ThinkingLevel[];
let settings: {
  defaultThinkingLevel?: ThinkingLevel;
  modelThinkingLevels?: Record<string, ThinkingLevel>;
};
let ctx: ConsoleContext & { model: PiModel | undefined };
let pi: ConsolePi;

beforeEach(() => {
  answers = [];
  prompts = [];
  notes = [];
  level = "off";
  selected = [];
  setLevels = [];
  settings = {};
  ctx = {
    model: FLASH,
    hasUI: true,
    mode: "tui",
    modelRegistry: {
      getAll: () => [FLASH, FLASH_2, FLASH_10, CLAUDE, NATIVE, NO_ACCESS],
      getAvailable: () => [FLASH_10, CLAUDE, FLASH, FLASH_2, NATIVE],
      find: () => undefined,
    },
    ui: {
      async select(title: string, options: string[]) {
        prompts.push({ title, options });
        const answer = answers.shift();
        if (answer === undefined) return undefined;
        const found = options.find((option) => option.includes(answer));
        if (found === undefined) throw new Error(`no option matches ${answer} in ${title}`);
        return found;
      },
      notify(message: string, type?: string) {
        notes.push([message, type]);
      },
    },
  } as unknown as ConsoleContext & { model: PiModel | undefined };
  pi = {
    async setModel(model: PiModel) {
      selected.push(model);
      ctx.model = model;
      return model.provider !== "locked";
    },
    setThinkingLevel(next: ThinkingLevel) {
      setLevels.push(next);
      level = next;
    },
    getThinkingLevel: () => level,
    getSettings: () => settings,
  } as unknown as ConsolePi;
});

function memory(defaults: ReadonlyMap<string, ThinkingLevel> = new Map()): LevelMemory {
  return createLevelMemory(pi, () => defaults);
}

describe("groupModels", () => {
  it("groups by provider and account prefix, in natural order", () => {
    const groups = groupModels([FLASH_10, CLAUDE, FLASH, FLASH_2, NATIVE]);
    expect(groups.map((group) => group.label)).toEqual([
      "anthropic",
      "haril-gw · Gemini1",
      "haril-gw · Gemini2",
      "haril-gw · Gemini10",
    ]);
    expect(groups[1]?.models.map((model) => model.id)).toEqual([
      "Gemini1/claude-sonnet-4-6",
      "Gemini1/gemini-3-flash",
    ]);
  });
});

describe("delegationModelCatalog", () => {
  it("deduplicates registry entries and separates executable HARIL references from unavailable Pi models", () => {
    const unauthenticated: PiModel = { provider: "haril-gw", id: "Gemini2/private" };
    const openAi: PiModel = { provider: "openai-api", id: "gpt-native" };
    const claudeBridge: PiModel = { provider: "claude-bridge", id: "claude-native" };
    const catalog = delegationModelCatalog(
      [FLASH, FLASH, unauthenticated, openAi, claudeBridge],
      [FLASH, openAi],
    );

    expect(catalog.compatible.flatMap((group) => group.models)).toEqual([FLASH]);
    expect(catalog.unavailable.map((group) => group.label)).toEqual([
      "claude-bridge",
      "haril-gw · Gemini2",
      "openai-api",
    ]);
    expect(
      catalog.unavailable.find((group) => group.label === "haril-gw · Gemini2")?.reason,
    ).toContain("no working credentials");
    for (const provider of ["openai-api", "claude-bridge"]) {
      expect(catalog.unavailable.find((group) => group.label === provider)?.reason).toContain(
        "configure a HARIL provider in haril.json",
      );
    }
  });
});

describe("chooseModel", () => {
  it("lists only available models, grouped, with context and levels, and sets the choice", async () => {
    answers = ["haril-gw · Gemini1", "claude-sonnet-4-6"];
    const chosen = await chooseModel(ctx, pi);
    expect(chosen).toBe(CLAUDE);
    expect(selected).toEqual([CLAUDE]);
    const [groups, models] = prompts;
    expect(groups?.options.join("\n")).not.toContain("locked");
    expect(groups?.options).toContain("● haril-gw · Gemini1 · 2 models");
    expect(models?.title).toBe("Model · haril-gw · Gemini1");
    expect(models?.options).toEqual([
      "  claude-sonnet-4-6 · ctx 200k · no published levels",
      "● gemini-3-flash · ctx 1M · levels minimal low medium high",
    ]);
  });

  it("skips the group step when there is one group and does nothing on cancel", async () => {
    ctx.modelRegistry.getAvailable = () => [FLASH, CLAUDE];
    answers = [undefined];
    expect(await chooseModel(ctx, pi)).toBeUndefined();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.title).toBe("Model · haril-gw · Gemini1");
    expect(selected).toEqual([]);
  });

  it("says so when no model has access", async () => {
    ctx.modelRegistry.getAvailable = () => [];
    expect(await chooseModel(ctx, pi)).toBeUndefined();
    expect(notes[0]?.[1]).toBe("warning");
    expect(prompts).toHaveLength(0);
  });
});

describe("chooseLevel", () => {
  it("offers only the current model's levels and sets the chosen one", async () => {
    level = "medium";
    const levels = memory(new Map([["haril-gw/Gemini1/gemini-3-flash", "medium"]]));
    answers = ["high"];
    await chooseLevel(ctx, pi, levels);
    expect(prompts[0]?.title).toBe("Reasoning level · Gemini1/gemini-3-flash");
    expect(prompts[0]?.options).toEqual([
      "  minimal",
      "  low",
      "● medium · model default",
      "  high",
    ]);
    expect(setLevels).toEqual(["high"]);
    expect(level).toBe("high");
    expect(notes.at(-1)?.[0]).toMatch(/Gemini1\/gemini-3-flash · high/);
  });

  it("marks the level Pi's settings keep for the model", async () => {
    settings = { modelThinkingLevels: { "haril-gw/Gemini1/gemini-3-flash": "low" } };
    answers = [undefined];
    await chooseLevel(ctx, pi, memory());
    expect(prompts[0]?.options).toContain("  low · saved in /settings");
    expect(setLevels).toEqual([]);
  });

  it("says a model without published levels has only off", async () => {
    ctx.model = CLAUDE;
    await chooseLevel(ctx, pi, memory());
    expect(prompts).toHaveLength(0);
    expect(notes[0]?.[0]).toMatch(/claude-sonnet-4-6 publishes no reasoning levels/);
  });
});

describe("openModelAndLevel (TOOLS · Model and level)", () => {
  it("changes the model, then offers that model's levels", async () => {
    ctx.modelRegistry.getAvailable = () => [FLASH, CLAUDE];
    ctx.model = CLAUDE;
    answers = ["Change model", "gemini-3-flash", "low"];
    await openModelAndLevel(ctx, pi, memory());
    expect(prompts[0]?.title).toBe("Model and level · Gemini1/claude-sonnet-4-6 · no reasoning");
    expect(selected).toEqual([FLASH]);
    expect(setLevels).toEqual(["low"]);
  });
});

describe("level memory", () => {
  it("remembers a chosen level per model and puts it back when the model returns", () => {
    const levels = memory();
    levels.choose(FLASH, "high");
    level = "minimal";
    levels.modelSelected(FLASH_2);
    expect(level).toBe("minimal");
    levels.modelSelected(FLASH);
    expect(level).toBe("high");
  });

  it("records a native change of level only when the model did not change", () => {
    const levels = memory();
    levels.levelSelected(FLASH, FLASH, "low");
    levels.levelSelected(FLASH_2, FLASH, "minimal");
    level = "medium";
    levels.modelSelected(FLASH);
    expect(level).toBe("low");
    setLevels = [];
    levels.modelSelected(FLASH_2);
    expect(setLevels).toEqual([]);
  });

  it("uses the gateway default only when Pi's settings do not decide", () => {
    const defaults = new Map<string, ThinkingLevel>([
      ["haril-gw/Gemini1/gemini-3-flash", "medium"],
    ]);
    settings = { defaultThinkingLevel: "off" };
    memory(defaults).modelSelected(FLASH);
    expect(setLevels).toEqual(["medium"]);

    setLevels = [];
    settings = { defaultThinkingLevel: "high" };
    memory(defaults).modelSelected(FLASH);
    expect(setLevels).toEqual([]);

    settings = { modelThinkingLevels: { "haril-gw/Gemini1/gemini-3-flash": "low" } };
    memory(defaults).modelSelected(FLASH);
    expect(setLevels).toEqual([]);
  });

  it("does not record its own changes as the user's", () => {
    const defaults = new Map<string, ThinkingLevel>([
      ["haril-gw/Gemini1/gemini-3-flash", "medium"],
    ]);
    const levels = createLevelMemory(
      {
        ...pi,
        setThinkingLevel(next: ThinkingLevel) {
          level = next;
          levels.levelSelected(FLASH, FLASH, next);
        },
      } as ConsolePi,
      () => defaults,
    );
    levels.modelSelected(FLASH);
    expect(level).toBe("medium");
    settings = { defaultThinkingLevel: "high" };
    level = "high";
    levels.modelSelected(FLASH);
    expect(level).toBe("high");
  });
});

describe("dashboard model controls", () => {
  it("TOOLS offers Model and level; AGENTS keeps Choose Pi model", () => {
    const tools = controlsFor("tools", emptyDashboardData("fake-project"), "idle");
    expect(tools.map((control) => control.label)).toContain("Model and level");
    const agents = controlsFor("agents", emptyDashboardData("fake-project"), "idle");
    expect(agents.find((control) => control.action === "model")?.label).toBe("Choose Pi model");
  });

  it("Choose Pi model lists only the models Pi can use", async () => {
    answers = [undefined];
    const host = { levels: memory() } as unknown as DashboardActionHost;
    await runDashboardAction("model", ctx, pi, host);
    expect(prompts[0]?.options.join("\n")).not.toContain("fake-no-access");
  });
});
