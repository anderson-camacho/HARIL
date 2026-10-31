import { describe, expect, it } from "vitest";
import {
  FACTORY_TABS,
  type FactoryState,
  factoryClick,
  factoryKey,
  factoryMove,
  initialFactoryState,
} from "../src/factory-state.js";

const ESC = "\u001b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;
const SHIFT_TAB = `${ESC}[Z`;

function withRows(rows: number, state = initialFactoryState()): FactoryState {
  return { ...state, rowCounts: { ...state.rowCounts, [state.tab]: rows } };
}

function press(state: FactoryState, ...keys: string[]): FactoryState {
  return keys.reduce((current, key) => factoryKey(current, key).state, state);
}

describe("the factory's tabs", () => {
  it("lists the seven tabs in order and starts on the first", () => {
    expect(FACTORY_TABS).toEqual([
      "avance",
      "actividades",
      "tablero",
      "agentes",
      "conexiones",
      "modelos",
      "sistema",
    ]);
    expect(initialFactoryState()).toMatchObject({ tab: "avance", detail: false });
  });

  it("right and tab go forward, left and shift+tab back, and both wrap", () => {
    const start = initialFactoryState();
    expect(press(start, RIGHT).tab).toBe("actividades");
    expect(press(start, "\t").tab).toBe("actividades");
    expect(press(start, LEFT).tab).toBe("sistema");
    expect(press(start, SHIFT_TAB).tab).toBe("sistema");
    expect(press(start, ...FACTORY_TABS.map(() => RIGHT)).tab).toBe("avance");
  });

  it("the digits 1 to 7 jump to their tab; other digits are not the view's", () => {
    FACTORY_TABS.forEach((tab, index) => {
      expect(press(initialFactoryState(), String(index + 1)).tab).toBe(tab);
    });
    for (const key of ["0", "8", "9"])
      expect(factoryKey(initialFactoryState(), key).handled).toBe(false);
  });

  it("ignores what it does not own, and leaves the state alone", () => {
    const start = initialFactoryState();
    for (const key of ["x", `${ESC}f`, `${ESC}[15~`]) {
      const transition = factoryKey(start, key);
      expect(transition).toEqual({ state: start, handled: false });
    }
  });
});

describe("the factory's selection", () => {
  it("up and down, or k and j, move within the tab's rows and stop at the ends", () => {
    const start = withRows(3);
    expect(press(start, DOWN).selection.avance).toBe(1);
    expect(press(start, "j", "j", "j", "j").selection.avance).toBe(2);
    expect(press(start, "j", "k").selection.avance).toBe(0);
    expect(press(start, UP).selection.avance).toBe(0);
  });

  it("does not move without rows", () => {
    expect(press(initialFactoryState(), DOWN, "j").selection.avance).toBe(0);
    expect(factoryKey(initialFactoryState(), DOWN).handled).toBe(true);
  });

  it("each tab keeps its own selection", () => {
    const moved = press(withRows(3), DOWN, DOWN);
    const other = press(moved, RIGHT);
    expect(other.selection.actividades).toBe(0);
    expect(press(other, LEFT).selection.avance).toBe(2);
  });

  it("the wheel moves like the keys", () => {
    expect(factoryMove(withRows(3), 1).state.selection.avance).toBe(1);
    expect(factoryMove(withRows(3), -1).state.selection.avance).toBe(0);
  });
});

describe("the factory's detail", () => {
  it("enter opens the selected row's detail", () => {
    expect(press(withRows(2), "\r").detail).toBe(true);
    expect(press(withRows(2), "\n").detail).toBe(true);
  });

  it("enter opens nothing without rows", () => {
    const transition = factoryKey(initialFactoryState(), "\r");
    expect(transition.handled).toBe(true);
    expect(transition.state.detail).toBe(false);
  });

  it("esc backs out of the detail first, and then closes", () => {
    const inside = press(withRows(2), "\r");
    const back = factoryKey(inside, ESC);
    expect(back.state.detail).toBe(false);
    expect(back.effect).toBeUndefined();
    const closed = factoryKey(back.state, ESC);
    expect(closed).toMatchObject({ handled: true, effect: "close" });
  });

  it("the selection does not move under an open detail", () => {
    const inside = press(withRows(3), "\r");
    expect(press(inside, DOWN).selection.avance).toBe(0);
  });

  it("changing tab leaves the detail", () => {
    const inside = press(withRows(2), "\r");
    expect(press(inside, RIGHT)).toMatchObject({ tab: "actividades", detail: false });
    expect(press(inside, "3")).toMatchObject({ tab: "tablero", detail: false });
  });

  it("reads Enter, Esc and Tab in the Kitty keyboard protocol too", () => {
    const inside = press(withRows(2), `${ESC}[13u`);
    expect(inside.detail).toBe(true);
    expect(press(inside, `${ESC}[27u`).detail).toBe(false);
    expect(press(initialFactoryState(), `${ESC}[9u`).tab).toBe("actividades");
    expect(press(initialFactoryState(), `${ESC}[9;2u`).tab).toBe("sistema");
  });
});

describe("a click on the factory", () => {
  it("means the same as its key", () => {
    const inside = press(withRows(2), "\r");
    expect(factoryClick(inside, { kind: "tab", tab: "modelos" }).state).toMatchObject({
      tab: "modelos",
      detail: false,
    });
    expect(factoryClick(inside, { kind: "back" }).state.detail).toBe(false);
    expect(factoryClick(inside, { kind: "close" }).effect).toBe("close");
  });
});
