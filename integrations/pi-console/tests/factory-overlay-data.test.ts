import { describe, expect, it } from "vitest";
import type { FactoryFeed } from "../src/factory-feed.js";
import { UNICODE_FACTORY_GLYPHS } from "../src/factory-kit.js";
import { type FactoryOverlayHost, openFactoryOverlay } from "../src/factory-overlay.js";
import {
  type FactoryAction,
  type FactoryState,
  initialFactoryState,
} from "../src/factory-state.js";
import type { FactoryModel } from "../src/factory-types.js";
import type { ConsoleContext } from "../src/pi-types.js";
import { stripAnsi } from "../src/text.js";
import { model } from "./factory-fixture.js";

// The overlay with its data: a fake ctx.ui.custom, a fake feed and a fake action runner. No process runs.

interface FakeComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
}

function open(overrides: Partial<FactoryOverlayHost> = {}) {
  let state: FactoryState = { ...initialFactoryState(), tab: "tablero" };
  let component: FakeComponent | undefined;
  let renders = 0;
  let listener: Parameters<NonNullable<FactoryOverlayHost["startFeed"]>>[0] | undefined;
  let feedStarts = 0;
  let feedCloses = 0;
  let resolveCustom: ((value: unknown) => void) | undefined;
  const actions: FactoryAction[] = [];
  const custom = (factory: (...args: unknown[]) => FakeComponent) =>
    new Promise((resolve) => {
      resolveCustom = resolve;
      const tui = {
        terminal: { columns: 120, rows: 40 },
        requestRender: () => {
          renders += 1;
        },
      };
      component = factory(tui, {}, undefined, resolve);
    });
  const ctx = { ui: { custom } } as unknown as ConsoleContext;
  const result = openFactoryOverlay(ctx, {
    get: () => state,
    set: (next) => {
      state = next;
    },
    glyphs: UNICODE_FACTORY_GLYPHS,
    startFeed: (next): FactoryFeed => {
      feedStarts += 1;
      listener = next;
      return {
        close() {
          feedCloses += 1;
        },
      };
    },
    act: async (action) => {
      actions.push(action);
      return "El flujo wf-stop continúa.";
    },
    ...overrides,
  });
  return {
    result,
    key: (data: string) => component?.handleInput?.(data),
    screen: () => (component?.render(120) ?? []).map(stripAnsi).join("\n"),
    state: () => state,
    renders: () => renders,
    feedStarts: () => feedStarts,
    feedCloses: () => feedCloses,
    send: (row: FactoryModel = model()) => listener?.onModel(row),
    endFeed: () => listener?.onEnded(),
    actions,
    dismiss: () => resolveCustom?.(undefined),
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the factory overlay's data", () => {
  it("starts the feed once it opens, and draws each line it hears", () => {
    const overlay = open();
    expect(overlay.feedStarts()).toBe(1);
    expect(overlay.screen()).toContain("Sin datos conectados todavía");
    overlay.send();
    expect(overlay.renders()).toBe(1);
    expect(overlay.screen()).toContain("Por hacer 1");
    expect(overlay.state().rowCounts.tablero).toBe(5);
  });

  it("says so when the feed ends", () => {
    const overlay = open();
    overlay.endFeed();
    expect(overlay.screen()).toContain("haril factory watch");
  });

  it("stops the child when it closes, and hears nothing after that", async () => {
    const overlay = open();
    overlay.send();
    overlay.key("\u001b");
    await overlay.result;
    expect(overlay.feedCloses()).toBeGreaterThanOrEqual(1);
    const renders = overlay.renders();
    overlay.send();
    overlay.endFeed();
    expect(overlay.renders()).toBe(renders);
  });

  it("stops the child however the view goes away", async () => {
    const overlay = open();
    overlay.dismiss();
    await overlay.result;
    expect(overlay.feedCloses()).toBe(1);
  });

  it("runs a confirmed action and shows its answer", async () => {
    const overlay = open();
    overlay.send();
    overlay.key("c");
    expect(overlay.actions).toEqual([]);
    expect(overlay.screen()).toContain("s/n");
    overlay.key("s");
    expect(overlay.actions).toHaveLength(1);
    expect(overlay.actions[0]).toMatchObject({ kind: "continue", workflowId: "wf-stop" });
    await flush();
    expect(overlay.screen()).toContain("El flujo wf-stop continúa.");
  });

  it("shows why an action failed", async () => {
    const overlay = open({
      act: () => Promise.reject(new Error("no se pudo")),
    });
    overlay.send();
    overlay.key("c");
    overlay.key("s");
    await flush();
    expect(overlay.screen()).toContain("no se pudo");
  });

  it("closes with the request for a new task", async () => {
    const overlay = open();
    overlay.send();
    overlay.key("n");
    await expect(overlay.result).resolves.toBe("new-task");
  });

  it("reads the mode when it opens, so a read-only mode hides and refuses the keys", () => {
    const overlay = open({ readOnly: () => true });
    overlay.send();
    expect(overlay.screen()).not.toContain("c continuar");
    overlay.key("c");
    expect(overlay.actions).toEqual([]);
    expect(overlay.screen()).toContain("solo lectura");
  });
});
