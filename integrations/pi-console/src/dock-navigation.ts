import { paddedCell, visualText } from "./dashboard-theme.js";
import type { UiLocale } from "./locale.js";
import { DOCK_LABELS, type DockId, type DockSlot } from "./native-panes.js";
import { keyOf } from "./orchestration-state.js";

export type DockPickerResult =
  | { readonly type: "open"; readonly id: DockId }
  | { readonly type: "cancel" };

function visibleDockSlots(slots: readonly DockSlot[]): DockSlot[] {
  return slots.filter((slot) => slot.visible);
}

export function dockSlotAt(slots: readonly DockSlot[], oneBased: number): DockSlot | undefined {
  if (!Number.isInteger(oneBased) || oneBased < 1 || oneBased > 9) return undefined;
  return visibleDockSlots(slots)[oneBased - 1];
}

// Alt+L opens this Pi-native modal, then a digit or an arrow is captured by the modal.
export function createDockPicker(
  slots: readonly DockSlot[],
  selectedId: DockId,
  done: (result: DockPickerResult) => void,
  tui?: { requestRender(): void },
  locale: UiLocale = "es",
) {
  const visible = visibleDockSlots(slots);
  let selected = Math.max(
    0,
    visible.findIndex((slot) => slot.id === selectedId),
  );
  let closed = false;
  const finish = (result: DockPickerResult) => {
    if (closed) return;
    closed = true;
    done(result);
  };
  return {
    render(width: number): string[] {
      const span = Math.max(1, Math.min(width, 48));
      if (span < 12) return ["HARIL".slice(0, span)];
      const inner = span - 2;
      const line = (label: string, tone: "yellow" | "cyan" | "muted" | "text", active = false) =>
        `${visualText("│", "cyan", "panel")}${paddedCell(` ${label}`, inner, tone, active ? "selected" : "panel")}${visualText("│", "cyan", "panel")}`;
      return [
        visualText(`╭${"─".repeat(inner)}╮`, "teal", "panel"),
        line(
          locale === "es" ? "HARIL ◉ · Seleccionar plugin" : "HARIL ◉ · Select plugin",
          "yellow",
        ),
        line("Alt+L → número · ↑↓ · Enter · Esc", "muted"),
        ...visible.map((slot, index) => {
          const definition = DOCK_LABELS.find((item) => item.id === slot.id);
          const label = (locale === "es" ? definition?.label : definition?.labelEn) ?? slot.id;
          return line(
            `${index === selected ? "▸" : " "} ${index + 1}. ${label}`,
            index === selected ? "yellow" : "text",
            index === selected,
          );
        }),
        line(
          locale === "es"
            ? "Solo espacios visibles · sin instalar Pi"
            : "Visible slots only · Pi unchanged",
          "muted",
        ),
        visualText(`╰${"─".repeat(inner)}╯`, "teal", "panel"),
      ];
    },
    handleInput(input: string): void {
      if (closed) return;
      const key = keyOf(input);
      if (key === "escape") {
        finish({ type: "cancel" });
        return;
      }
      const digit = key !== undefined && /^[1-9]$/.test(key) ? Number(key) : NaN;
      if (Number.isInteger(digit)) {
        const slot = visible[digit - 1];
        if (slot) finish({ type: "open", id: slot.id });
        return;
      }
      if (key === "down" || key === "right") {
        if (visible.length > 0) selected = (selected + 1) % visible.length;
      } else if (key === "up" || key === "left") {
        if (visible.length > 0) selected = (selected + visible.length - 1) % visible.length;
      } else if (key === "enter") {
        const slot = visible[selected];
        if (slot) finish({ type: "open", id: slot.id });
        return;
      } else return;
      tui?.requestRender();
    },
    invalidate() {},
  };
}
