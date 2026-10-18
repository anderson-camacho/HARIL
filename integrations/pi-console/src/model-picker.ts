import { levelLabel, supportedLevels, tokenCount } from "./model-levels.js";
import type { ConsoleContext, ConsolePi, PiModel, ThinkingLevel } from "./pi-types.js";

// Choosing the model and the reasoning level (FM, docs/modos-y-delegacion.md 7.10): from a click on the bar, the
// TOOLS "Model and level" control, the AGENTS "Choose Pi model" control and /haril. Pi's own /model, Ctrl+L,
// /thinking and Shift+Tab keep working beside these, on the same levels (models.ts registers them).
//
// The level is remembered per model. Pi 1.2.0 has a native per-model setting, `modelThinkingLevels`, that it applies
// on every switch to that model, but only Pi's /settings writes it: the extension API reads settings (a copy) and sets
// the session's level, nothing more. So HARIL remembers each model's level for the session, reapplies it when the
// model returns, leaves Pi's saved level alone and points to /settings to keep a level across restarts.

const GROUP_TITLE = "Model · choose a provider or account";

export interface ModelGroup {
  readonly label: string;
  readonly models: readonly PiModel[];
}

// The level the console keeps per model, and how it reacts to Pi's model and level changes.
export interface LevelMemory {
  // The user chose `level` for `model` (the current model): set it and remember it. Returns the level Pi kept.
  choose(model: PiModel, level: ThinkingLevel): ThinkingLevel;
  // Pi switched to `model`: put back its remembered level, else the gateway's default when Pi's settings do not
  // decide (no per-model level saved, and the global default is not one the model offers).
  modelSelected(model: PiModel): void;
  // Pi changed the level (/thinking, Shift+Tab, a clamp on a switch): remembered only when `live`, the model Pi has
  // now, is still `known`, the model the console last saw; otherwise the change belongs to a model switch.
  levelSelected(live: PiModel | undefined, known: PiModel | undefined, level: ThinkingLevel): void;
  defaultLevel(model: PiModel): ThinkingLevel | undefined;
  savedLevel(model: PiModel): ThinkingLevel | undefined;
}

function refOf(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

function sameModel(a: PiModel | undefined, b: PiModel | undefined): boolean {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.id === b.id;
}

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function createLevelMemory(
  pi: ConsolePi,
  defaults: () => ReadonlyMap<string, ThinkingLevel>,
): LevelMemory {
  const chosen = new Map<string, ThinkingLevel>();
  // True while the memory itself sets a level, so Pi's resulting event is not taken for the user's choice.
  let applying = false;
  const apply = (level: ThinkingLevel): void => {
    applying = true;
    try {
      pi.setThinkingLevel(level);
    } finally {
      applying = false;
    }
  };
  const settings = () => safely(() => pi.getSettings(), {});
  const memory: LevelMemory = {
    choose(model, level) {
      apply(level);
      const actual = safely(() => pi.getThinkingLevel(), level);
      chosen.set(refOf(model), actual);
      return actual;
    },
    modelSelected(model) {
      const levels = supportedLevels(model);
      if (levels.length <= 1) return;
      const remembered = chosen.get(refOf(model));
      if (remembered !== undefined && levels.includes(remembered)) {
        apply(remembered);
        return;
      }
      if (memory.savedLevel(model) !== undefined) return;
      const fallback = memory.defaultLevel(model);
      const global = settings().defaultThinkingLevel;
      if (fallback === undefined || (global !== undefined && levels.includes(global))) return;
      apply(fallback);
    },
    levelSelected(live, known, level) {
      if (applying || live === undefined || !sameModel(live, known)) return;
      chosen.set(refOf(live), level);
    },
    defaultLevel: (model) => defaults().get(refOf(model)),
    savedLevel: (model) => settings().modelThinkingLevels?.[refOf(model)],
  };
  return memory;
}

// The models by provider and account prefix (`Gemini3/…` is an account of the gateway), groups and models in natural
// order (Gemini2 before Gemini10).
export function groupModels(models: readonly PiModel[]): ModelGroup[] {
  const order = (a: string, b: string): number =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const groups = new Map<string, PiModel[]>();
  for (const model of models) {
    const slash = model.id.indexOf("/");
    const label = slash > 0 ? `${model.provider} · ${model.id.slice(0, slash)}` : model.provider;
    const group = groups.get(label) ?? [];
    group.push(model);
    groups.set(label, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => order(a, b))
    .map(([label, group]) => ({ label, models: group.sort((a, b) => order(a.id, b.id)) }));
}

function modelOption(model: PiModel, current: PiModel | undefined): string {
  const slash = model.id.indexOf("/");
  const name = slash > 0 ? model.id.slice(slash + 1) : model.id;
  const levels = supportedLevels(model);
  const offered = levels.length > 1 ? `levels ${levels.join(" ")}` : "no published levels";
  return `${sameModel(model, current) ? "●" : " "} ${name} · ctx ${tokenCount(model.contextWindow)} · ${offered}`;
}

function currentModel(ctx: ConsoleContext): PiModel | undefined {
  return safely(() => ctx.model, undefined);
}

// The model selector: the models Pi can use (with credentials), a provider or account first when there are several,
// then its models with their context and levels. Returns the model Pi switched to.
export async function chooseModel(
  ctx: ConsoleContext,
  pi: ConsolePi,
): Promise<PiModel | undefined> {
  const models = safely(() => ctx.modelRegistry.getAvailable(), []);
  if (models.length === 0) {
    ctx.ui.notify("No model has credentials yet: /login, or set a provider key.", "warning");
    return undefined;
  }
  const current = currentModel(ctx);
  const groups = groupModels(models);
  let group = groups[0];
  if (groups.length > 1) {
    const labels = groups.map((item) => {
      const mark = item.models.some((model) => sameModel(model, current)) ? "●" : " ";
      const size = `${item.models.length} model${item.models.length === 1 ? "" : "s"}`;
      return `${mark} ${item.label} · ${size}`;
    });
    const choice = await ctx.ui.select(GROUP_TITLE, labels);
    group = choice === undefined ? undefined : groups[labels.indexOf(choice)];
  }
  if (group === undefined) return undefined;
  const labels = group.models.map((model) => modelOption(model, current));
  const choice = await ctx.ui.select(`Model · ${group.label}`, labels);
  const model = choice === undefined ? undefined : group.models[labels.indexOf(choice)];
  if (model === undefined) return undefined;
  let switched = false;
  try {
    switched = await pi.setModel(model);
  } catch {
    // A provider without credentials: reported below like a refusal.
  }
  if (!switched) {
    ctx.ui.notify("Pi could not select that model; check provider authentication.", "warning");
    return undefined;
  }
  return model;
}

// The level selector: only the current model's levels, the current one marked, with the gateway's default and the
// level Pi's settings keep for the model named.
export async function chooseLevel(
  ctx: ConsoleContext,
  pi: ConsolePi,
  memory: LevelMemory,
): Promise<ThinkingLevel | undefined> {
  const model = currentModel(ctx);
  if (model === undefined) {
    ctx.ui.notify("Choose a model first: click the model in the bar, or /model.", "warning");
    return undefined;
  }
  const levels = supportedLevels(model);
  if (levels.length <= 1) {
    ctx.ui.notify(`${model.id} publishes no reasoning levels: only off is available.`, "info");
    return undefined;
  }
  const current = safely(() => pi.getThinkingLevel(), undefined);
  const fallback = memory.defaultLevel(model);
  const saved = memory.savedLevel(model);
  const labels = levels.map((level) =>
    [
      `${level === current ? "●" : " "} ${level}`,
      ...(level === fallback ? ["model default"] : []),
      ...(level === saved ? ["saved in /settings"] : []),
    ].join(" · "),
  );
  const choice = await ctx.ui.select(`Reasoning level · ${model.id}`, labels);
  const level = choice === undefined ? undefined : levels[labels.indexOf(choice)];
  if (level === undefined) return undefined;
  const actual = memory.choose(model, level);
  ctx.ui.notify(
    `${model.id} · ${actual} · kept for this model in this session (/settings keeps it after a restart)`,
    "info",
  );
  return actual;
}

// TOOLS "Model and level": change the model (then its level) or the level.
export async function openModelAndLevel(
  ctx: ConsoleContext,
  pi: ConsolePi,
  memory: LevelMemory,
): Promise<void> {
  const model = currentModel(ctx);
  const level = levelLabel(
    model,
    safely(() => pi.getThinkingLevel(), undefined),
  );
  const title =
    model === undefined
      ? "Model and level · no model selected"
      : `Model and level · ${model.id} · ${level}`;
  const choice = await ctx.ui.select(title, ["Change model", "Change reasoning level", "Cancel"]);
  if (choice === "Change model") {
    const chosen = await chooseModel(ctx, pi);
    if (chosen !== undefined && supportedLevels(chosen).length > 1)
      await chooseLevel(ctx, pi, memory);
  } else if (choice === "Change reasoning level") {
    await chooseLevel(ctx, pi, memory);
  }
}
