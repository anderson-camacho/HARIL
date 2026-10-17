// The help overlay (TUI-D7): the two keyboard modes (LD-T6b-2), the / commands and every key of navigation mode. It
// fits the body of an 80x24 terminal without scrolling: seventeen lines, none wider than 80 columns.
export const HELP_LINES: readonly string[] = [
  "Input mode, on open: type a goal and Enter asks for a plan; Esc: navigation",
  "  /            commands: /projects /tasks /agents /tokens /events /models",
  "               /themes /plans /live /add /reload /help /quit /approve [id]",
  "               /deny [id]; Tab completes, Enter runs, Esc closes the list",
  "  Enter        on an empty line, the panel's Enter; arrows and Tab still move",
  "  Esc, i       Esc closes a view, else switches the mode; i returns to input",
  "Navigation mode (keys), every key below; Ctrl+C quits in both modes:",
  "  1-9, Tab     open panel 1 to 9, or the next one; Shift+Tab goes back",
  "  Up, Down     move the selection; PageUp, PageDown, Home and End jump",
  "  Enter        open a task or plan; pick a project filter or apply a theme",
  "  g            plan a goal: objective, planner and model; Enter asks for a plan",
  "  p            open the Plans panel: the plans waiting for approval",
  "  y, n         approve or deny the plan under the cursor or open on Plans",
  "  l            open the Live panel: state, tokens and result of newest tasks",
  "  a, t, r      add a task; open Themes; reload (and start the runtime for work)",
  "  ?, q         show or hide this help; quit",
  "Top bar: project, model, context, tokens, runtime; right column from 100 cols.",
];
