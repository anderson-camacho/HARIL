// The help overlay (TUI-D7): every key the shell answers to.
export const HELP_LINES: readonly string[] = [
  "Keys",
  "  1-9          open panel 1 to 9",
  "  Tab          next panel; Shift+Tab goes back (eleven, wrapping)",
  "  Up, Down     move the selection; PageUp, PageDown, Home and End jump",
  "  Enter        open a task; on Projects, pick the project filter",
  "  Esc          close the task detail or this help",
  "  r            reload from the store",
  "  ?            show or hide this help",
  "  q, Ctrl+C    quit",
  "",
  "Banner: isolation, pending approvals (0 in this version), runtime, project.",
];
