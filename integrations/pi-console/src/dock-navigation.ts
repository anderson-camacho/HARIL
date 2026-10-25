import { paddedCell, visualText } from "./dashboard-theme.js";
import { DOCK_LABELS, type DockId, type DockSlot } from "./native-panes.js";

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

// Alt+Z opens this Pi-native modal, then the next digit is captured by the modal rather than sent to the Pi editor.
// It is deliberately a two-key sequence, not an unsupported compound hotkey named "alt+z+1".
export function createDockPicker(
  slots: readonly DockSlot[],
  selectedId: DockId,
  done: (result: DockPickerResult) => void,
  tui?: { requestRender(): void },
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
        line("HARIL ◉ · Seleccionar plugin", "yellow"),
        line("Alt+Z → número · ↑↓ · Enter · Esc", "muted"),
        ...visible.map((slot, index) => {
          const label = DOCK_LABELS.find((item) => item.id === slot.id)?.label ?? slot.id;
          return line(
            `${index === selected ? "▸" : " "} ${index + 1}. ${label}`,
            index === selected ? "yellow" : "text",
            index === selected,
          );
        }),
        line("Solo espacios visibles · sin instalar Pi", "muted"),
        visualText(`╰${"─".repeat(inner)}╯`, "teal", "panel"),
      ];
    },
    handleInput(input: string): void {
      if (closed) return;
      if (input === "\u001b" || input === "\u001b[27u" || input === "\u001b[27;1u") {
        finish({ type: "cancel" });
        return;
      }
      const digit = /^[1-9]$/.test(input) ? Number(input) : NaN;
      if (Number.isInteger(digit)) {
        const slot = visible[digit - 1];
        if (slot) finish({ type: "open", id: slot.id });
        return;
      }
      if (input === "\u001b[B" || input === "\u001b[C") {
        if (visible.length > 0) selected = (selected + 1) % visible.length;
      } else if (input === "\u001b[A" || input === "\u001b[D") {
        if (visible.length > 0) selected = (selected + visible.length - 1) % visible.length;
      } else if (input === "\r" || input === "\n" || input === "\u001b[13u") {
        const slot = visible[selected];
        if (slot) finish({ type: "open", id: slot.id });
        return;
      } else return;
      tui?.requestRender();
    },
    invalidate() {},
  };
}
