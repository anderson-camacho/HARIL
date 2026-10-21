import { DASHBOARD_AREAS, type DashboardArea } from "./dashboard.js";
import { frameGlyph, paddedCell } from "./dashboard-theme.js";
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
      if (span < 12) return ["HARIL".slice(0, span), ...DASHBOARD_AREAS.map((area) => LABELS[area].slice(0, span))];
      const inside = span - 2;
      const horizontal = frameGlyph(`╭${"─".repeat(inside)}╮`);
      const bottom = frameGlyph(`╰${"─".repeat(inside)}╯`);
      const cell = (
        label: string,
        tone: "cyan" | "teal" | "yellow" | "text" | "muted",
        active = false,
      ): string =>
        `${frameGlyph("│")}${paddedCell(` ${label}`, inside, tone, active ? "selected" : "panel")}${frameGlyph("│")}`;
      return [
        horizontal,
        cell("HARIL ◉  ·  Choose dashboard area", "yellow"),
        cell("↑/↓ move · Enter open · Esc cancel", "muted"),
        ...DASHBOARD_AREAS.map((area, index) =>
          cell(`${index === selected ? "▶" : " "} ${LABELS[area]}`, index === selected ? "yellow" : "text", index === selected),
        ),
        cell("Enter: open  ·  Esc: close", "teal"),
        bottom,
      ];
    },
    handleInput(input: string): void {
      if (closed) return;
      // This picker is a vertical list: ↑/↓ are primary. ←/→ remain supported.
      if (input === "\u001b[B" || input === "\u001b[C")
        selected = (selected + 1) % DASHBOARD_AREAS.length;
      else if (input === "\u001b[A" || input === "\u001b[D")
        selected = (selected + DASHBOARD_AREAS.length - 1) % DASHBOARD_AREAS.length;
      else if (input === "\r" || input === "\n") {
        const area = DASHBOARD_AREAS[selected];
        if (area === undefined) return;
        closed = true;
        done({ type: "open", area });
        return;
      } else if (input === "\u001b" || input === "\u001b[27u" || input === "\u001b[27;1u") {
        closed = true;
        done({ type: "cancel" });
        return;
      } else return;
      tui?.requestRender();
    },
    invalidate() {},
  };
}
