import { describe, expect, it, vi } from "vitest";
import { createDockPicker, dockIdFromWord, dockSlotAt } from "../src/dock-navigation.js";
import { initialPaneSettings } from "../src/native-panes.js";
import { stripAnsi, textWidth } from "../src/text.js";

describe("HARIL dock shortcuts", () => {
  it("uses visible persisted ordering for numeric navigation", () => {
    const slots = [
      { id: "main", visible: true },
      { id: "docs", visible: true },
      { id: "memory", visible: false },
    ] as const;
    expect(dockSlotAt(slots, 1)?.id).toBe("main");
    expect(dockSlotAt(slots, 2)?.id).toBe("docs");
    expect(dockSlotAt(slots, 3)).toBeUndefined();
    expect(dockSlotAt(slots, 0)).toBeUndefined();
  });

  it("names a slot by its id or by an alias: «tools» is the slot stored as «memory»", () => {
    expect(dockIdFromWord("tools")).toBe("memory");
    expect(dockIdFromWord("memory")).toBe("memory");
    for (const id of ["main", "docs", "activity", "actions"]) expect(dockIdFromWord(id)).toBe(id);
    for (const word of ["", "mem", "TOOLS", "youtube", "constructor", "__proto__", "details"]) {
      expect(dockIdFromWord(word), word).toBeUndefined();
    }
  });

  it("Alt+L overlay captures a digit or arrow+Enter and never writes into Pi's editor", () => {
    const state = initialPaneSettings();
    const chosen = vi.fn();
    const tui = { requestRender: vi.fn() };
    const picker = createDockPicker(state.slots, "main", chosen, tui);
    expect(
      picker
        .render(48)
        .map(stripAnsi)
        .every((line) => textWidth(line) === 48),
    ).toBe(true);
    picker.handleInput("\u001b[B");
    picker.handleInput("\r");
    expect(chosen).toHaveBeenCalledWith({ type: "open", id: "memory" });
    picker.handleInput("3");
    expect(chosen).toHaveBeenCalledTimes(1);

    const numeric = createDockPicker(state.slots, "main", chosen);
    numeric.handleInput("3");
    expect(chosen).toHaveBeenLastCalledWith({ type: "open", id: "docs" });
    const fourth = createDockPicker(state.slots, "main", chosen);
    fourth.handleInput("4");
    expect(chosen).toHaveBeenLastCalledWith({ type: "open", id: "activity" });
    const fifth = createDockPicker(state.slots, "main", chosen);
    fifth.handleInput("5");
    expect(chosen).toHaveBeenLastCalledWith({ type: "open", id: "actions" });
    // Only five slots exist: a sixth digit opens nothing.
    const beyond = createDockPicker(state.slots, "main", chosen);
    beyond.handleInput("6");
    expect(chosen).toHaveBeenCalledTimes(4);
    const cancel = createDockPicker(state.slots, "main", chosen);
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
    const picker = createDockPicker(initialPaneSettings().slots, "main", selected, tui);
    picker.handleInput(down);
    expect(picker.render(48).map(stripAnsi).join("\n")).toContain("▸ 2. Tools");
    picker.handleInput(up);
    expect(picker.render(48).map(stripAnsi).join("\n")).toContain("▸ 1. Principal");
    picker.handleInput(up);
    expect(picker.render(48).map(stripAnsi).join("\n")).toContain("▸ 5. Acciones");
    expect(tui.requestRender).toHaveBeenCalledTimes(3);
    picker.handleInput("\u001b[13u");
    expect(selected).toHaveBeenCalledWith({ type: "open", id: "actions" });
  });

  it("lists the five slots in the order of the registry, ACC last, in English too", () => {
    const picker = createDockPicker(initialPaneSettings().slots, "main", vi.fn(), undefined, "en");
    const text = picker.render(48).map(stripAnsi);
    expect(text.every((line) => textWidth(line) === 48)).toBe(true);
    const names = text
      .filter((line) => /\d\. /.test(line))
      .map((line) => line.replace(/[│▸ ]+/gu, " ").trim());
    expect(names).toEqual(["1. Main", "2. Tools", "3. Docs", "4. Activity", "5. Actions"]);
    // A hidden slot is not offered and the digits count the visible ones.
    const hidden = createDockPicker(
      [
        { id: "main", visible: true },
        { id: "actions", visible: true },
        { id: "memory", visible: false },
        { id: "docs", visible: true },
        { id: "activity", visible: false },
      ],
      "main",
      vi.fn(),
    );
    expect(hidden.render(48).map(stripAnsi).join("\n")).not.toContain("Tools");
    expect(
      dockSlotAt(
        [
          { id: "main", visible: true },
          { id: "actions", visible: true },
        ],
        2,
      )?.id,
    ).toBe("actions");
  });

  it("ignores unrelated shortcuts and accepts Kitty Escape", () => {
    const chosen = vi.fn();
    const picker = createDockPicker(initialPaneSettings().slots, "main", chosen);
    picker.handleInput("\u001b[97;3u");
    picker.handleInput("\u001b[27u");
    expect(chosen).toHaveBeenCalledWith({ type: "cancel" });
    expect(chosen).toHaveBeenCalledTimes(1);
  });
});
