import {
  type DashboardArea,
  type NativeRailContent,
  type RailHitAction,
  type RailSection,
  railSectionOpen,
} from "./dashboard.js";
import type { DashboardAction } from "./dashboard-controls.js";
import { DEFAULT_UI_LOCALE, localized, type UiLocale } from "./locale.js";
import { stripAnsi } from "./text.js";

// What the console offers to the actions a right-rail row can ask for. The classic header and the native dock both
// build one, so a click means the same thing in either.
export interface RailActionTarget {
  readonly railExpanded: Partial<Record<RailSection, boolean>>;
  redraw(): void;
  runControl(control: DashboardAction): void;
  chooseMode(): void;
  chooseModel(): void;
  chooseLevel(): void;
  stopAll(): void;
  openMenu(): void;
  focus(): void;
  openArea(area: DashboardArea): void;
}

export function runRailHit(target: RailActionTarget, hit: RailHitAction): void {
  switch (hit.action) {
    case "toggle":
      if (hit.section !== undefined) {
        target.railExpanded[hit.section] = !railSectionOpen(target.railExpanded, hit.section);
        target.redraw();
      }
      break;
    case "run":
      if (hit.control !== undefined) target.runControl(hit.control);
      break;
    case "mode":
      target.chooseMode();
      break;
    case "model":
      target.chooseModel();
      break;
    case "level":
      target.chooseLevel();
      break;
    case "stop":
      target.stopAll();
      break;
    case "menu":
      target.openMenu();
      break;
    case "focus":
      target.focus();
      break;
    case "details":
      target.runControl("details");
      break;
    case "area":
      if (hit.area !== undefined) target.openArea(hit.area);
      break;
  }
}

// A choice in the keyboard menu of the right rail: the words the user reads and the hit a click on that row would run.
export interface RailMenuEntry {
  readonly label: string;
  readonly hit: RailHitAction;
}

// "details" on a warning or status row asks for the same view as the "View complete details" control, so both are one
// entry, and it carries the control's hit.
const DETAILS_HIT: RailHitAction = { action: "run", control: "details" };
// A section row reads "▼ AVISOS · 1": the arrow says whether it is open, the trailing number is its count.
const SECTION_ROW = /^([▼▶])\s+(.+?)(?:\s+·\s+(\d+))?$/u;

function plainLabel(text: string): string {
  return text
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[\s↗…•]+$/u, "")
    .trim();
}

// "▼ ACCIONES · AGENTS · 4" becomes "Cerrar sección acciones · AGENTS (4)": the state in words instead of an arrow.
function sectionLabel(text: string, locale: UiLocale): string {
  const match = SECTION_ROW.exec(text);
  if (match === null) return plainLabel(text);
  const [, arrow, name = "", count] = match;
  const verb =
    arrow === "▼"
      ? localized(locale, "Close section", "Cerrar sección")
      : localized(locale, "Open section", "Abrir sección");
  const [first = "", ...rest] = name.split(" · ");
  const title = [first.toLocaleLowerCase(locale), ...rest].join(" · ");
  return `${verb} ${title}${count === undefined ? "" : ` (${count})`}`;
}

function menuEntry(hit: RailHitAction, text: string, locale: UiLocale): RailMenuEntry | undefined {
  switch (hit.action) {
    case "toggle":
      return hit.section === undefined ? undefined : { label: sectionLabel(text, locale), hit };
    case "run":
      return hit.control === undefined ? undefined : { label: plainLabel(text), hit };
    case "mode":
      return { label: localized(locale, "Change mode", "Cambiar modo"), hit };
    case "model":
      return { label: localized(locale, "Choose the model", "Elegir modelo"), hit };
    case "level":
      return { label: localized(locale, "Choose the level", "Elegir nivel"), hit };
    case "stop":
      return { label: localized(locale, "Stop all agents", "Detener todos los agentes"), hit };
    case "menu":
      return { label: plainLabel(text), hit };
    case "focus":
      return { label: localized(locale, "Open the area details", "Abrir detalles del área"), hit };
    case "details":
      return {
        label: localized(locale, "View complete details", "Ver detalles completos"),
        hit: DETAILS_HIT,
      };
    case "area":
      // The row reads "● AGENTS" or "○ AGENTS": the dot says whether it is the open one, the name is what it opens.
      return hit.area === undefined
        ? undefined
        : { label: `${localized(locale, "Open area", "Abrir área")} ${plainLabel(text)}`, hit };
  }
}

/**
 * The right rail takes no keyboard focus, so its keyboard path is a menu with what a click on it can do: one entry
 * for each row that carries a hit, in rail order, with one entry for each distinct effect. Render the content wide
 * (well past the pane's 39 columns) so no row text arrives cut with an ellipsis.
 */
export function buildRailMenu(
  content: NativeRailContent,
  locale: UiLocale = DEFAULT_UI_LOCALE,
): RailMenuEntry[] {
  const entries: RailMenuEntry[] = [];
  const seen = new Set<string>();
  for (const [index, line] of content.lines.entries()) {
    const hit = content.hits[index];
    if (hit === undefined) continue;
    const entry = menuEntry(hit, stripAnsi(line).trim(), locale);
    if (entry === undefined) continue;
    const effect = `${entry.hit.action}:${entry.hit.section ?? ""}:${entry.hit.control ?? ""}:${entry.hit.area ?? ""}`;
    if (seen.has(effect)) continue;
    seen.add(effect);
    entries.push(entry);
  }
  return entries;
}
