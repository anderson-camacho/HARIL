import { SAVED_MARK } from "./factory-actions.js";
import type { FactoryFeed } from "./factory-feed.js";
import type { FactoryGlyphs } from "./factory-kit.js";
import type { FactorySystemData } from "./factory-settings.js";
import {
  type FactoryAction,
  type FactoryState,
  type FactoryTransition,
  factoryClick,
  factoryFeedEnded,
  factoryKey,
  factoryModelArrived,
  factoryMove,
  factoryNotice,
  factorySettingSaved,
  factorySystemArrived,
} from "./factory-state.js";
import type { FactoryModel } from "./factory-types.js";
import { renderFactoryScreen } from "./factory-view.js";
import type { ConsoleContext, ConsoleMouseEvent } from "./pi-types.js";

// The factory view as a Pi overlay over the whole terminal (ctx.ui.custom, like the orchestration view). Inside it the
// overlay owns the keyboard, so plain keys work; in fullscreen mode clicks on its hit-boxes do the same. It opens in every
// mode; the few keys that change HARIL's state ask first, run the same CLI commands as /continue, /approve and /deny, and
// are refused in a read-only mode. Its data comes from a child (factory-feed.ts) that runs only while it is open.

export interface FactoryOverlayHost {
  get(): FactoryState;
  set(state: FactoryState): void;
  readonly glyphs: FactoryGlyphs;
  // Starts following the data; closed when the view closes.
  startFeed?(listener: { onModel(model: FactoryModel): void; onEnded(): void }): FactoryFeed;
  // Runs a confirmed action; the answer is shown on the screen.
  act?(action: FactoryAction): Promise<string>;
  readOnly?(): boolean;
  // CONSULT and PLAN refuse to change settings.
  settingsLocked?(): boolean;
  // The Sistema tab's data; read when the view opens and after a saved setting.
  loadSystem?(): Promise<FactorySystemData>;
}

// What the view asks the console to do once it closed.
export type FactoryOverlayResult = "new-task" | undefined;

// Resolves when the view closes.
export async function openFactoryOverlay(
  ctx: ConsoleContext,
  host: FactoryOverlayHost,
): Promise<FactoryOverlayResult> {
  let feed: FactoryFeed | undefined;
  host.set({
    ...host.get(),
    readOnly: host.readOnly?.() ?? false,
    settingsLocked: host.settingsLocked?.() ?? false,
    confirm: null,
    notice: null,
    settingDraft: null,
    settingEdit: null,
    savedPath: null,
  });
  try {
    return await ctx.ui.custom<FactoryOverlayResult>(
      (tui, _theme, _keybindings, done) => {
        let block = renderFactoryScreen(host.get(), 1, 1, host.glyphs);
        let finished = false;
        const finish = (result: FactoryOverlayResult): void => {
          if (finished) return;
          finished = true;
          feed?.close();
          done(result);
        };
        const loadSystem = (): void => {
          void host.loadSystem?.().then(
            (data) => {
              if (finished) return;
              host.set(factorySystemArrived(host.get(), data));
              tui.requestRender();
            },
            () => undefined,
          );
        };
        const run = (action: FactoryAction): void => {
          if (host.act === undefined) return;
          void host.act(action).then(
            (answer) => {
              if (finished) return;
              const saved = action.kind === "setting" && answer.startsWith(SAVED_MARK);
              const state = saved ? factorySettingSaved(host.get(), action.path) : host.get();
              host.set(factoryNotice(state, answer));
              if (saved) loadSystem();
              tui.requestRender();
            },
            (error: unknown) => {
              if (finished) return;
              host.set(
                factoryNotice(host.get(), error instanceof Error ? error.message : String(error)),
              );
              tui.requestRender();
            },
          );
        };
        const apply = (transition: FactoryTransition): void => {
          host.set(transition.state);
          const { effect } = transition;
          if (effect === "close" || effect === "new-task") {
            finish(effect === "close" ? undefined : effect);
            return;
          }
          if (effect !== undefined) run(effect);
          tui.requestRender();
        };
        feed = host.startFeed?.({
          onModel: (model) => {
            if (finished) return;
            host.set(factoryModelArrived(host.get(), model));
            tui.requestRender();
          },
          onEnded: () => {
            if (finished) return;
            host.set(factoryFeedEnded(host.get()));
            tui.requestRender();
          },
        });
        loadSystem();
        return {
          render(width) {
            block = renderFactoryScreen(
              host.get(),
              Math.max(1, width),
              Math.max(1, tui.terminal.rows),
              host.glyphs,
            );
            return block.lines;
          },
          handleInput(data) {
            const transition = factoryKey(host.get(), data);
            if (transition.handled) apply(transition);
          },
          handleMouse(event: ConsoleMouseEvent) {
            if (event.type === "wheel") {
              const delta = Math.sign(event.wheelDelta ?? 0);
              if (delta !== 0) apply(factoryMove(host.get(), delta));
              return { handled: true, render: true };
            }
            if (event.type !== "click" || event.button !== "left") return undefined;
            const hit = block.hits.find(
              (item) => item.row === event.y && event.x >= item.start && event.x < item.end,
            );
            if (hit === undefined) return undefined;
            apply(factoryClick(host.get(), hit.target));
            return { handled: true, render: true };
          },
          invalidate() {},
        };
      },
      { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
    );
  } finally {
    // However the view went away, the child does not outlive it.
    feed?.close();
  }
}
