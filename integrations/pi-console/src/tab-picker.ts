import { DASHBOARD_AREAS, type DashboardArea } from "./dashboard.js";
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
  theme?: ConsoleTheme,
) {
  let selected = initialTabPickerIndex(current);
  let closed = false;
  return {
    render(width: number): string[] {
      const limit = Math.max(1, width);
      const row = (text: string): string => (text.length > limit ? text.slice(0, limit) : text);
      const heading =
        theme?.bold(theme.fg("warning", "Choose dashboard area")) ?? "Choose dashboard area";
      const options = DASHBOARD_AREAS.map((area, index) => {
        const label = `${index === selected ? "▶ " : "  "}${LABELS[area]}`;
        return index === selected ? (theme?.fg("warning", label) ?? label) : label;
      });
      const hint =
        theme?.fg("dim", "←/→ move · Enter open · Esc cancel") ??
        "←/→ move · Enter open · Esc cancel";
      return [row(heading), ...options.map(row), row(hint)];
    },
    handleInput(input: string): void {
      if (closed) return;
      if (input === "\u001b[C") selected = (selected + 1) % DASHBOARD_AREAS.length;
      else if (input === "\u001b[D")
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
