import { runHaril } from "./cli.js";
import { frameGlyph, paddedCell, visualText } from "./dashboard-theme.js";
import {
  type DelegationView,
  decodeDelegationView,
  effectText,
  fieldAt,
  GROUP_TITLES,
  harilRefOf,
  listArg,
  PI_LEVELS,
  parseEntry,
  rangeText,
  type SettingField,
  type SettingValue,
  sourceText,
  valueText,
} from "./delegation-settings.js";
import { supportedLevels, tokenCount } from "./model-levels.js";
import { groupModels } from "./model-picker.js";
import { keyOf } from "./orchestration-state.js";
import type { ConsoleContext, ConsoleMouseEvent, PiModel } from "./pi-types.js";
import { textWidth, truncate } from "./text.js";

// The Delegation section of the TOOLS module (docs/modos-y-delegacion.md 7.7; phase F7): every delegation setting of
// haril.json with its value and its source, grouped (context per layer, limits, models and levels per layer, quota,
// watchdog, autonomy, commands, research), in a full-size overlay. A click on a setting edits it, as Enter does; R takes
// it back to its default; arrows, PgUp/PgDn and the wheel move; Esc closes. An edit runs outside the overlay, in Pi's
// own dialogs: a number is typed (300k, 15 min...), a model is picked from HARIL's models with credentials and a level
// from the levels that model publishes; the change is confirmed with its old and new value and saved with
// `haril config set`, which checks it again and keeps every other key. Then the overlay comes back on the same row.

export interface DelegationPanelHost {
  readonly cwd?: string;
  // The console mode: CONSULT shows the settings and refuses changes.
  readonly mode?: () => string;
}

type PanelTarget =
  | { readonly kind: "row"; readonly index: number }
  | { readonly kind: "edit" }
  | { readonly kind: "reset" }
  | { readonly kind: "close" };

export interface PanelHit {
  readonly row: number;
  readonly start: number;
  readonly end: number;
  readonly target: PanelTarget;
}

export interface PanelState {
  readonly view: DelegationView;
  selected: number;
  offset: number;
}

export type PanelEffect =
  | { readonly kind: "edit"; readonly path: string }
  | { readonly kind: "reset"; readonly path: string };

type Line =
  | { readonly kind: "group"; readonly title: string }
  | { readonly kind: "field"; readonly index: number };

const LABEL_MIN = 12;
const MIN_WIDTH = 40;
const SOURCE_WIDTH = 11;
const CONSULT_REFUSAL =
  "CONSULT mode is read-only: the delegation settings can be read, not changed. Switch with /mode action (or Alt+M) first.";

function linesOf(view: DelegationView): Line[] {
  const lines: Line[] = [];
  let group: string | undefined;
  view.fields.forEach((field, index) => {
    if (field.group !== group) {
      group = field.group;
      lines.push({ kind: "group", title: GROUP_TITLES[field.group] ?? field.group.toUpperCase() });
    }
    lines.push({ kind: "field", index });
  });
  return lines;
}

function fit(text: string, width: number): string {
  const cut = truncate(text, Math.max(0, width));
  return cut + " ".repeat(Math.max(0, width - textWidth(cut)));
}

function boxed(content: string): string {
  return `${frameGlyph("│")}${content}${frameGlyph("│")}`;
}

// The overlay's screen: a title with the file, the settings in groups (the selected one marked), and a footer with the
// selected setting's range and effect and the buttons. Exactly `height` lines of `width` columns.
export function renderDelegationScreen(
  state: PanelState,
  width: number,
  height: number,
): { lines: string[]; hits: PanelHit[] } {
  const inner = Math.max(1, width - 2);
  const hits: PanelHit[] = [];
  const lines: string[] = [];
  const close = "[Esc Close]";
  const title = " DELEGATION SETTINGS · TOOLS";
  const titleRoom = Math.max(0, inner - textWidth(close) - 1);
  lines.push(
    `${frameGlyph("┌")}${paddedCell(fit(title, titleRoom), titleRoom, "yellow")}${visualText(" ", "text", "base")}${visualText(close, "cyan", "panel")}${frameGlyph("┐")}`,
  );
  hits.push({
    row: 0,
    start: 1 + titleRoom + 1,
    end: 1 + titleRoom + 1 + textWidth(close),
    target: { kind: "close" },
  });
  lines.push(
    boxed(
      paddedCell(
        ` ${state.view.configPath} · yellow values come from haril.json, the rest are defaults`,
        inner,
        "muted",
      ),
    ),
  );

  const all = linesOf(state.view);
  const footerRows = 4;
  const room = Math.max(1, height - lines.length - footerRows);
  const selectedLine = all.findIndex(
    (line) => line.kind === "field" && line.index === state.selected,
  );
  // The selected row stays in sight; its group title too when it fits.
  if (selectedLine < state.offset + 1) state.offset = Math.max(0, selectedLine - 1);
  if (selectedLine >= state.offset + room) state.offset = selectedLine - room + 1;
  state.offset = Math.max(0, Math.min(state.offset, Math.max(0, all.length - room)));

  // Columns: marker, label, value and (from 60 columns) source; they always add up to the inner width.
  const sourceWidth = inner >= 60 ? SOURCE_WIDTH : 0;
  const valueWidth = Math.max(8, Math.min(40, Math.floor((inner - 4) * 0.42)));
  const labelWidth = Math.max(
    LABEL_MIN,
    inner - 3 - valueWidth - (sourceWidth > 0 ? sourceWidth + 2 : 1),
  );
  for (const line of all.slice(state.offset, state.offset + room)) {
    const row = lines.length;
    if (line.kind === "group") {
      lines.push(boxed(paddedCell(` ${line.title}`, inner, "teal")));
      continue;
    }
    const field = state.view.fields[line.index] as SettingField;
    const selected = line.index === state.selected;
    const background = selected ? "selected" : "base";
    const marker = selected ? " ▶ " : "   ";
    const fromFile = field.source === "file";
    lines.push(
      boxed(
        [
          paddedCell(marker, 3, "yellow", background),
          paddedCell(field.label, labelWidth, "text", background),
          paddedCell(" ", 1, "text", background),
          paddedCell(valueText(field), valueWidth, fromFile ? "yellow" : "cyan", background),
          sourceWidth === 0 ? "" : paddedCell(" ", 1, "text", background),
          paddedCell(sourceText(field), sourceWidth, fromFile ? "yellow" : "muted", background),
        ].join(""),
      ),
    );
    hits.push({ row, start: 1, end: width - 1, target: { kind: "row", index: line.index } });
  }
  while (lines.length < height - footerRows) lines.push(boxed(paddedCell("", inner)));

  const field = state.view.fields[state.selected];
  lines.push(`${frameGlyph("├")}${frameGlyph("─".repeat(inner))}${frameGlyph("┤")}`);
  lines.push(
    boxed(
      paddedCell(
        field === undefined ? "" : ` ${field.path} · ${rangeText(field)} · ${effectText(field)}`,
        inner,
        "muted",
      ),
    ),
  );
  const narrow = inner < 60;
  const buttons: [string, PanelTarget][] = [
    ["[Enter Edit]", { kind: "edit" }],
    [narrow ? "[R Reset]" : "[R Reset to default]", { kind: "reset" }],
    [narrow ? "[Esc]" : "[Esc Close]", { kind: "close" }],
  ];
  let column = 1;
  const parts: string[] = [visualText(" ", "text", "base")];
  for (const [label, target] of buttons) {
    hits.push({ row: lines.length, start: column + 1, end: column + 1 + textWidth(label), target });
    parts.push(visualText(label, "cyan", "panel"), visualText(" ", "text", "base"));
    column += textWidth(label) + 1;
  }
  const hint = "  click a setting or ↑/↓ and Enter";
  const used = column + 1;
  parts.push(paddedCell(hint, Math.max(0, inner - used + 1), "dim"));
  lines.push(boxed(parts.join("")));
  lines.push(`${frameGlyph("└")}${frameGlyph("─".repeat(inner))}${frameGlyph("┘")}`);
  return { lines: lines.slice(0, Math.max(height, 1)), hits };
}

function move(state: PanelState, delta: number): void {
  const count = state.view.fields.length;
  state.selected = Math.max(0, Math.min(count - 1, state.selected + delta));
}

// Opens the overlay; resolves undefined when closed, or the edit or reset the user asked for (run by the caller, whose
// dialogs need the overlay gone).
export function openDelegationPanel(
  ctx: ConsoleContext,
  state: PanelState,
): Promise<PanelEffect | undefined> {
  return ctx.ui.custom<PanelEffect | undefined>(
    (tui, _theme, _keybindings, done) => {
      let screen: { lines: string[]; hits: PanelHit[] } = { lines: [], hits: [] };
      let finished = false;
      const finish = (effect: PanelEffect | undefined): void => {
        if (finished) return;
        finished = true;
        done(effect);
      };
      const path = (): string => (state.view.fields[state.selected] as SettingField).path;
      const act = (target: PanelTarget): void => {
        if (target.kind === "close") finish(undefined);
        else if (target.kind === "edit") finish({ kind: "edit", path: path() });
        else if (target.kind === "reset") finish({ kind: "reset", path: path() });
        else {
          state.selected = target.index;
          finish({ kind: "edit", path: path() });
        }
      };
      return {
        render(width) {
          screen = renderDelegationScreen(
            state,
            Math.max(MIN_WIDTH, width),
            Math.max(10, tui.terminal.rows),
          );
          return screen.lines;
        },
        handleInput(data) {
          const key = keyOf(data);
          if (key === "escape" || key === "q") return finish(undefined);
          if (key === "enter" || key === "e") return act({ kind: "edit" });
          if (key === "r") return act({ kind: "reset" });
          if (key === "up" || key === "k") move(state, -1);
          else if (key === "down" || key === "j") move(state, 1);
          else if (data === "\u001b[5~") move(state, -10);
          else if (data === "\u001b[6~") move(state, 10);
          else if (data === "\u001b[H" || data === "g") move(state, -state.view.fields.length);
          else if (data === "\u001b[F" || data === "G") move(state, state.view.fields.length);
          else return;
          tui.requestRender();
        },
        handleMouse(event: ConsoleMouseEvent) {
          if (event.type === "wheel") {
            const delta = Math.sign(event.wheelDelta ?? 0);
            if (delta !== 0) move(state, delta);
            tui.requestRender();
            return { handled: true, render: true };
          }
          if (event.type !== "click" || event.button !== "left") return undefined;
          const hit = screen.hits.find(
            (item) => item.row === event.y && event.x >= item.start && event.x < item.end,
          );
          if (hit === undefined) return undefined;
          act(hit.target);
          return { handled: true, render: true };
        },
        invalidate() {},
      };
    },
    { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
  );
}

// `haril config get delegation --json`, or the reason it could not be read.
async function loadDelegationView(
  cwd?: string,
): Promise<{ readonly view?: DelegationView; readonly error?: string }> {
  const result = await runHaril(["config", "get", "delegation", "--json"], {
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: 10_000,
  });
  if (!result.ok) {
    return {
      error: result.stderr.trim() || `haril config get failed (${result.code ?? "unknown"})`,
    };
  }
  try {
    const view = decodeDelegationView(JSON.parse(result.stdout) as unknown);
    return view === undefined
      ? { error: "haril config get returned an unexpected shape" }
      : { view };
  } catch {
    return { error: "haril config get returned invalid JSON" };
  }
}

function available(ctx: ConsoleContext): PiModel[] {
  try {
    return ctx.modelRegistry.getAvailable().filter((model) => harilRefOf(model) !== undefined);
  } catch {
    return [];
  }
}

function piModelOf(ctx: ConsoleContext, ref: string | null): PiModel | undefined {
  if (ref === null) return undefined;
  return available(ctx).find((model) => harilRefOf(model) === ref);
}

const NOT_PINNED = "Not pinned: the parent or the difficulty table chooses";

// A layer's model: HARIL's models that have credentials, by provider and account, each with its context and levels.
async function pickModel(
  ctx: ConsoleContext,
  field: SettingField,
): Promise<{ readonly arg: string; readonly value: SettingValue } | undefined> {
  const models = available(ctx);
  const first = await ctx.ui.select(`${field.label} · ${rangeText(field)}`, [
    ...(models.length === 0 ? [] : ["Choose a model"]),
    NOT_PINNED,
  ]);
  if (first === undefined) return undefined;
  if (first === NOT_PINNED) return { arg: "null", value: null };
  const groups = groupModels(models);
  let group = groups[0];
  if (groups.length > 1) {
    const labels = groups.map((item) => `${item.label} · ${item.models.length} models`);
    const choice = await ctx.ui.select(`${field.label} · provider or account`, labels);
    group = choice === undefined ? undefined : groups[labels.indexOf(choice)];
  }
  if (group === undefined) return undefined;
  const labels = group.models.map((model) => {
    const levels = supportedLevels(model);
    const ref = harilRefOf(model) as string;
    return `${ref === field.value ? "●" : " "} ${ref} · ctx ${tokenCount(model.contextWindow)} · ${levels.length > 1 ? `levels ${levels.join(" ")}` : "no published levels"}`;
  });
  const choice = await ctx.ui.select(`${field.label} · ${group.label}`, labels);
  const model = choice === undefined ? undefined : group.models[labels.indexOf(choice)];
  const ref = model === undefined ? undefined : harilRefOf(model);
  return ref === undefined ? undefined : { arg: ref, value: ref };
}

const GATEWAY_DEFAULT = "Gateway default: no level asked for";

// A layer's level: only the levels its pinned model publishes (`pinned`: a model just chosen for the layer); without a
// pinned model every Pi level, since the agent runs at the nearest level its model publishes.
async function pickLevel(
  ctx: ConsoleContext,
  view: DelegationView,
  field: SettingField,
  pinned?: string,
): Promise<{ readonly arg: string; readonly value: SettingValue } | undefined> {
  const modelPath = field.path.replace(/\.level$/, ".model");
  const ref = pinned ?? fieldAt(view, modelPath)?.value ?? null;
  const model = piModelOf(ctx, typeof ref === "string" ? ref : null);
  let levels: readonly string[] = PI_LEVELS;
  let title = `${field.label} · no model pinned: the agent runs at the nearest level its model publishes`;
  if (typeof ref === "string") {
    if (model === undefined) {
      title = `${field.label} · ${ref} is not among the models with credentials: every level is offered`;
    } else {
      levels = supportedLevels(model).length > 1 ? supportedLevels(model) : [];
      title =
        levels.length === 0
          ? `${field.label} · ${ref} publishes no reasoning levels`
          : `${field.label} · the levels ${ref} publishes`;
    }
  }
  const labels = [
    `${field.value === null ? "●" : " "} ${GATEWAY_DEFAULT}`,
    ...levels.map((level) => `${level === field.value ? "●" : " "} ${level}`),
  ];
  const choice = await ctx.ui.select(title, labels);
  if (choice === undefined) return undefined;
  const index = labels.indexOf(choice);
  if (index === 0) return { arg: "null", value: null };
  const level = levels[index - 1];
  return level === undefined ? undefined : { arg: level, value: level };
}

const STOP_CHOICES = ["after_plan", "before_merge", "on_audit_failure", "at_end"];

// A list, changed one entry at a time: add, remove, clear, then done.
async function editList(
  ctx: ConsoleContext,
  field: SettingField,
): Promise<{ readonly arg: string; readonly value: SettingValue } | undefined> {
  let list = Array.isArray(field.value) ? [...(field.value as readonly string[])] : [];
  for (;;) {
    const options = [
      "Done",
      "Add an entry",
      ...list.map((item) => `Remove ${item}`),
      ...(list.length > 0 ? ["Clear the list"] : []),
    ];
    const choice = await ctx.ui.select(`${field.label} · now: ${valueText(field, list)}`, options);
    if (choice === undefined) return undefined;
    if (choice === "Done") return { arg: listArg(list), value: list };
    if (choice === "Clear the list") list = [];
    else if (choice.startsWith("Remove ")) {
      const item = choice.slice("Remove ".length);
      list = list.filter((entry) => entry !== item);
    } else {
      const added = await addEntry(ctx, field, list);
      if (added !== undefined && !list.includes(added)) list.push(added);
    }
  }
}

async function addEntry(
  ctx: ConsoleContext,
  field: SettingField,
  list: readonly string[],
): Promise<string | undefined> {
  if (field.kind.type === "model-list") {
    const refs = available(ctx)
      .map((model) => harilRefOf(model) as string)
      .filter((ref) => !list.includes(ref));
    if (refs.length === 0) {
      ctx.ui.notify(
        "No other HARIL model has credentials: /login, or set a provider key.",
        "warning",
      );
      return undefined;
    }
    return await ctx.ui.select(`${field.label} · add a model`, refs);
  }
  if (field.kind.type === "stop-list") {
    const choice = await ctx.ui.select(`${field.label} · add a stop`, [
      ...STOP_CHOICES.filter((stop) => !list.includes(stop)),
      "on_budget_pct:<n>",
      "after_node:<id>",
    ]);
    if (choice === undefined) return undefined;
    if (!choice.includes("<")) return choice;
    const prefix = choice.slice(0, choice.indexOf(":") + 1);
    const typed = (
      await ctx.ui.input(`${field.label} · ${choice}`, choice.includes("pct") ? "80" : "part-1")
    )?.trim();
    return typed === undefined || typed === "" ? undefined : `${prefix}${typed}`;
  }
  const typed = (await ctx.ui.input(`${field.label} · add an entry`, "pnpm test"))?.trim();
  return typed === undefined || typed === "" ? undefined : typed;
}

// The new value of a field, from the dialog its kind needs; undefined when the user went back.
async function askValue(
  ctx: ConsoleContext,
  view: DelegationView,
  field: SettingField,
): Promise<{ readonly arg: string; readonly value: SettingValue } | undefined> {
  const kind = field.kind;
  switch (kind.type) {
    case "always-true":
      ctx.ui.notify(`${field.label}: ${rangeText(field)}.`, "info");
      return undefined;
    case "boolean": {
      const choice = await ctx.ui.select(`${field.label} · now ${valueText(field)}`, ["Yes", "No"]);
      return choice === undefined
        ? undefined
        : { arg: choice === "Yes" ? "true" : "false", value: choice === "Yes" };
    }
    case "enum": {
      const choice = await ctx.ui.select(field.label, [...kind.values]);
      return choice === undefined ? undefined : { arg: choice, value: choice };
    }
    case "model-or-null":
      return pickModel(ctx, field);
    case "level-or-null":
      return pickLevel(ctx, view, field);
    case "model-list":
    case "command-list":
    case "stop-list":
      return editList(ctx, field);
    default: {
      for (;;) {
        const typed = await ctx.ui.input(
          `${field.label} · now ${valueText(field)} · ${rangeText(field)}`,
          kind.type === "integer" && kind.unit === "ms" ? "15 min" : String(field.value ?? ""),
        );
        if (typed === undefined) return undefined;
        const parsed = parseEntry(field, typed);
        if (parsed.ok) return { arg: parsed.arg, value: parsed.value };
        ctx.ui.notify(parsed.error, "warning");
      }
    }
  }
}

// Saves one change with `haril config set` after the user confirmed it; true when saved.
async function saveChange(
  ctx: ConsoleContext,
  host: DelegationPanelHost,
  field: SettingField,
  args: readonly string[],
  after: string,
): Promise<boolean> {
  const confirmed = await ctx.ui.confirm(
    "Change a delegation setting",
    [
      field.label,
      field.path,
      `${valueText(field)} (${sourceText(field)})  →  ${after}`,
      `This writes haril.json and ${effectText(field)}.`,
    ].join("\n"),
  );
  if (!confirmed) return false;
  const result = await runHaril(["config", "set", field.path, ...args, "--json"], {
    ...(host.cwd === undefined ? {} : { cwd: host.cwd }),
    timeoutMs: 10_000,
  });
  if (!result.ok) {
    const lines = result.stderr.trim().split(/\r?\n/).slice(0, 4).join(" ");
    ctx.ui.notify(`Not saved: ${lines || "haril config set failed"}`, "error");
    return false;
  }
  ctx.ui.notify(`${field.label}: ${after} · saved in haril.json · ${effectText(field)}`, "info");
  return true;
}

async function editField(
  ctx: ConsoleContext,
  host: DelegationPanelHost,
  view: DelegationView,
  field: SettingField,
): Promise<void> {
  const next = await askValue(ctx, view, field);
  if (next === undefined) return;
  const saved = await saveChange(ctx, host, field, [next.arg], valueText(field, next.value));
  // A new model for a layer: its level next, from the levels that model publishes.
  if (saved && field.kind.type === "model-or-null" && next.value !== null) {
    const level = fieldAt(view, field.path.replace(/\.model$/, ".level"));
    if (level !== undefined && typeof next.value === "string") {
      const chosen = await pickLevel(ctx, view, level, next.value);
      if (chosen !== undefined && chosen.value !== level.value) {
        await saveChange(ctx, host, level, [chosen.arg], valueText(level, chosen.value));
      }
    }
  }
}

async function resetField(
  ctx: ConsoleContext,
  host: DelegationPanelHost,
  field: SettingField,
): Promise<void> {
  if (field.source === "default") {
    ctx.ui.notify(`${field.label} already has its default: ${valueText(field)}.`, "info");
    return;
  }
  const inherits = field.kind.type === "integer" && field.kind.inherits !== undefined;
  await saveChange(
    ctx,
    host,
    field,
    ["--reset"],
    inherits
      ? "inherits the general threshold (default)"
      : `${valueText(field, field.default)} (default)`,
  );
}

// The TOOLS "Delegation settings" control and /delegation: the overlay, each edit in Pi's dialogs, the overlay again on
// the same row, until it is closed.
export async function openDelegationSettings(
  ctx: ConsoleContext,
  host: DelegationPanelHost,
  startAt?: string,
): Promise<void> {
  let selectedPath = startAt;
  let offset = 0;
  for (;;) {
    const loaded = await loadDelegationView(host.cwd);
    if (loaded.view === undefined) {
      ctx.ui.notify(`Delegation settings unavailable: ${loaded.error ?? "unknown error"}`, "error");
      return;
    }
    const view = loaded.view;
    const index =
      selectedPath === undefined
        ? 0
        : view.fields.findIndex((field) => field.path === selectedPath);
    const state: PanelState = { view, selected: Math.max(0, index), offset };
    const effect = await openDelegationPanel(ctx, state);
    offset = state.offset;
    if (effect === undefined) return;
    selectedPath = effect.path;
    const field = fieldAt(view, effect.path);
    if (field === undefined) continue;
    if (host.mode?.() === "consult") {
      ctx.ui.notify(CONSULT_REFUSAL, "warning");
      continue;
    }
    if (effect.kind === "reset") await resetField(ctx, host, field);
    else await editField(ctx, host, view, field);
  }
}
