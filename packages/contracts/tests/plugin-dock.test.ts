import { describe, expect, it } from "vitest";
import {
  DOCK_SLOTS,
  dockPreferenceErrors,
  dockSlotExists,
  resolveDockSlots,
} from "../src/plugin-dock.js";

const current = [
  { id: "git", visible: true },
  { id: "youtube", visible: false },
  { id: "memory", visible: true },
  { id: "themes", visible: true },
];

// Releases before the TREE slot was removed stored five entries, the first being the retired "explorer".
const legacy = [{ id: "explorer", visible: true }, ...current];

describe("dock slot preferences", () => {
  it("offers the four current slots and no longer knows explorer", () => {
    expect(DOCK_SLOTS.map((slot) => slot.id)).toEqual(["git", "youtube", "memory", "themes"]);
    expect(dockSlotExists("explorer")).toBe(false);
  });

  it("accepts the four-entry list as it is", () => {
    expect(dockPreferenceErrors(current)).toEqual([]);
    expect(resolveDockSlots(current)).toEqual(current);
  });

  it("defaults to every slot visible when nothing is stored", () => {
    expect(resolveDockSlots(undefined)).toEqual(
      DOCK_SLOTS.map((slot) => ({ id: slot.id, visible: true })),
    );
  });

  describe("a stored list that still carries the retired explorer entry", () => {
    it("is valid: the retired entry is ignored before the length and id checks", () => {
      expect(dockPreferenceErrors(legacy)).toEqual([]);
    });

    it("resolves to the four remaining slots, keeping their order and visibility", () => {
      expect(resolveDockSlots(legacy)).toEqual(current);
      const reordered = [legacy[2], legacy[0], legacy[1], legacy[4], legacy[3]];
      expect(resolveDockSlots(reordered).map((slot) => slot.id)).toEqual([
        "youtube",
        "git",
        "themes",
        "memory",
      ]);
    });

    it("does not mutate the stored value, so the next write is what heals the file", () => {
      const stored = legacy.map((slot) => ({ ...slot }));
      resolveDockSlots(stored);
      expect(stored).toEqual(legacy);
    });

    it("still reports real problems, at the index they have in the stored list", () => {
      const duplicated = [legacy[0], legacy[1], legacy[1], legacy[3], legacy[4]];
      expect(dockPreferenceErrors(duplicated)).toEqual([
        "/ui/plugins/2/id: duplicate dock slot git",
      ]);
      const unknown = [
        legacy[0],
        legacy[1],
        { id: "mystery", visible: true },
        legacy[3],
        legacy[4],
      ];
      expect(dockPreferenceErrors(unknown)).toEqual(["/ui/plugins/2/id: unknown dock slot"]);
    });

    it("still rejects a list that is missing a current slot", () => {
      expect(dockPreferenceErrors(legacy.slice(0, 4))).toEqual([
        "/ui/plugins: must contain all 4 dock slots exactly once",
      ]);
      expect(resolveDockSlots(legacy.slice(0, 4))).toEqual(resolveDockSlots(undefined));
    });
  });
});
