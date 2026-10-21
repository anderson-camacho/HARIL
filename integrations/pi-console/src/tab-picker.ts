import { DASHBOARD_AREAS, areaLabel, type DashboardArea } from "./dashboard.js";
import { paddedCell, visualText } from "./dashboard-theme.js";
import { DEFAULT_UI_LOCALE, localized, type UiLocale } from "./locale.js";
import type { ConsoleTheme } from "./pi-types.js";

export type TabPickerResult =
  | { readonly type: "open"; readonly area: DashboardArea }
  | { readonly type: "cancel" };

export function initialTabPickerIndex(current: DashboardArea | undefined): number {
  const index = current === undefined ? -1 : DASHBOARD_AREAS.indexOf(current);
  return index < 0 ? 0 : index;
}

export function createTabPicker(
  current: DashboardArea | undefined,
  done: (result: TabPickerResult) => void,
  tui?: { requestRender(): void },
  _theme?: ConsoleTheme,
  locale: UiLocale = DEFAULT_UI_LOCALE,
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
          ...DASHBOARD_AREAS.map((area) => areaLabel(area, locale).slice(0, span)),
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
        cell(localized(locale, "HARIL ◉ · Choose dashboard area", "HARIL ◉ · Elegir sección"), "yellow"),
        cell(localized(locale, "↑/↓ move · Enter open · Esc cancel", "↑/↓ mover · Enter abrir · Esc cancelar"), "muted"),
        ...DASHBOARD_AREAS.map((area, index) =>
          cell(
            `${index === selected ? "▶" : " "} ${areaLabel(area, locale)}`,
            index === selected ? "yellow" : "text",
            index === selected,
          ),
        ),
        cell(localized(locale, "Enter: open · Esc: close", "Enter: abrir · Esc: cerrar"), "teal"),
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
