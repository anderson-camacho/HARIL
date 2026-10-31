import { describe, expect, it } from "vitest";
import harilConsole from "../src/console.js";
import { UNICODE_FACTORY_GLYPHS } from "../src/factory-kit.js";
import { openFactoryOverlay } from "../src/factory-overlay.js";
import { type FactoryState, initialFactoryState } from "../src/factory-state.js";
import { CONSOLE_MODES } from "../src/modes.js";
import type { ConsoleContext, ConsoleMouseEvent } from "../src/pi-types.js";
import { stripAnsi, textWidth } from "../src/text.js";
import { fakeContext, fakePi } from "./fake-pi.js";

// The overlay as Pi drives it: a fake ctx.ui.custom calls the factory, then the test sends raw keys and mouse events to
// the component exactly as a focused overlay receives them. No Pi process runs.

interface FakeComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: ConsoleMouseEvent): { handled?: boolean } | undefined;
}

function customInto(capture: {
  component?: FakeComponent;
  options?: unknown;
  renders: number;
  resolve?: (value: unknown) => void;
}) {
  return (
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: unknown) => void,
    ) => FakeComponent,
    options: unknown,
  ) => {
    capture.options = options;
    return new Promise((resolve) => {
      capture.resolve = resolve;
      const tui = {
        terminal: { columns: 80, rows: 24 },
        requestRender: () => {
          capture.renders++;
        },
      };
      capture.component = factory(tui, {}, undefined, resolve);
    });
  };
}

function open(initial: FactoryState = initialFactoryState()) {
  let state = initial;
  const capture: Parameters<typeof customInto>[0] = { renders: 0 };
  const ctx = { ui: { custom: customInto(capture) } } as unknown as ConsoleContext;
  const result = openFactoryOverlay(ctx, {
    get: () => state,
    set: (next) => {
      state = next;
    },
    glyphs: UNICODE_FACTORY_GLYPHS,
  });
  const view = (): FakeComponent => {
    if (capture.component === undefined) throw new Error("overlay not created");
    return capture.component;
  };
  const mouse = (event: Partial<ConsoleMouseEvent>) =>
    view().handleMouse?.({
      type: "click",
      button: "left",
      x: 0,
      y: 0,
      width: 80,
      height: 24,
      shift: false,
      alt: false,
      ctrl: false,
      ...event,
    });
  return { result, view, mouse, state: () => state, capture };
}

describe("factory overlay", () => {
  it("opens as a full-size overlay and renders the terminal's height", () => {
    const overlay = open();
    expect(overlay.capture.options).toEqual({
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%" },
    });
    const lines = overlay.view().render(80);
    expect(lines).toHaveLength(24);
    for (const line of lines) expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(80);
  });

  it("plain keys change the tab and request a render", () => {
    const overlay = open();
    overlay.view().handleInput?.("\t");
    expect(overlay.state().tab).toBe("actividades");
    overlay.view().handleInput?.("7");
    expect(overlay.state().tab).toBe("sistema");
    expect(overlay.capture.renders).toBe(2);
  });

  it("a key it does not own changes nothing and draws nothing", () => {
    const overlay = open();
    overlay.view().handleInput?.("x");
    expect(overlay.state().tab).toBe("avance");
    expect(overlay.capture.renders).toBe(0);
  });

  it("a click on a tab selects it", () => {
    const overlay = open();
    const line = stripAnsi(overlay.view().render(80)[0] ?? "");
    const handled = overlay.mouse({ x: line.indexOf("Modelos"), y: 0 });
    expect(handled).toEqual({ handled: true, render: true });
    expect(overlay.state().tab).toBe("modelos");
  });

  it("a click outside a hit-box and a button other than the left are not its own", () => {
    const overlay = open();
    overlay.view().render(80);
    expect(overlay.mouse({ x: 40, y: 10 })).toBeUndefined();
    expect(overlay.mouse({ x: 2, y: 0, button: "right" })).toBeUndefined();
    expect(overlay.state().tab).toBe("avance");
  });

  it("the wheel moves the selection", () => {
    const base = initialFactoryState();
    const overlay = open({ ...base, rowCounts: { ...base.rowCounts, avance: 3 } });
    expect(overlay.mouse({ type: "wheel", button: "none", wheelDelta: 1 })).toEqual({
      handled: true,
      render: true,
    });
    expect(overlay.state().selection.avance).toBe(1);
  });

  it("Esc closes it", async () => {
    const overlay = open();
    overlay.view().handleInput?.("\u001b");
    await expect(overlay.result).resolves.toBeUndefined();
  });

  it("a click on Esc in the footer closes it", async () => {
    const overlay = open();
    const lines = overlay.view().render(80).map(stripAnsi);
    overlay.mouse({ x: lines[23]?.indexOf("Esc cerrar") ?? -1, y: 23 });
    await expect(overlay.result).resolves.toBeUndefined();
  });
});

describe("/haril-factory", () => {
  async function started() {
    const fake = fakePi();
    const ctx = fakeContext();
    const capture: Parameters<typeof customInto>[0] = { renders: 0 };
    let opened = 0;
    const custom = customInto(capture);
    Object.assign(ctx.ui, {
      custom: (...args: Parameters<typeof custom>) => {
        opened++;
        return custom(...args);
      },
    });
    harilConsole(fake.pi);
    await fake.fire("session_start", { reason: "startup" }, ctx);
    return { fake, ctx, capture, opened: () => opened };
  }

  it("opens the overlay", async () => {
    const { fake, ctx, capture, opened } = await started();
    void fake.commands.get("haril-factory")?.handler("", ctx);
    await Promise.resolve();
    expect(opened()).toBe(1);
    expect(stripAnsi(capture.component?.render(80)[1] ?? "")).toContain("Avance");
    capture.resolve?.(undefined);
  });

  it("does not open twice at once, and opens again once closed, on the tab it left", async () => {
    const { fake, ctx, capture, opened } = await started();
    const first = fake.commands.get("haril-factory")?.handler("", ctx);
    void fake.commands.get("haril-factory")?.handler("", ctx);
    expect(opened()).toBe(1);
    capture.component?.handleInput?.("3");
    capture.component?.handleInput?.("\u001b");
    await first;
    void fake.commands.get("haril-factory")?.handler("", ctx);
    expect(opened()).toBe(2);
    expect(stripAnsi(capture.component?.render(80)[1] ?? "")).toContain("Tablero");
    capture.resolve?.(undefined);
  });

  it("outside the interactive console it says so and opens nothing", async () => {
    const { fake, ctx, opened } = await started();
    const before = ctx.notes.length;
    await fake.commands.get("haril-factory")?.handler("", { ...ctx, hasUI: false });
    expect(ctx.notes).toHaveLength(before);
    await fake.commands
      .get("haril-factory")
      ?.handler("", { ...ctx, mode: "rpc" } as ConsoleContext);
    expect(opened()).toBe(0);
    expect(ctx.notes.at(-1)).toEqual(["La fábrica necesita la consola interactiva.", "warning"]);
  });

  it("opens in each of the four modes, since it only views", async () => {
    for (const mode of CONSOLE_MODES) {
      const { fake, ctx, capture, opened } = await started();
      expect(fake.commands.has("mode")).toBe(true);
      await fake.commands.get("mode")?.handler(mode, ctx);
      void fake.commands.get("haril-factory")?.handler("", ctx);
      await Promise.resolve();
      expect(opened(), mode).toBeGreaterThanOrEqual(1);
      expect(stripAnsi(capture.component?.render(80)[1] ?? ""), mode).toContain("Avance");
      capture.resolve?.(undefined);
    }
  });

  it("describes itself in Spanish, and takes no key Pi already owns", async () => {
    const { fake } = await started();
    // Pi 1.2.0 binds Alt+F to tui.editor.cursorWordRight, and the console never overrides a built-in shortcut.
    expect(fake.shortcuts.has("alt+f")).toBe(false);
    expect(fake.commands.get("haril-factory")?.description).toMatch(/fábrica/i);
  });
});
