import { type RailHitAction, type RailSection, railSectionOpen } from "./dashboard.js";
import type { DashboardAction } from "./dashboard-controls.js";

// What the console offers to the actions a right-rail row can ask for. The classic header and the native dock both
// build one, so a click means the same thing in either.
export interface RailActionTarget {
  readonly railExpanded: Partial<Record<RailSection, boolean>>;
  redraw(): void;
  runControl(control: DashboardAction): void;
  chooseMode(): void;
  openMenu(): void;
  focus(): void;
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
    case "menu":
      target.openMenu();
      break;
    case "focus":
      target.focus();
      break;
    case "details":
      target.runControl("details");
      break;
  }
}
