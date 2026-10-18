import type { OrchestrationGlyphs, RenderedBlock } from "./orchestration-draw.js";
import {
  type OrchestrationEffect,
  type OrchestrationState,
  type OrchestrationTransition,
  orchestrationClick,
  orchestrationKey,
  reduceOrchestration,
} from "./orchestration-state.js";
import { renderOrchestrationScreen } from "./orchestration-view.js";
import type { ConsoleContext, ConsoleMouseEvent } from "./pi-types.js";

// The full ORCHESTRATION view as a Pi overlay over the whole terminal (ctx.ui.custom, like the details pager). Inside
// it the overlay owns the keyboard, so plain keys work (Tab, arrows, Enter, L, F, D, W, R, S, Esc); in fullscreen
// mode clicks on its hit-boxes do the same. The state lives in the console session, so the module panel shows the
// same selection and demo data after it closes.

export interface OrchestrationOverlayHost {
  get(): OrchestrationState;
  set(state: OrchestrationState): void;
  readonly glyphs: OrchestrationGlyphs;
}

// Resolves when the view closes: undefined after Esc or Close, "emergency-stop" when the user asked for the real stop,
// which the caller runs once the overlay is gone (■ STOP ALL, no confirmation), so its report is seen.
export function openOrchestrationOverlay(
  ctx: ConsoleContext,
  host: OrchestrationOverlayHost,
): Promise<OrchestrationEffect | undefined> {
  return ctx.ui.custom<OrchestrationEffect | undefined>(
    (tui, _theme, _keybindings, done) => {
      let block: RenderedBlock = { lines: [], hits: [] };
      let finished = false;
      const apply = (transition: OrchestrationTransition): void => {
        host.set(transition.state);
        if (transition.effect === "close" || transition.effect === "emergency-stop") {
          if (finished) return;
          finished = true;
          done(transition.effect === "close" ? undefined : transition.effect);
          return;
        }
        tui.requestRender();
      };
      return {
        render(width) {
          block = renderOrchestrationScreen(
            host.get(),
            Math.max(1, width),
            Math.max(1, tui.terminal.rows),
            host.glyphs,
          );
          return block.lines;
        },
        handleInput(data) {
          const transition = orchestrationKey(host.get(), data, Date.now());
          if (transition.handled) apply(transition);
        },
        handleMouse(event: ConsoleMouseEvent) {
          if (event.type === "wheel") {
            const delta = Math.sign(event.wheelDelta ?? 0);
            if (delta !== 0) apply(reduceOrchestration(host.get(), { type: "move", delta }));
            return { handled: true, render: true };
          }
          if (event.type !== "click" || event.button !== "left") return undefined;
          const hit = block.hits.find(
            (item) => item.row === event.y && event.x >= item.start && event.x < item.end,
          );
          if (hit === undefined) return undefined;
          apply(orchestrationClick(host.get(), hit.target, Date.now(), "view"));
          return { handled: true, render: true };
        },
        invalidate() {},
      };
    },
    { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
  );
}
