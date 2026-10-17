// The help overlay (TUI-D7): every key the shell answers to.
export const HELP_LINES: readonly string[] = [
  "Keys",
  "  1-9          open panel 1 to 9",
  "  Tab          next panel; Shift+Tab goes back (eleven, wrapping)",
  "  Up, Down     move the selection; PageUp, PageDown, Home and End jump",
  "  Enter        open a task; on Projects, pick the project filter; on Themes, apply the theme",
  "  a            add a task: title, agent and model (Tab moves, Enter adds, Esc cancels)",
  "  t            open the Themes panel; Enter there applies the theme and saves ui.theme",
  "  Esc          close the task detail or this help",
  "  r            reload from the store",
  "  ?            show or hide this help",
  "  q, Ctrl+C    quit",
  "",
  "Banner: isolation, pending approvals, runtime, project.",
];
