import { demoSnapshot } from "./orchestration-demo.js";
import type {
  NodeState,
  UsageRow,
  WorkflowEvent,
  WorkflowNode,
  WorkflowSnapshot,
} from "./orchestration-types.js";

// The ORCHESTRATION view's state and controller, pure: a key, a click or a demo action in, a new state (and at most
// one effect for the console to run) out. The console keeps one state per session, shared by the module panel and
// the full-view overlay. Without a workflow and without demo there is no snapshot, and the view says so.

export const ORCHESTRATION_VIEWS = ["tree", "layers", "queue", "quota", "log"] as const;
export type OrchestrationView = (typeof ORCHESTRATION_VIEWS)[number];

export const VIEW_LABELS: Readonly<Record<OrchestrationView, string>> = {
  tree: "Tree",
  layers: "By layer",
  queue: "Queue",
  quota: "Quota",
  log: "Log",
};

export const LOG_FILTERS = ["all", "agent_run", "chat"] as const;
export type LogFilter = (typeof LOG_FILTERS)[number];

export interface OrchestrationState {
  readonly snapshot: WorkflowSnapshot | undefined;
  readonly demo: boolean;
  // "Now" for every relative time the view draws ("9 s ago", "in 12 min"): the moment the snapshot was taken.
  readonly clock: number;
  readonly view: OrchestrationView;
  readonly selectedNodeId: string | undefined;
  readonly quotaCursor: number;
  readonly logCursor: number;
  readonly logFilter: LogFilter;
  readonly detail: boolean;
  readonly screen: "workflow" | "live";
  // The outcome of the last action, drawn as a status line (and notified when it came from the panel).
  readonly status: string | undefined;
}

// What a hit-box under the pointer stands for. The same target means the same action as its key.
export type OrchestrationTarget =
  | { readonly kind: "view"; readonly view: OrchestrationView }
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "row"; readonly index: number }
  | { readonly kind: "filter"; readonly filter: LogFilter }
  | {
      readonly kind:
        | "open"
        | "stop"
        | "live"
        | "back"
        | "detail"
        | "demo"
        | "watchdog"
        | "reset"
        | "close";
    };

export type OrchestrationAction =
  | { readonly type: "next-view" }
  | { readonly type: "previous-view" }
  | { readonly type: "set-view"; readonly view: OrchestrationView }
  | { readonly type: "move"; readonly delta: number }
  | { readonly type: "select-node"; readonly id: string }
  | { readonly type: "select-row"; readonly index: number }
  | { readonly type: "toggle-detail" }
  | { readonly type: "toggle-live" }
  | { readonly type: "back" }
  | { readonly type: "cycle-filter" }
  | { readonly type: "set-filter"; readonly filter: LogFilter }
  | { readonly type: "toggle-demo"; readonly now: number }
  | { readonly type: "simulate-watchdog" }
  | { readonly type: "stop-all" }
  | { readonly type: "reset"; readonly now: number }
  | { readonly type: "close" };

// Effects only the console can carry out: closing the overlay, opening it, or the real emergency stop (■ STOP ALL,
// haril stop --now; it runs once the full-screen overlay is gone, so its report is seen).
export type OrchestrationEffect = "close" | "open-view" | "emergency-stop";

export interface OrchestrationTransition {
  readonly state: OrchestrationState;
  readonly effect?: OrchestrationEffect;
  // False for input the view does not own, so the overlay can ignore it.
  readonly handled: boolean;
}

const WATCHDOG_MS = 15 * 60_000;
const LIVE_STATES: readonly NodeState[] = ["running", "waiting", "queued", "awaiting_human"];
const DEMO_ONLY = "Demo actions (watchdog, reset) are only available in demo mode.";

// The notification after `/orchestration demo` or the Demo control.
export function demoNotice(on: boolean): string {
  return on
    ? "Orchestration demo on: sample data, not real · /orchestration view (or Alt+O) opens the full view"
    : "Orchestration demo off";
}

export function initialOrchestrationState(): OrchestrationState {
  return {
    snapshot: undefined,
    demo: false,
    clock: 0,
    view: "tree",
    selectedNodeId: undefined,
    quotaCursor: 0,
    logCursor: 0,
    logFilter: "all",
    detail: true,
    screen: "workflow",
    status: undefined,
  };
}

// The nodes depth first: each parent followed by its children, siblings in snapshot order. Orphans come last.
function treeOrder(nodes: readonly WorkflowNode[]): WorkflowNode[] {
  const out: WorkflowNode[] = [];
  const seen = new Set<string>();
  const visit = (node: WorkflowNode): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    out.push(node);
    for (const child of nodes) if (child.parentId === node.id) visit(child);
  };
  for (const node of nodes) if (node.parentId === null) visit(node);
  for (const node of nodes) visit(node);
  return out;
}

// The selectable nodes of a view, in the order the view draws them. Quota and Log list other rows.
export function nodesForView(
  snapshot: WorkflowSnapshot | undefined,
  view: OrchestrationView,
): WorkflowNode[] {
  if (snapshot === undefined) return [];
  const tree = treeOrder(snapshot.nodes);
  switch (view) {
    case "tree":
      return tree;
    case "layers":
      return [1, 2, 3].flatMap((layer) => tree.filter((node) => node.layer === layer));
    case "queue":
      return tree.filter((node) => node.state === "queued");
    case "quota":
    case "log":
      return [];
  }
}

// The usage log rows of a filter, newest first, as the Log view lists them.
export function filteredUsage(
  snapshot: WorkflowSnapshot | undefined,
  filter: LogFilter,
): UsageRow[] {
  const rows = (snapshot?.usage ?? []).slice().reverse();
  return filter === "all" ? rows : rows.filter((row) => row.kind === filter);
}

// The node the detail and the live view show: the selected one if the current view lists it, else the view's first;
// in Quota and Log (which list no nodes) the selected node stays the live view's target.
export function selectedNode(state: OrchestrationState): WorkflowNode | undefined {
  const pool = nodePool(state);
  return pool.find((node) => node.id === state.selectedNodeId) ?? pool[0];
}

// The nodes the selection moves through: the current view's list, or the whole tree for the views that list none.
function nodePool(state: OrchestrationState): WorkflowNode[] {
  const snapshot = state.snapshot;
  if (snapshot === undefined) return [];
  const listed = nodesForView(snapshot, state.view);
  return listed.length > 0 || state.view === "queue" ? listed : treeOrder(snapshot.nodes);
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function cycle<T>(items: readonly T[], current: T, step: number): T {
  const index = items.indexOf(current);
  return items[(index + step + items.length) % items.length] as T;
}

// Capacity and the queue count follow the nodes after a demo action changed them.
function recount(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const running = (role: WorkflowNode["role"]): number =>
    snapshot.nodes.filter((node) => node.role === role && node.state === "running").length;
  return {
    ...snapshot,
    totals: {
      ...snapshot.totals,
      queued: snapshot.nodes.filter((node) => node.state === "queued").length,
    },
    capacity: {
      executors: { ...snapshot.capacity.executors, live: running("executor") },
      auditors: { ...snapshot.capacity.auditors, live: running("auditor") },
      delegators: { ...snapshot.capacity.delegators, live: running("delegator") },
    },
  };
}

function loadDemo(
  state: OrchestrationState,
  now: number,
  status: string | undefined,
): OrchestrationState {
  const snapshot = demoSnapshot(now);
  return {
    ...state,
    snapshot,
    demo: true,
    clock: now,
    selectedNodeId: treeOrder(snapshot.nodes)[0]?.id,
    quotaCursor: 0,
    logCursor: 0,
    screen: "workflow",
    status,
  };
}

// The demo watchdog (spec 3.16): a running node without progress for 15 minutes is closed; every other running node
// is active and continues, with its next check 15 minutes later.
function simulateWatchdog(state: OrchestrationState): OrchestrationState {
  const snapshot = state.snapshot;
  if (!state.demo || snapshot === undefined) return { ...state, status: DEMO_ONLY };
  const now = state.clock;
  const events: WorkflowEvent[] = [];
  const closed: string[] = [];
  const active: string[] = [];
  const nodes = snapshot.nodes.map((node): WorkflowNode => {
    if (node.state !== "running") return node;
    const idle = node.lastProgress === null || now - node.lastProgress.at >= WATCHDOG_MS;
    if (idle) {
      closed.push(node.id);
      return { ...node, state: "closed", waitingReason: "no progress", nextCheckAt: null };
    }
    active.push(node.id);
    return { ...node, nextCheckAt: now + WATCHDOG_MS };
  });
  for (const id of active)
    events.push({ at: now, type: "watchdog.checked", text: `${id} active, continues` });
  for (const id of closed)
    events.push({ at: now, type: "watchdog.closed", text: `${id} closed: no progress` });
  const status =
    closed.length === 0
      ? `Demo watchdog: ${active.length} active nodes continue; nothing closed.`
      : `Demo watchdog: closed ${closed.join(", ")} (no progress); ${active.length} active nodes continue.`;
  return {
    ...state,
    snapshot: recount({ ...snapshot, nodes, events: [...snapshot.events, ...events] }),
    status,
  };
}

// The demo stop: every live node is cancelled and the workflow stops. Nothing real runs, so nothing real stops.
function simulateStop(state: OrchestrationState): OrchestrationState {
  const snapshot = state.snapshot;
  if (snapshot === undefined) return state;
  const live = snapshot.nodes.filter((node) => LIVE_STATES.includes(node.state));
  if (live.length === 0) return { ...state, status: "Demo: nothing is live to stop." };
  const nodes = snapshot.nodes.map(
    (node): WorkflowNode =>
      LIVE_STATES.includes(node.state)
        ? { ...node, state: "cancelled", waitingReason: "stopped by the user", nextCheckAt: null }
        : node,
  );
  const event = {
    at: state.clock,
    type: "workflow.stopped",
    text: `stop all: ${live.length} nodes cancelled`,
  };
  return {
    ...state,
    snapshot: recount({
      ...snapshot,
      workflow: { ...snapshot.workflow, state: "stopped" },
      nodes,
      events: [...snapshot.events, event],
    }),
    status: `Demo: stop all cancelled ${live.length} live nodes (simulated; nothing real was stopped).`,
  };
}

function move(state: OrchestrationState, delta: number): OrchestrationState {
  const live = state.screen === "live";
  if (!live && state.view === "quota") {
    const last = Math.max(0, (state.snapshot?.quota.length ?? 0) - 1);
    return { ...state, quotaCursor: clamp(state.quotaCursor + delta, 0, last) };
  }
  if (!live && state.view === "log") {
    const last = Math.max(0, filteredUsage(state.snapshot, state.logFilter).length - 1);
    return { ...state, logCursor: clamp(state.logCursor + delta, 0, last) };
  }
  // The live view moves through the same nodes it shows: the list of the view it was opened from (the whole tree
  // for Quota and Log, which list none). The lists follow their own view.
  const list = live ? nodePool(state) : nodesForView(state.snapshot, state.view);
  if (list.length === 0) return state;
  const current = list.findIndex((node) => node.id === selectedNode(state)?.id);
  const next = list[clamp((current < 0 ? 0 : current) + delta, 0, list.length - 1)];
  return { ...state, selectedNodeId: next?.id ?? state.selectedNodeId };
}

function done(state: OrchestrationState, effect?: OrchestrationEffect): OrchestrationTransition {
  return effect === undefined ? { state, handled: true } : { state, effect, handled: true };
}

export function reduceOrchestration(
  state: OrchestrationState,
  action: OrchestrationAction,
): OrchestrationTransition {
  switch (action.type) {
    case "next-view":
      return done({ ...state, view: cycle(ORCHESTRATION_VIEWS, state.view, 1) });
    case "previous-view":
      return done({ ...state, view: cycle(ORCHESTRATION_VIEWS, state.view, -1) });
    case "set-view":
      return done({ ...state, view: action.view, screen: "workflow" });
    case "move":
      return done(move(state, action.delta));
    case "select-node":
      return done({ ...state, selectedNodeId: action.id, detail: true });
    case "select-row":
      if (state.view === "quota") {
        const last = Math.max(0, (state.snapshot?.quota.length ?? 0) - 1);
        return done({ ...state, quotaCursor: clamp(action.index, 0, last) });
      }
      if (state.view === "log") {
        const last = Math.max(0, filteredUsage(state.snapshot, state.logFilter).length - 1);
        return done({ ...state, logCursor: clamp(action.index, 0, last) });
      }
      return done(state);
    case "toggle-detail":
      return done({ ...state, detail: !state.detail });
    case "toggle-live":
      return done({ ...state, screen: state.screen === "live" ? "workflow" : "live" });
    case "back":
      return done({ ...state, screen: "workflow" });
    case "cycle-filter":
      return done({
        ...state,
        view: "log",
        logFilter: cycle(LOG_FILTERS, state.logFilter, 1),
        logCursor: 0,
      });
    case "set-filter":
      return done({ ...state, view: "log", logFilter: action.filter, logCursor: 0 });
    case "toggle-demo":
      // The DEMO label (or the empty state) already says what changed: no status line.
      return done(
        state.demo
          ? { ...state, snapshot: undefined, demo: false, screen: "workflow", status: undefined }
          : loadDemo(state, action.now, undefined),
      );
    case "simulate-watchdog":
      return done(simulateWatchdog(state));
    case "stop-all":
      return state.demo ? done(simulateStop(state)) : done(state, "emergency-stop");
    case "reset":
      return done(
        state.demo
          ? loadDemo(state, action.now, "Demo data reset.")
          : { ...state, status: DEMO_ONLY },
      );
    case "close":
      return done(state, "close");
  }
}

// The key a raw terminal input stands for, as a name ("escape", "tab", "up", …) or a lower-case letter: legacy
// sequences and the Kitty keyboard protocol forms Pi enables (CSI-u for Escape, Tab and Enter, modifier-tagged
// arrows; release events never reach a component). Undefined for anything else. The /delegate card reads keys the same way.
const ESC = "\u001b";
const ARROWS: Readonly<Record<string, string>> = { A: "up", B: "down", C: "right", D: "left" };
// Kitty CSI-u modifier bits (the field minus one): Shift 1; Alt 2, Ctrl 4, Super 8, Hyper 16 and Meta 32 make a
// chord. Caps Lock (64) and Num Lock (128) are lock states, not chords.
const SHIFT = 1;
const CHORD_MODIFIERS = 2 | 4 | 8 | 16 | 32;

export function keyOf(data: string): string | undefined {
  if (data === ESC) return "escape";
  if (data === "\t") return "tab";
  if (data === "\r" || data === "\n") return "enter";
  if (!data.startsWith(ESC)) return data.length === 1 ? data.toLowerCase() : undefined;
  const body = data.slice(1);
  if (body === "[Z") return "shift-tab";
  const arrow = /^(?:\[|O|\[1;\d+(?::\d+)?)([ABCD])$/.exec(body);
  if (arrow !== null) return ARROWS[arrow[1] ?? ""];
  const csiU = /^\[(\d+)(?::\d*)*(?:;(\d+)(?::\d+)?)?u$/.exec(body);
  if (csiU === null) return undefined;
  const code = Number(csiU[1]);
  const modifiers = Number(csiU[2] ?? "1") - 1;
  const shift = (modifiers & SHIFT) !== 0;
  if (code === 27) return "escape";
  if (code === 9) return shift ? "shift-tab" : "tab";
  if (code === 13 || code === 57414) return "enter";
  // Ctrl+S, Alt+D and the like are other shortcuts, never the letter's action; Shift+S is still S.
  if ((modifiers & CHORD_MODIFIERS) !== 0) return undefined;
  return code >= 32 && code < 127 ? String.fromCharCode(code).toLowerCase() : undefined;
}

function actionForKey(
  state: OrchestrationState,
  key: string,
  now: number,
): OrchestrationAction | undefined {
  switch (key) {
    case "tab":
    case "right":
      return { type: "next-view" };
    case "shift-tab":
    case "left":
      return { type: "previous-view" };
    case "up":
    case "k":
      return { type: "move", delta: -1 };
    case "down":
    case "j":
      return { type: "move", delta: 1 };
    case "enter":
      return { type: "toggle-detail" };
    case "l":
      return { type: "toggle-live" };
    case "f":
      return { type: "cycle-filter" };
    case "d":
      return { type: "toggle-demo", now };
    case "w":
      return { type: "simulate-watchdog" };
    case "r":
      return { type: "reset", now };
    case "s":
      return { type: "stop-all" };
    case "escape":
    case "q":
      return state.screen === "live" ? { type: "back" } : { type: "close" };
    default:
      return undefined;
  }
}

export function orchestrationKey(
  state: OrchestrationState,
  data: string,
  now: number,
): OrchestrationTransition {
  const key = keyOf(data);
  const action = key === undefined ? undefined : actionForKey(state, key, now);
  return action === undefined ? { state, handled: false } : reduceOrchestration(state, action);
}

function actionForTarget(target: OrchestrationTarget, now: number): OrchestrationAction {
  switch (target.kind) {
    case "view":
      return { type: "set-view", view: target.view };
    case "node":
      return { type: "select-node", id: target.id };
    case "row":
      return { type: "select-row", index: target.index };
    case "filter":
      return { type: "set-filter", filter: target.filter };
    case "live":
      return { type: "toggle-live" };
    case "back":
      return { type: "back" };
    case "detail":
      return { type: "toggle-detail" };
    case "demo":
      return { type: "toggle-demo", now };
    case "watchdog":
      return { type: "simulate-watchdog" };
    case "reset":
      return { type: "reset", now };
    case "stop":
      return { type: "stop-all" };
    case "open":
    case "close":
      return { type: "close" };
  }
}

// A click on a hit-box. In the module panel a view, a row or "Open full view" opens the overlay there; the stop
// button acts in place. Inside the overlay every target is the same action as its key.
export function orchestrationClick(
  state: OrchestrationState,
  target: OrchestrationTarget,
  now: number,
  surface: "panel" | "view",
): OrchestrationTransition {
  if (surface === "panel") {
    if (target.kind === "open") return done({ ...state, screen: "workflow" }, "open-view");
    if (target.kind === "view" || target.kind === "node") {
      const next = reduceOrchestration(state, actionForTarget(target, now)).state;
      return done({ ...next, screen: "workflow" }, "open-view");
    }
  }
  if (surface === "view" && target.kind === "open") return done(state);
  return reduceOrchestration(state, actionForTarget(target, now));
}
