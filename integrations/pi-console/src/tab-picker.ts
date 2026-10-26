import { DASHBOARD_AREAS, type DashboardArea } from "./dashboard.js";
import { paddedCell, visualText } from "./dashboard-theme.js";
import { keyOf } from "./orchestration-state.js";
import type { ConsoleTheme } from "./pi-types.js";

export type TabPickerResult =
  | { readonly type: "open"; readonly area: DashboardArea }
  | { readonly type: "cancel" };

const LABELS: Readonly<Record<DashboardArea, string>> = {
  agents: "AGENTS",
  orchestration: "ORCHESTRATION",
  automation: "AUTOMATION",
  tools: "TOOLS",
  everywhere: "EVERYWHERE",
};

export function initialTabPickerIndex(current: DashboardArea | undefined): number {
  const index = current === undefined ? -1 : DASHBOARD_AREAS.indexOf(current);
  return index < 0 ? 0 : index;
}

export function createTabPicker(
  current: DashboardArea | undefined,
  done: (result: TabPickerResult) => void,
  tui?: { requestRender(): void },
  _theme?: ConsoleTheme,
) {
  let selected = initialTabPickerIndex(current);
  let closed = false;
  return {
    render(width: number): string[] {
      // Bounded overlay: use HARIL's logo color for borders without stealing the whole terminal.
      const span = Math.max(1, Math.min(width, 54));
      if (span < 12)
        return [
          "HARIL".slice(0, span),
          ...DASHBOARD_AREAS.map((area) => LABELS[area].slice(0, span)),
        ];
      const inside = span - 2;
      const horizontal = visualText(`╭${"─".repeat(inside)}╮`, "teal", "panel");
      const bottom = visualText(`╰${"─".repeat(inside)}╯`, "teal", "panel");
      const side = visualText("│", "teal", "panel");
      const cell = (
        label: string,
        tone: "cyan" | "teal" | "yellow" | "text" | "muted",
        active = false,
      ): string =>
        `${side}${paddedCell(` ${label}`, inside, tone, active ? "selected" : "panel")}${side}`;
      return [
        horizontal,
        cell("HARIL ◉  ·  Choose dashboard area", "yellow"),
        cell("↑/↓ move · Enter open · Esc cancel", "muted"),
        ...DASHBOARD_AREAS.map((area, index) =>
          cell(
            `${index === selected ? "▶" : " "} ${LABELS[area]}`,
            index === selected ? "yellow" : "text",
            index === selected,
          ),
        ),
        cell("Enter: open  ·  Esc: close", "teal"),
        bottom,
      ];
    },
    handleInput(input: string): void {
      if (closed) return;
      const key = keyOf(input);
      // This picker is a vertical list: ↑/↓ are primary. ←/→ remain supported.
      if (key === "down" || key === "right") selected = (selected + 1) % DASHBOARD_AREAS.length;
      else if (key === "up" || key === "left")
        selected = (selected + DASHBOARD_AREAS.length - 1) % DASHBOARD_AREAS.length;
      else if (key === "enter") {
        const area = DASHBOARD_AREAS[selected];
        if (area === undefined) return;
        closed = true;
        done({ type: "open", area });
        return;
      } else if (key === "escape") {
        closed = true;
        done({ type: "cancel" });
        return;
      } else return;
      tui?.requestRender();
    },
    invalidate() {},
  };
}
