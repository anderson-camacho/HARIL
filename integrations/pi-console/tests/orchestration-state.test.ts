import { describe, expect, it } from "vitest";
import {
  initialOrchestrationState,
  nodesForView,
  ORCHESTRATION_VIEWS,
  type OrchestrationState,
  orchestrationClick,
  orchestrationKey,
  reduceOrchestration,
  selectedNode,
} from "../src/orchestration-state.js";

// The ORCHESTRATION controller is pure: every key, click and demo action returns a new state (and at most one effect
// for the console to run). These tests drive it with raw terminal input, as Pi delivers it to a focused overlay.

const NOW = 1_800_000_000_000;
const KEY = {
  tab: "\t",
  shiftTab: "\u001b[Z",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  enter: "\r",
  escape: "\u001b",
  kittyEscape: "\u001b[27u",
  kittyTab: "\u001b[9u",
  kittyEnter: "\u001b[13u",
} as const;

function demoState(): OrchestrationState {
  return reduceOrchestration(initialOrchestrationState(), { type: "toggle-demo", now: NOW }).state;
}

function press(state: OrchestrationState, ...keys: string[]): OrchestrationState {
  let current = state;
  for (const key of keys) current = orchestrationKey(current, key, NOW).state;
  return current;
}

function nodeState(state: OrchestrationState, id: string): string | undefined {
  return state.snapshot?.nodes.find((node) => node.id === id)?.state;
}

describe("orchestration state: demo mode", () => {
  it("starts without a workflow and without demo data", () => {
    const state = initialOrchestrationState();
    expect(state.demo).toBe(false);
    expect(state.snapshot).toBeUndefined();
    expect(state.view).toBe("tree");
  });

  it("D loads the demo snapshot and D again unloads it", () => {
    const on = press(initialOrchestrationState(), "d");
    expect(on.demo).toBe(true);
    expect(on.snapshot?.demo).toBe(true);
    expect(on.snapshot?.nodes).toHaveLength(11);
    expect(on.selectedNodeId).toBe("o1");
    const off = press(on, "D");
    expect(off.demo).toBe(false);
    expect(off.snapshot).toBeUndefined();
  });
});

describe("orchestration state: keyboard", () => {
  it("Tab and Right cycle the five views and come back to the first", () => {
    const seen: string[] = [];
    let state = demoState();
    for (let index = 0; index < ORCHESTRATION_VIEWS.length; index++) {
      seen.push(state.view);
      state = press(state, index % 2 === 0 ? KEY.tab : KEY.right);
    }
    expect(seen).toEqual(["tree", "layers", "queue", "quota", "log"]);
    expect(state.view).toBe("tree");
  });

  it("Left and Shift+Tab go back, wrapping to the last view", () => {
    expect(press(demoState(), KEY.left).view).toBe("log");
    expect(press(demoState(), KEY.shiftTab).view).toBe("log");
    expect(press(demoState(), KEY.tab, KEY.tab, KEY.left).view).toBe("layers");
  });

  it("understands the Kitty keyboard protocol forms Pi may deliver", () => {
    expect(press(demoState(), KEY.kittyTab).view).toBe("layers");
    expect(press(demoState(), KEY.kittyEnter).detail).toBe(false);
    expect(orchestrationKey(demoState(), KEY.kittyEscape, NOW).effect).toBe("close");
  });

  it("Up and Down move the selection and stop at both ends", () => {
    const state = demoState();
    const order = nodesForView(state.snapshot, "tree").map((node) => node.id);
    expect(order).toEqual(["o1", "d1", "e1", "a1", "e2", "e3", "a3", "d2", "e4", "a4", "e5"]);
    expect(press(state, KEY.up).selectedNodeId).toBe("o1");
    expect(press(state, KEY.down).selectedNodeId).toBe("d1");
    const bottom = press(state, ...Array.from({ length: 30 }, () => KEY.down));
    expect(bottom.selectedNodeId).toBe("e5");
    expect(press(bottom, KEY.down).selectedNodeId).toBe("e5");
  });

  it("moves within the list of the current view", () => {
    const queue = press(demoState(), KEY.tab, KEY.tab);
    expect(queue.view).toBe("queue");
    expect(selectedNode(queue)?.id).toBe("a1");
    expect(press(queue, KEY.down).selectedNodeId).toBe("e2");
    expect(press(queue, KEY.down, KEY.down, KEY.down, KEY.down).selectedNodeId).toBe("a4");

    const quota = press(demoState(), KEY.tab, KEY.tab, KEY.tab);
    expect(press(quota, ...Array.from({ length: 10 }, () => KEY.down)).quotaCursor).toBe(3);
    expect(press(quota, KEY.up).quotaCursor).toBe(0);
  });

  it("Enter toggles the detail", () => {
    const state = demoState();
    expect(state.detail).toBe(true);
    expect(press(state, KEY.enter).detail).toBe(false);
    expect(press(state, KEY.enter, KEY.enter).detail).toBe(true);
  });

  it("Esc closes the view; inside the live view it goes back first", () => {
    expect(orchestrationKey(demoState(), KEY.escape, NOW).effect).toBe("close");
    const live = press(demoState(), "l");
    expect(live.screen).toBe("live");
    const back = orchestrationKey(live, KEY.escape, NOW);
    expect(back.effect).toBeUndefined();
    expect(back.state.screen).toBe("workflow");
  });

  it("L opens and closes the live view of the selected node", () => {
    const live = press(demoState(), KEY.down, "L");
    expect(live.screen).toBe("live");
    expect(live.selectedNodeId).toBe("d1");
    expect(press(live, "l").screen).toBe("workflow");
  });

  it("F cycles the log filter and shows the log", () => {
    const first = press(demoState(), "f");
    expect(first.view).toBe("log");
    expect(first.logFilter).toBe("agent_run");
    expect(press(first, "F").logFilter).toBe("chat");
    expect(press(first, "f", "f").logFilter).toBe("all");
  });

  it("clamps the log cursor to the filtered rows", () => {
    const chat = press(demoState(), "f", "f");
    expect(chat.logFilter).toBe("chat");
    expect(press(chat, KEY.down, KEY.down, KEY.down).logCursor).toBe(1);
  });

  it("ignores keys it does not own", () => {
    const transition = orchestrationKey(demoState(), "z", NOW);
    expect(transition.handled).toBe(false);
    expect(transition.effect).toBeUndefined();
  });
});

describe("orchestration state: demo actions", () => {
  it("the simulated watchdog closes only e5 and lets the active nodes continue", () => {
    const before = demoState();
    const after = press(before, "w");
    expect(nodeState(after, "e5")).toBe("closed");
    expect(after.snapshot?.nodes.find((node) => node.id === "e5")?.waitingReason).toBe(
      "no progress",
    );
    for (const id of ["d1", "e1", "d2", "e4"]) expect(nodeState(after, id)).toBe("running");
    const changed = after.snapshot?.nodes.filter(
      (node, index) => node.state !== before.snapshot?.nodes[index]?.state,
    );
    expect(changed?.map((node) => node.id)).toEqual(["e5"]);
    const newEvents = after.snapshot?.events.slice(before.snapshot?.events.length ?? 0) ?? [];
    expect(newEvents.map((event) => event.text)).toEqual([
      "d1 active, continues",
      "e1 active, continues",
      "d2 active, continues",
      "e4 active, continues",
      "e5 closed: no progress",
    ]);
    expect(after.snapshot?.capacity.executors.live).toBe(2);
    expect(after.status).toMatch(/closed e5/);
  });

  it("stop all in demo cancels every live node and nothing else", () => {
    const after = press(demoState(), "s");
    const states = Object.fromEntries(after.snapshot?.nodes.map((n) => [n.id, n.state]) ?? []);
    expect(states).toEqual({
      o1: "cancelled",
      d1: "cancelled",
      e1: "cancelled",
      a1: "cancelled",
      e2: "cancelled",
      e3: "done",
      a3: "done",
      d2: "cancelled",
      e4: "cancelled",
      a4: "cancelled",
      e5: "cancelled",
    });
    expect(after.snapshot?.workflow.state).toBe("stopped");
    expect(after.snapshot?.capacity.executors.live).toBe(0);
    expect(after.snapshot?.totals.queued).toBe(0);
    expect(after.status).toMatch(/9 live nodes/);
    expect(after.status).toMatch(/simulated/i);
  });

  it("outside demo, stop all asks the console to run the real stop", () => {
    const transition = orchestrationKey(initialOrchestrationState(), "s", NOW);
    expect(transition.effect).toBe("stop-runtime");
  });

  it("outside demo, the watchdog simulation and reset change nothing", () => {
    const state = initialOrchestrationState();
    const watchdog = orchestrationKey(state, "w", NOW).state;
    expect(watchdog.snapshot).toBeUndefined();
    expect(watchdog.status).toMatch(/demo/i);
    expect(orchestrationKey(state, "r", NOW).state.snapshot).toBeUndefined();
  });

  it("reset brings the demo back to its first state", () => {
    const changed = press(demoState(), "w", "s");
    const reset = press(changed, "r");
    expect(nodeState(reset, "e5")).toBe("running");
    expect(nodeState(reset, "o1")).toBe("waiting");
    expect(reset.snapshot?.workflow.state).toBe("running");
    expect(reset.selectedNodeId).toBe("o1");
  });
});

describe("orchestration state: clicks", () => {
  it("a click on a view, a row, a filter or a button maps to the same action as its key", () => {
    const state = demoState();
    expect(orchestrationClick(state, { kind: "view", view: "quota" }, NOW, "view").state.view).toBe(
      "quota",
    );
    const row = orchestrationClick(
      press(state, KEY.enter),
      { kind: "node", id: "e3" },
      NOW,
      "view",
    );
    expect(row.state.selectedNodeId).toBe("e3");
    expect(row.state.detail).toBe(true);
    const filter = orchestrationClick(state, { kind: "filter", filter: "chat" }, NOW, "view");
    expect(filter.state.logFilter).toBe("chat");
    expect(filter.state.view).toBe("log");
    expect(
      orchestrationClick(state, { kind: "row", index: 2 }, NOW, "view").state.quotaCursor,
    ).toBe(0);
    const quota = press(state, KEY.tab, KEY.tab, KEY.tab);
    expect(
      orchestrationClick(quota, { kind: "row", index: 2 }, NOW, "view").state.quotaCursor,
    ).toBe(2);
    expect(orchestrationClick(state, { kind: "live" }, NOW, "view").state.screen).toBe("live");
    expect(orchestrationClick(state, { kind: "detail" }, NOW, "view").state.detail).toBe(false);
    expect(orchestrationClick(state, { kind: "demo" }, NOW, "view").state.demo).toBe(false);
    expect(
      nodeState(orchestrationClick(state, { kind: "watchdog" }, NOW, "view").state, "e5"),
    ).toBe("closed");
    expect(orchestrationClick(state, { kind: "close" }, NOW, "view").effect).toBe("close");
    expect(orchestrationClick(state, { kind: "back" }, NOW, "view").state.screen).toBe("workflow");
  });

  it("panel clicks open the full view at the clicked view or node", () => {
    const state = demoState();
    const node = orchestrationClick(state, { kind: "node", id: "d2" }, NOW, "panel");
    expect(node.effect).toBe("open-view");
    expect(node.state.selectedNodeId).toBe("d2");
    const view = orchestrationClick(state, { kind: "view", view: "queue" }, NOW, "panel");
    expect(view.effect).toBe("open-view");
    expect(view.state.view).toBe("queue");
    expect(orchestrationClick(state, { kind: "open" }, NOW, "panel").effect).toBe("open-view");
  });

  it("the stop button simulates in demo and runs the real stop outside it", () => {
    const demo = orchestrationClick(demoState(), { kind: "stop" }, NOW, "panel");
    expect(demo.effect).toBeUndefined();
    expect(nodeState(demo.state, "d1")).toBe("cancelled");
    const real = orchestrationClick(initialOrchestrationState(), { kind: "stop" }, NOW, "panel");
    expect(real.effect).toBe("stop-runtime");
  });
});
