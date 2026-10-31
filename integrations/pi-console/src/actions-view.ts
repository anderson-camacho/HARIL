import type { DashboardArea, RailHitAction } from "./dashboard.js";
import { areaName, openMenuLabel } from "./dashboard.js";
import type { DashboardAction, DashboardControl } from "./dashboard-controls.js";
import { localized, type UiLocale } from "./locale.js";
import { CARD_CONTENT_WIDTH } from "./rail-metrics.js";
import type { DockCard } from "./rail-view.js";
import { wrap } from "./text.js";

// The ACC tab: the actions of the area chosen in MAIN's list, one button for each, plus the one that opens the complete
// /haril menu. They are the controls the MAIN rail used to list under ACCIONES, so a click runs what that row ran (a rail
// hit: `run` with the control, or `menu`); this module only gives each button an id and reads the hit back from it.
// The controls are handed in, never defined here: they come from the dashboard (railControls), the same ones the classic
// header and the keyboard menu list.

// What the view is built from: the chosen area, its controls and the language.
export interface ActionsInput {
  readonly area: DashboardArea;
  readonly controls: readonly DashboardControl[];
  readonly locale: UiLocale;
}

export interface ActionsRows {
  readonly status: string;
  readonly cards: DockCard[];
}

// The id of each button: `actions:run:<control>` for a control of the area, and one for the complete menu.
const RUN_PREFIX = "actions:run:";
const MENU_ID = "actions:menu";

function runId(control: DashboardAction): string {
  return `${RUN_PREFIX}${control}`;
}

// The rail hit a button stands for, or undefined when the id is not one of the buttons of these controls (a click that
// arrives after the area changed, on a control the new area does not have).
export function actionHit(
  id: string,
  controls: readonly DashboardControl[],
): RailHitAction | undefined {
  if (id === MENU_ID) return { action: "menu" };
  const control = controls.find((item) => runId(item.action) === id);
  return control === undefined ? undefined : { action: "run", control: control.action };
}

// The tab as cards: which area it is for, and the buttons. The area is chosen in MAIN, so the first card says so.
export function actionsRows(input: ActionsInput): ActionsRows {
  const say = (english: string, spanish: string): string =>
    localized(input.locale, english, spanish);
  const area = areaName(input.area);
  const title = say("Actions", "Acciones");
  const note = wrap(
    say(
      `Area chosen in MAIN: ${area}. Change it there.`,
      `Área elegida en MAIN: ${area}. Cámbiala allí.`,
    ),
    CARD_CONTENT_WIDTH,
  );
  const menu = { label: openMenuLabel(input.locale), action: MENU_ID };
  const controls = input.controls.map((control) => ({
    label: control.label,
    action: runId(control.action),
  }));
  return {
    status: say("Actions of the chosen area", "Acciones del área elegida"),
    cards: [
      { title: `${title} · ${area}`, rows: note, tones: note.map(() => "muted" as const) },
      controls.length === 0
        ? {
            title,
            rows: [say("This area has no actions.", "Esta área no tiene acciones.")],
            tones: ["muted"],
            buttons: [menu],
          }
        : { title, rows: [], buttons: [...controls, menu] },
    ],
  };
}
