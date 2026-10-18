import { describe, expect, it } from "vitest";
import { UNICODE_GLYPHS } from "../src/orchestration-draw.js";
import { openOrchestrationOverlay } from "../src/orchestration-overlay.js";
import {
  initialOrchestrationState,
  type OrchestrationState,
  reduceOrchestration,
} from "../src/orchestration-state.js";
import type { ConsoleContext, ConsoleMouseEvent } from "../src/pi-types.js";
import { stripAnsi, textWidth } from "../src/text.js";

// The overlay as Pi drives it: a fake ctx.ui.custom calls the factory, then the test sends raw keys and mouse events
// to the component exactly as a focused overlay receives them. No Pi process runs.

interface FakeComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: ConsoleMouseEvent): { handled?: boolean } | undefined;
}

const NOW = 1_800_000_000_000;

function open(initial: OrchestrationState, rows = 24) {
  let state = initial;
  let component: FakeComponent | undefined;
  let options: unknown;
  let renders = 0;
  const ctx = {
    ui: {
      custom(
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: unknown) => void,
        ) => FakeComponent,
        customOptions: unknown,
      ) {
        options = customOptions;
        return new Promise((resolve) => {
          const tui = {
            terminal: { columns: 80, rows },
            requestRender: () => {
              renders++;
            },
          };
          component = factory(tui, {}, undefined, resolve);
        });
      },
    },
  } as unknown as ConsoleContext;
  const result = openOrchestrationOverlay(ctx, {
    get: () => state,
    set: (next) => {
      state = next;
    },
    glyphs: UNICODE_GLYPHS,
  });
  const view = (): FakeComponent => {
    if (component === undefined) throw new Error("overlay not created");
    return component;
  };
  return {
    result,
    view,
    state: () => state,
    options: () => options,
    renders: () => renders,
    click(match: (line: string) => number, width = 80): void {
      const lines = view().render(width).map(stripAnsi);
      const row = lines.findIndex((line) => match(line) >= 0);
      const x = match(lines[row] ?? "");
      view().handleMouse?.({
        type: "click",
        button: "left",
        x,
        y: row,
        width,
        height: rows,
        shift: false,
        alt: false,
        ctrl: false,
      });
    },
  };
}

function demo(): OrchestrationState {
  return reduceOrchestration(initialOrchestrationState(), { type: "toggle-demo", now: NOW }).state;
}

describe("orchestration overlay", () => {
  it("opens as a full-size overlay and renders the terminal's height", () => {
    const overlay = open(demo());
    expect(overlay.options()).toEqual({
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%" },
    });
    const lines = overlay.view().render(80);
    expect(lines).toHaveLength(24);
    for (const line of lines) expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(80);
  });

  it("plain keys drive the view and request a render", () => {
    const overlay = open(demo());
    overlay.view().handleInput?.("\t");
    expect(overlay.state().view).toBe("layers");
    overlay.view().handleInput?.("\u001b[B");
    expect(overlay.state().selectedNodeId).toBe("d1");
    expect(overlay.renders()).toBeGreaterThan(0);
  });

  it("a click on a tab or a row acts like its key", () => {
    const overlay = open(demo());
    overlay.click((line) => line.indexOf("Quota"));
    expect(overlay.state().view).toBe("quota");
    overlay.click((line) => (line.indexOf("[Tree]") >= 0 ? -1 : line.indexOf("Tree")));
    expect(overlay.state().view).toBe("tree");
    overlay.click((line) => line.indexOf("e1 Executor"));
    expect(overlay.state().selectedNodeId).toBe("e1");
  });

  it("the wheel moves the selection", () => {
    const overlay = open(demo());
    overlay.view().handleMouse?.({
      type: "wheel",
      button: "none",
      x: 0,
      y: 0,
      width: 80,
      height: 24,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: 1,
    });
    expect(overlay.state().selectedNodeId).toBe("d1");
  });

  it("Esc closes it and resolves without an effect", async () => {
    const overlay = open(demo());
    overlay.view().handleInput?.("\u001b");
    await expect(overlay.result).resolves.toBeUndefined();
  });

  it("the Close button closes it too", async () => {
    const overlay = open(demo());
    overlay.click((line) => line.indexOf("[Esc Close]"));
    await expect(overlay.result).resolves.toBeUndefined();
  });

  it("outside demo, stop all closes it and hands the real stop to the console", async () => {
    const overlay = open(initialOrchestrationState());
    overlay.click((line) => line.indexOf("Stop all"));
    await expect(overlay.result).resolves.toBe("emergency-stop");
  });

  it("in demo, stop all simulates inside the overlay and keeps it open", () => {
    const overlay = open(demo());
    overlay.view().handleInput?.("s");
    expect(overlay.state().snapshot?.workflow.state).toBe("stopped");
    expect(overlay.view().render(80).map(stripAnsi).join("\n")).toContain("simulated");
  });
});
