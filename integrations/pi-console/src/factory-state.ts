import { selectedRowId, settingRows } from "./factory-rows.js";
import {
  type FactorySystemData,
  isEditable,
  sliderRange,
  valueToText,
} from "./factory-settings.js";
import type { FactoryColumn, FactoryModel } from "./factory-types.js";
import { keyOf } from "./orchestration-state.js";

// The factory view's state and controller, pure: a key or a click in, a new state (and at most one effect for the
// console to run) out. The console keeps one state per session, so the view opens again on the tab it left.

export const FACTORY_TABS = [
  "avance",
  "actividades",
  "tablero",
  "agentes",
  "conexiones",
  "modelos",
  "sistema",
] as const;
export type FactoryTab = (typeof FACTORY_TABS)[number];

export const FACTORY_COLUMNS: readonly FactoryColumn[] = [
  "por_hacer",
  "en_curso",
  "detenidas",
  "errores",
  "hechas",
];

export const ACTIVITY_VIEWS = ["activas", "en_cola", "fallidas", "hechas", "te_necesitan"] as const;
export type ActivityView = (typeof ACTIVITY_VIEWS)[number];

const MODELOS_VIEWS = ["cuentas", "monitor", "historial", "cache"] as const;
type ModelosView = (typeof MODELOS_VIEWS)[number];

const CONEXIONES_VIEWS = ["cadena", "arbol", "red", "secuencia", "relevo"] as const;
type ConexionesView = (typeof CONEXIONES_VIEWS)[number];

const SISTEMA_VIEWS = ["mapa", "inventario", "ajustes"] as const;
type SistemaView = (typeof SISTEMA_VIEWS)[number];

export const AVANCE_SCOPES = ["proyecto", "tarea", "agente", "modelo"] as const;
export type AvanceScope = (typeof AVANCE_SCOPES)[number];

// What a key can ask the console to do through the CLI, after the person confirmed it.
export type FactoryAction =
  | {
      readonly kind: "continue";
      readonly workflowId: string;
      readonly projectSlug: string | null;
      readonly label: string;
    }
  | {
      readonly kind: "approve" | "deny";
      readonly approvalId: string;
      readonly label: string;
    }
  // Reads the quota again; it only records what the providers answer, so it asks nothing.
  | { readonly kind: "reread"; readonly label: string }
  // Writes one setting through haril config set.
  | {
      readonly kind: "setting";
      readonly path: string;
      readonly value: string;
      readonly label: string;
    };

export interface FactoryState {
  readonly tab: FactoryTab;
  // The selected row of each tab, so coming back to a tab finds it where it was.
  readonly selection: Readonly<Record<FactoryTab, number>>;
  // How many selectable rows each tab has. The feed's model and the Sistema tab's settings set them.
  readonly rowCounts: Readonly<Record<FactoryTab, number>>;
  readonly detail: boolean;
  // Null until haril factory watch printed its first line.
  readonly model: FactoryModel | null;
  // True once the child kept dying or could not start.
  readonly feedEnded: boolean;
  // True in a mode that refuses the commands that change state (CONSULT): the keys that would run them do not show.
  readonly readOnly: boolean;
  readonly activityView: ActivityView;
  readonly eventLog: boolean;
  readonly agentsTree: boolean;
  readonly avanceScope: AvanceScope;
  readonly modelosView: ModelosView;
  readonly conexionesView: ConexionesView;
  readonly sistemaView: SistemaView;
  // What the Sistema tab reads apart from the feed; null until it arrived.
  readonly system: FactorySystemData | null;
  // A slider moved and not saved yet.
  readonly settingDraft: { readonly path: string; readonly value: number } | null;
  // An exact value being typed.
  readonly settingEdit: { readonly path: string; readonly text: string } | null;
  // The setting whose last write succeeded.
  readonly savedPath: string | null;
  // True in a mode that refuses to change settings (CONSULT and PLAN).
  readonly settingsLocked: boolean;
  // The text each tab is filtered by, and whether `/` is taking it right now.
  readonly filter: Readonly<Record<FactoryTab, string>>;
  readonly filtering: boolean;
  // The moment each row was last read, by its id: a row that changed after it shows the unread dot.
  readonly seen: Readonly<Record<string, number>>;
  readonly confirm: FactoryAction | null;
  // The answer to the last action, or why it was refused.
  readonly notice: string | null;
}

// What a hit-box under the pointer stands for. The same target means the same action as its key.
export type FactoryTarget =
  | { readonly kind: "tab"; readonly tab: FactoryTab }
  | { readonly kind: "back" | "close" };

type FactoryEffect = "close" | "new-task" | FactoryAction;

export interface FactoryTransition {
  readonly state: FactoryState;
  readonly effect?: FactoryEffect;
  // False for input the view does not own, so the overlay can ignore it.
  readonly handled: boolean;
}

function perTab<Value>(value: Value): Record<FactoryTab, Value> {
  return Object.fromEntries(FACTORY_TABS.map((tab) => [tab, value])) as Record<FactoryTab, Value>;
}

export function initialFactoryState(): FactoryState {
  return {
    tab: "avance",
    selection: perTab(0),
    rowCounts: perTab(0),
    detail: false,
    model: null,
    feedEnded: false,
    readOnly: false,
    activityView: "activas",
    eventLog: false,
    agentsTree: true,
    avanceScope: "proyecto",
    modelosView: "cuentas",
    conexionesView: "cadena",
    sistemaView: "mapa",
    system: null,
    settingDraft: null,
    settingEdit: null,
    savedPath: null,
    settingsLocked: false,
    filter: perTab(""),
    filtering: false,
    seen: {},
    confirm: null,
    notice: null,
  };
}

// The rows of the tabs with data, as selectedRowId and the views read them. Lives here so a change of filter or sub-view
// recounts in one place.
const DATA_TABS: readonly FactoryTab[] = [
  "avance",
  "actividades",
  "tablero",
  "agentes",
  "modelos",
  "conexiones",
  "sistema",
];

function recount(state: FactoryState): FactoryState {
  if (state.model === null) return state;
  const rowCounts = { ...state.rowCounts };
  const selection = { ...state.selection };
  for (const tab of DATA_TABS) {
    rowCounts[tab] = rowIdsOf(state, tab).length;
    selection[tab] = Math.max(0, Math.min(Math.max(0, rowCounts[tab] - 1), selection[tab]));
  }
  return { ...state, rowCounts, selection };
}

function rowIdsOf(state: FactoryState, tab: FactoryTab): readonly string[] {
  return selectedRowId(state, tab).ids;
}

// A new line of the feed. The selected row stays selected when it still exists; the first model marks what is there as
// read, so only what happens from now on shows as unread (a question for the person is never marked).
export function factoryModelArrived(state: FactoryState, model: FactoryModel): FactoryState {
  const before = Object.fromEntries(
    DATA_TABS.map((tab) => {
      const { ids, index } = selectedRowId(state, tab);
      return [tab, ids[index]];
    }),
  );
  const seen =
    state.model === null
      ? Object.fromEntries(model.tasks.map((task) => [task.id, task.updatedAt]))
      : state.seen;
  const next = recount({ ...state, model, seen, feedEnded: false });
  const selection = { ...next.selection };
  for (const tab of DATA_TABS) {
    const found = rowIdsOf(next, tab).indexOf(before[tab] ?? "");
    if (found >= 0) selection[tab] = found;
  }
  return { ...next, selection };
}

export function factoryFeedEnded(state: FactoryState): FactoryState {
  return { ...state, feedEnded: true };
}

export function factorySystemArrived(state: FactoryState, system: FactorySystemData): FactoryState {
  return recount({ ...state, system });
}

// The write of this setting succeeded: the screen may say so.
export function factorySettingSaved(state: FactoryState, path: string): FactoryState {
  return { ...state, savedPath: path };
}

export function factoryNotice(state: FactoryState, notice: string | null): FactoryState {
  return { ...state, notice };
}

function handled(state: FactoryState, effect?: FactoryEffect): FactoryTransition {
  return effect === undefined ? { state, handled: true } : { state, effect, handled: true };
}

function setTab(state: FactoryState, tab: FactoryTab): FactoryTransition {
  return handled({ ...state, tab, detail: false, filtering: false, confirm: null, notice: null });
}

function stepTab(state: FactoryState, step: number): FactoryTransition {
  const index = FACTORY_TABS.indexOf(state.tab);
  const next = FACTORY_TABS[(index + step + FACTORY_TABS.length) % FACTORY_TABS.length];
  return setTab(state, next as FactoryTab);
}

// Up and down within the tab's rows, stopping at the ends. An open detail shows one row, so nothing moves under it.
export function factoryMove(state: FactoryState, delta: number): FactoryTransition {
  if (state.detail) return handled(state);
  const last = Math.max(0, state.rowCounts[state.tab] - 1);
  const row = Math.max(0, Math.min(last, state.selection[state.tab] + delta));
  return handled({ ...state, selection: { ...state.selection, [state.tab]: row } });
}

function backOrClose(state: FactoryState): FactoryTransition {
  if (state.detail) return handled({ ...state, detail: false });
  if (state.filter[state.tab] !== "") return handled(withFilter(state, ""));
  if (state.tab === "actividades" && state.eventLog)
    return handled(recount({ ...state, eventLog: false }));
  return handled(state, "close");
}

function withFilter(state: FactoryState, text: string): FactoryState {
  return recount({
    ...state,
    filter: { ...state.filter, [state.tab]: text },
    selection: { ...state.selection, [state.tab]: 0 },
  });
}

function filterKey(state: FactoryState, data: string, key: string | undefined): FactoryTransition {
  if (key === "escape") return handled({ ...withFilter(state, ""), filtering: false });
  if (key === "enter") return handled({ ...state, filtering: false });
  const current = state.filter[state.tab];
  if (data === "\u007f" || data === "\b")
    return handled(withFilter(state, Array.from(current).slice(0, -1).join("")));
  // Printable text only, also when several characters arrive at once (a paste).
  const printable = Array.from(data).every((char) => char >= " " && char !== "\u007f");
  if (data !== "" && printable) return handled(withFilter(state, `${current}${data}`));
  return handled(state);
}

function confirmKey(state: FactoryState, key: string | undefined): FactoryTransition {
  const action = state.confirm;
  if (action === null) return handled(state);
  if (key === "y" || key === "s" || key === "enter")
    return handled({ ...state, confirm: null }, action);
  if (key === "n" || key === "escape") return handled({ ...state, confirm: null });
  return handled(state);
}

function cycle<Value>(list: readonly Value[], value: Value, step: number): Value {
  const index = list.indexOf(value);
  return list[(index + step + list.length) % list.length] as Value;
}

// h and l on the board: to the first card of the column next to the selected card's, skipping the empty ones.
function moveColumn(state: FactoryState, step: number): FactoryTransition {
  const tasks = selectedRowId(state, "tablero").tasks;
  const current = tasks[state.selection.tablero]?.column ?? "por_hacer";
  let index = FACTORY_COLUMNS.indexOf(current);
  for (let tries = 0; tries < FACTORY_COLUMNS.length; tries++) {
    index += step;
    const column = FACTORY_COLUMNS[index];
    if (column === undefined) break;
    const first = tasks.findIndex((task) => task.column === column);
    if (first >= 0) {
      return handled({ ...state, selection: { ...state.selection, tablero: first } });
    }
  }
  return handled(state);
}

// The workflow stop the selected row belongs to; with nothing that says otherwise, the only one there is.
export function continueTarget(state: FactoryState): FactoryAction | null {
  const { model } = state;
  if (model === null || !DATA_TABS.includes(state.tab)) return null;
  const waiting = model.workflows.filter((row) => row.state === "awaiting_human");
  if (waiting.length === 0) return null;
  const { workflowId } = selectedRowId(state, state.tab);
  const chosen =
    waiting.find((row) => row.id === workflowId) ?? (waiting.length === 1 ? waiting[0] : undefined);
  if (chosen === undefined) return null;
  return {
    kind: "continue",
    workflowId: chosen.id,
    projectSlug: chosen.projectSlug,
    label: `continuar el flujo «${chosen.goal}»`,
  };
}

// The approval the selected row is, in the Te necesitan view.
export function approvalTarget(state: FactoryState): { id: string; title: string } | null {
  if (state.model === null || state.tab !== "actividades" || state.eventLog) return null;
  if (state.activityView !== "te_necesitan") return null;
  const { approval } = selectedRowId(state, "actividades");
  return approval === undefined ? null : { id: approval.id, title: approval.title };
}

const READ_ONLY = "Este modo es de solo lectura: cambia de modo con Alt+M para hacerlo.";

function selectedSetting(state: FactoryState) {
  if (state.tab !== "sistema" || state.sistemaView !== "ajustes" || state.detail) return undefined;
  return settingRows(state)[state.selection.sistema];
}

function save(state: FactoryState, path: string, value: string, label: string): FactoryTransition {
  return handled(
    { ...state, settingDraft: null, settingEdit: null, savedPath: null, notice: "Guardando…" },
    { kind: "setting", path, value, label },
  );
}

// ← and → on a slider: a new value, not saved until Enter.
function nudgeSetting(state: FactoryState, step: number): FactoryTransition | undefined {
  const field = selectedSetting(state);
  if (field === undefined) return undefined;
  const range = sliderRange(field);
  if (range === undefined || !isEditable(field)) return undefined;
  if (state.settingsLocked) return handled({ ...state, notice: READ_ONLY });
  const from =
    state.settingDraft?.path === field.path
      ? state.settingDraft.value
      : typeof field.value === "number"
        ? field.value
        : range.min;
  const value = Math.max(range.min, Math.min(range.max, from + step * range.step));
  return handled({
    ...state,
    settingDraft: { path: field.path, value },
    savedPath: null,
    notice: null,
  });
}

function settingEnter(state: FactoryState): FactoryTransition | undefined {
  const field = selectedSetting(state);
  if (field === undefined) return undefined;
  if (state.settingsLocked) return handled({ ...state, notice: READ_ONLY });
  if (!isEditable(field)) return handled(state);
  if (state.settingDraft?.path === field.path) {
    return save(state, field.path, String(state.settingDraft.value), field.label);
  }
  if (field.kind.type === "boolean")
    return save(state, field.path, String(field.value !== true), field.label);
  return handled({
    ...state,
    settingEdit: { path: field.path, text: valueToText(field.value) },
    savedPath: null,
    notice: null,
  });
}

function settingEditKey(
  state: FactoryState,
  data: string,
  key: string | undefined,
): FactoryTransition {
  const edit = state.settingEdit;
  if (edit === null) return handled(state);
  if (key === "escape") return handled({ ...state, settingEdit: null });
  if (key === "enter") return save(state, edit.path, edit.text.trim(), edit.path);
  if (data === "\u007f" || data === "\b") {
    return handled({
      ...state,
      settingEdit: { ...edit, text: Array.from(edit.text).slice(0, -1).join("") },
    });
  }
  const printable =
    data !== "" && Array.from(data).every((char) => char >= " " && char !== "\u007f");
  return handled(
    printable ? { ...state, settingEdit: { ...edit, text: `${edit.text}${data}` } } : state,
  );
}

function ask(state: FactoryState, action: FactoryAction | null): FactoryTransition {
  if (action === null) return { state, handled: false };
  if (state.readOnly) return handled({ ...state, notice: READ_ONLY });
  return handled({ ...state, confirm: action, notice: null });
}

function markSeen(state: FactoryState): FactoryState {
  const { id, updatedAt } = selectedRowId(state, state.tab);
  return id === undefined ? state : { ...state, seen: { ...state.seen, [id]: updatedAt } };
}

// The keys that only mean something on one tab, with a model to act on.
function tabKey(state: FactoryState, key: string): FactoryTransition | undefined {
  if (state.model === null || state.detail) return undefined;
  switch (key) {
    case "/":
      return DATA_TABS.includes(state.tab)
        ? handled({ ...state, filtering: true, notice: null })
        : undefined;
    case "h":
      return state.tab === "tablero" ? moveColumn(state, -1) : undefined;
    case "l":
      return state.tab === "tablero" ? moveColumn(state, 1) : undefined;
    case "[":
    case "]": {
      const step = key === "]" ? 1 : -1;
      if (state.tab === "avance") {
        return handled(
          recount({
            ...state,
            avanceScope: cycle(AVANCE_SCOPES, state.avanceScope, step),
            selection: { ...state.selection, avance: 0 },
          }),
        );
      }
      if (state.tab === "modelos") {
        return handled({ ...state, modelosView: cycle(MODELOS_VIEWS, state.modelosView, step) });
      }
      if (state.tab === "sistema") {
        return handled(
          recount({
            ...state,
            sistemaView: cycle(SISTEMA_VIEWS, state.sistemaView, step),
            settingDraft: null,
          }),
        );
      }
      if (state.tab === "conexiones") {
        return handled({
          ...state,
          conexionesView: cycle(CONEXIONES_VIEWS, state.conexionesView, step),
        });
      }
      if (state.tab === "actividades" && !state.eventLog) {
        return handled(
          recount({
            ...state,
            activityView: cycle(ACTIVITY_VIEWS, state.activityView, step),
            selection: { ...state.selection, actividades: 0 },
          }),
        );
      }
      return undefined;
    }
    case "e":
      return state.tab === "actividades"
        ? handled(
            recount({
              ...state,
              eventLog: !state.eventLog,
              selection: { ...state.selection, actividades: 0 },
            }),
          )
        : undefined;
    case "t":
      return state.tab === "agentes"
        ? handled(recount({ ...state, agentsTree: !state.agentsTree }))
        : undefined;
    case "r":
      return state.tab === "modelos"
        ? handled(
            { ...state, notice: "Leyendo la cuota…" },
            { kind: "reread", label: "leer la cuota" },
          )
        : undefined;
    case "n":
      if (state.tab !== "tablero") return undefined;
      return state.readOnly ? handled({ ...state, notice: READ_ONLY }) : handled(state, "new-task");
    default:
      return undefined;
  }
}

function actionKey(state: FactoryState, key: string): FactoryTransition | undefined {
  if (state.model === null) return undefined;
  if (key === "c") {
    const action = continueTarget(state);
    return action === null ? undefined : ask(state, action);
  }
  if (key !== "a" && key !== "d") return undefined;
  const approval = approvalTarget(state);
  if (approval === null) return undefined;
  return ask(state, {
    kind: key === "a" ? "approve" : "deny",
    approvalId: approval.id,
    label: `${key === "a" ? "aprobar" : "negar"} «${approval.title}»`,
  });
}

export function factoryKey(state: FactoryState, data: string): FactoryTransition {
  const key = keyOf(data);
  if (state.confirm !== null) return confirmKey(state, key);
  if (state.filtering) return filterKey(state, data, key);
  if (state.settingEdit !== null) return settingEditKey(state, data, key);
  switch (key) {
    case "right":
      return nudgeSetting(state, 1) ?? stepTab(state, 1);
    case "left":
      return nudgeSetting(state, -1) ?? stepTab(state, -1);
    case "tab":
      return stepTab(state, 1);
    case "shift-tab":
      return stepTab(state, -1);
    case "up":
    case "k":
      return factoryMove(state, -1);
    case "down":
    case "j":
      return factoryMove(state, 1);
    case "enter": {
      const setting = settingEnter(state);
      if (setting !== undefined) return setting;
      return handled(state.rowCounts[state.tab] > 0 ? { ...markSeen(state), detail: true } : state);
    }
    case "escape":
      if (state.settingDraft !== null) return handled({ ...state, settingDraft: null });
      return backOrClose(state);
    default: {
      if (key === undefined) return { state, handled: false };
      const own = tabKey(state, key) ?? actionKey(state, key);
      if (own !== undefined) return own;
      const tab = /^[1-7]$/.test(key) ? FACTORY_TABS[Number(key) - 1] : undefined;
      return tab === undefined ? { state, handled: false } : setTab(state, tab);
    }
  }
}

export function factoryClick(state: FactoryState, target: FactoryTarget): FactoryTransition {
  switch (target.kind) {
    case "tab":
      return setTab(state, target.tab);
    case "back":
      return backOrClose(state);
    case "close":
      return handled(state, "close");
  }
}
