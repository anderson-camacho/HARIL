import { describe, expect, it, vi } from "vitest";
import { createDockPicker, dockSlotAt } from "../src/dock-navigation.js";
import { initialPaneSettings } from "../src/native-panes.js";
import { stripAnsi, textWidth } from "../src/text.js";

describe("HARIL dock shortcuts", () => {
  it("uses visible persisted ordering for numeric navigation", () => {
    const slots = [
      { id: "memory", visible: true },
      { id: "youtube", visible: false },
      { id: "git", visible: true },
      { id: "explorer", visible: true },
      { id: "themes", visible: true },
    ] as const;
    expect(dockSlotAt(slots, 1)?.id).toBe("memory");
    expect(dockSlotAt(slots, 2)?.id).toBe("git");
    expect(dockSlotAt(slots, 5)).toBeUndefined();
    expect(dockSlotAt(slots, 0)).toBeUndefined();
  });

  it("Alt+L overlay captures a digit or arrow+Enter and never writes into Pi's editor", () => {
    const state = initialPaneSettings();
    const chosen = vi.fn();
    const tui = { requestRender: vi.fn() };
    const picker = createDockPicker(state.slots, "explorer", chosen, tui);
    expect(
      picker
        .render(48)
        .map(stripAnsi)
        .every((line) => textWidth(line) === 48),
    ).toBe(true);
    picker.handleInput("\u001b[B");
    picker.handleInput("\r");
    expect(chosen).toHaveBeenCalledWith({ type: "open", id: "git" });
    picker.handleInput("3");
    expect(chosen).toHaveBeenCalledTimes(1);

    const numeric = createDockPicker(state.slots, "explorer", chosen);
    numeric.handleInput("5");
    expect(chosen).toHaveBeenLastCalledWith({ type: "open", id: "themes" });
    const cancel = createDockPicker(state.slots, "explorer", chosen);
    cancel.handleInput("\u001b");
    expect(chosen).toHaveBeenLastCalledWith({ type: "cancel" });
  });

  it.each([
    ["legacy", "\u001b[A", "\u001b[B"],
    ["SS3", "\u001bOA", "\u001bOB"],
    ["Kitty CSI", "\u001b[1;1A", "\u001b[1;1B"],
  ])("navigates plugin rows with %s terminal arrows", (_name, up, down) => {
    const selected = vi.fn();
    const tui = { requestRender: vi.fn() };
    const picker = createDockPicker(initialPaneSettings().slots, "explorer", selected, tui);
    picker.handleInput(down);
    expect(picker.render(48).map(stripAnsi).join("\n")).toContain("▸ 2. Git");
    picker.handleInput(up);
    expect(picker.render(48).map(stripAnsi).join("\n")).toContain("▸ 1. Explorador");
    picker.handleInput(up);
    expect(picker.render(48).map(stripAnsi).join("\n")).toContain("▸ 5. Temas");
    expect(tui.requestRender).toHaveBeenCalledTimes(3);
    picker.handleInput("\u001b[13u");
    expect(selected).toHaveBeenCalledWith({ type: "open", id: "themes" });
  });

  it("ignores unrelated shortcuts and accepts Kitty Escape", () => {
    const chosen = vi.fn();
    const picker = createDockPicker(initialPaneSettings().slots, "explorer", chosen);
    picker.handleInput("\u001b[97;3u");
    picker.handleInput("\u001b[27u");
    expect(chosen).toHaveBeenCalledWith({ type: "cancel" });
    expect(chosen).toHaveBeenCalledTimes(1);
  });
});
