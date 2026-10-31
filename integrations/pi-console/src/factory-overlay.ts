import type { FactoryGlyphs } from "./factory-kit.js";
import {
  type FactoryState,
  type FactoryTransition,
  factoryClick,
  factoryKey,
  factoryMove,
} from "./factory-state.js";
import { renderFactoryScreen } from "./factory-view.js";
import type { ConsoleContext, ConsoleMouseEvent } from "./pi-types.js";

// The factory view as a Pi overlay over the whole terminal (ctx.ui.custom, like the orchestration view). Inside it the
// overlay owns the keyboard, so plain keys work; in fullscreen mode clicks on its hit-boxes do the same. It only views:
// nothing here changes HARIL's state, so it opens in every mode. The state lives in the console session.

export interface FactoryOverlayHost {
  get(): FactoryState;
  set(state: FactoryState): void;
  readonly glyphs: FactoryGlyphs;
}

// Resolves when the view closes.
export function openFactoryOverlay(
  ctx: ConsoleContext,
  host: FactoryOverlayHost,
): Promise<undefined> {
  return ctx.ui.custom<undefined>(
    (tui, _theme, _keybindings, done) => {
      let block = renderFactoryScreen(host.get(), 1, 1, host.glyphs);
      let finished = false;
      const apply = (transition: FactoryTransition): void => {
        host.set(transition.state);
        if (transition.effect === "close") {
          if (finished) return;
          finished = true;
          done(undefined);
          return;
        }
        tui.requestRender();
      };
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
}
