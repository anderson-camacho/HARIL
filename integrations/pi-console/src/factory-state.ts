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

export interface FactoryState {
  readonly tab: FactoryTab;
  // The selected row of each tab, so coming back to a tab finds it where it was.
  readonly selection: Readonly<Record<FactoryTab, number>>;
  // How many selectable rows each tab has. No tab has a data source yet, so all stay 0 until the feed sets them.
  readonly rowCounts: Readonly<Record<FactoryTab, number>>;
  readonly detail: boolean;
}

// What a hit-box under the pointer stands for. The same target means the same action as its key.
export type FactoryTarget =
  | { readonly kind: "tab"; readonly tab: FactoryTab }
  | { readonly kind: "back" | "close" };

type FactoryEffect = "close";

export interface FactoryTransition {
  readonly state: FactoryState;
  readonly effect?: FactoryEffect;
  // False for input the view does not own, so the overlay can ignore it.
  readonly handled: boolean;
}

function perTab(value: number): Record<FactoryTab, number> {
  return Object.fromEntries(FACTORY_TABS.map((tab) => [tab, value])) as Record<FactoryTab, number>;
}

export function initialFactoryState(): FactoryState {
  return { tab: "avance", selection: perTab(0), rowCounts: perTab(0), detail: false };
}

function handled(state: FactoryState, effect?: FactoryEffect): FactoryTransition {
  return effect === undefined ? { state, handled: true } : { state, effect, handled: true };
}

function setTab(state: FactoryState, tab: FactoryTab): FactoryTransition {
  return handled({ ...state, tab, detail: false });
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
  return state.detail ? handled({ ...state, detail: false }) : handled(state, "close");
}

export function factoryKey(state: FactoryState, data: string): FactoryTransition {
  const key = keyOf(data);
  switch (key) {
    case "right":
    case "tab":
      return stepTab(state, 1);
    case "left":
    case "shift-tab":
      return stepTab(state, -1);
    case "up":
    case "k":
      return factoryMove(state, -1);
    case "down":
    case "j":
      return factoryMove(state, 1);
    case "enter":
      return handled(state.rowCounts[state.tab] > 0 ? { ...state, detail: true } : state);
    case "escape":
      return backOrClose(state);
    default: {
      const tab =
        key !== undefined && /^[1-7]$/.test(key) ? FACTORY_TABS[Number(key) - 1] : undefined;
      return tab === undefined ? { state, handled: false } : setTab(state, tab);
    }
  }
}

export function factoryClick(state: FactoryState, target: FactoryTarget): FactoryTransition {
  switch (target.kind) {
    case "tab":
      return setTab(state, target.tab);
    case "back":
      return handled({ ...state, detail: false });
    case "close":
      return handled(state, "close");
  }
}
