import { type ActivityRange, ALL_RANGE, parseRange } from "./activity-range.js";
import { ACTIVITY_ACTIONS, type ActivityData, loadActivity } from "./activity-view.js";
import type { CliResult } from "./cli.js";
import { activityDetails, type DockDetails } from "./dock-details.js";
import { localized, type UiLocale } from "./locale.js";

// What the console does for the ACT tab besides drawing it: it holds the range for the session, reads the events again
// when a button changes it (or asks for a refresh), asks for a range of the user's own in two questions, and tells in a
// notice what the user typed that cannot be read. Every command goes through the HARIL CLI, in the background; none
// is waited for by the console, and nothing that goes wrong reaches the user as anything but a line in the tab or a
// notice.

const LOAD_TIMEOUT_MS = 8_000;

type Level = "info" | "warning" | "error";

export interface ActivityHost {
  // Runs `haril <args>`; never rejects in practice, and a rejection is treated as a failed command.
  run(args: readonly string[], options: { readonly timeoutMs: number }): Promise<CliResult>;
  locale(): UiLocale;
  // The project the console's folder is registered as; undefined when it is not one.
  projectSlug(): string | undefined;
  now(): number;
  // The session's questions and notices; undefined when there is no session to talk to.
  ui():
    | {
        input(title: string, placeholder?: string): Promise<string | undefined>;
        notify(message: string, level?: Level): void;
      }
    | undefined;
  // Draws the tab again from the data it holds: only its busy state changed.
  repaint(): void;
}

export interface ActivityPanel {
  // The tab, loaded with the range the session holds.
  load(): Promise<DockDetails>;
  // The tab drawn again from what the last load found, with the current busy state; undefined before any load.
  view(): DockDetails | undefined;
  // Runs the action of a button of the tab.
  act(action: string): Promise<void>;
  // The range the tab filters by now.
  range(): ActivityRange;
  // The events are being read.
  busy(): boolean;
  // The session ended: the range goes back to every event, and whatever is still being read or asked is dropped.
  reset(): void;
}

export function createActivityPanel(host: ActivityHost): ActivityPanel {
  let range: ActivityRange = ALL_RANGE;
  let busy = false;
  let lastData: ActivityData | undefined;
  // The latest read wins: an answer that comes after a newer read began is dropped. A session ending counts as one.
  let readSeq = 0;
  // The session the panel serves: a question asked in one session is not answered in the next.
  let generation = 0;
  let asking = false;
  const say = (english: string, spanish: string): string =>
    localized(host.locale(), english, spanish);

  const read = (): Promise<ActivityData> =>
    loadActivity(
      (args) => host.run(args, { timeoutMs: LOAD_TIMEOUT_MS }),
      host.projectSlug(),
      range,
      () => host.now(),
      host.locale(),
    );
  const details = (data: ActivityData, working: boolean): DockDetails =>
    activityDetails(data, { locale: host.locale(), range, busy: working });

  // Reads the events again: the tab shows «Cargando…» with the events it has, then what was found.
  async function reload(): Promise<void> {
    const seq = ++readSeq;
    busy = true;
    host.repaint();
    const data = await read();
    if (seq !== readSeq) return;
    lastData = data;
    busy = false;
    host.repaint();
  }

  // The two questions of «Rango…». Cancelling either, or leaving the first empty, changes nothing; an answer that cannot
  // be read is a notice and changes nothing either. Returns whether the range changed.
  async function askRange(): Promise<boolean> {
    const ui = host.ui();
    if (ui === undefined || asking) return false;
    asking = true;
    const session = generation;
    try {
      const from = await ui.input(
        say("Activity · from (3h, 2d or an ISO date)", "Actividad · desde (3h, 2d o fecha ISO)"),
        "",
      );
      if (from === undefined || from.trim() === "" || session !== generation) return false;
      const to = await ui.input(
        say("Activity · to (empty = now)", "Actividad · hasta (vacío = ahora)"),
        "",
      );
      if (to === undefined || session !== generation) return false;
      const parsed = parseRange(from, to, host.now(), host.locale());
      if (!parsed.ok) {
        ui.notify(parsed.reason, "warning");
        return false;
      }
      range = parsed.range;
      return true;
    } finally {
      asking = false;
    }
  }

  return {
    async load() {
      const seq = ++readSeq;
      const data = await read();
      if (seq === readSeq) {
        lastData = data;
        busy = false;
      }
      return details(data, false);
    },
    view() {
      return lastData === undefined ? undefined : details(lastData, busy);
    },
    async act(action) {
      switch (action) {
        case ACTIVITY_ACTIONS.hour:
          range = { kind: "hour" };
          break;
        case ACTIVITY_ACTIONS.day:
          range = { kind: "day" };
          break;
        case ACTIVITY_ACTIONS.all:
          range = ALL_RANGE;
          break;
        case ACTIVITY_ACTIONS.refresh:
          break;
        case ACTIVITY_ACTIONS.range:
          if (!(await askRange())) return;
          break;
        default:
          return;
      }
      await reload();
    },
    range: () => range,
    busy: () => busy,
    reset() {
      generation++;
      readSeq++;
      range = ALL_RANGE;
      busy = false;
      lastData = undefined;
      asking = false;
    },
  };
}
