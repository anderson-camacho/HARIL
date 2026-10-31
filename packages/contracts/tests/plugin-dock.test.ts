import { describe, expect, it } from "vitest";
import {
  DOCK_SLOTS,
  dockPreferenceErrors,
  dockSlotExists,
  resolveDockSlots,
} from "../src/plugin-dock.js";

const current = [
  { id: "main", visible: true },
  { id: "memory", visible: false },
  { id: "docs", visible: true },
  { id: "activity", visible: true },
  { id: "actions", visible: true },
];

// The list the release before ACT wrote: MAIN, MEM and DOCS.
const threeSlots = [
  { id: "main", visible: true },
  { id: "memory", visible: false },
  { id: "docs", visible: true },
];

// The list the previous release wrote: MAIN, MEM, DOCS and ACT, before the ACC slot existed.
const fourCurrent = [
  { id: "main", visible: true },
  { id: "memory", visible: false },
  { id: "docs", visible: true },
  { id: "activity", visible: true },
];

// Releases before the MAIN/MEM/DOCS dock stored GIT, YT, MEM and THEME. MAIN did not exist and the other three
// are gone, so a file written back then keeps only what still exists: the memory entry, in its place.
const fourSlots = [
  { id: "git", visible: true },
  { id: "youtube", visible: false },
  { id: "memory", visible: false },
  { id: "themes", visible: true },
];

// Releases before the TREE slot was removed stored five entries, the first being the retired "explorer".
const withExplorer = [{ id: "explorer", visible: true }, ...fourSlots];

const defaults = [
  { id: "main", visible: true },
  { id: "memory", visible: true },
  { id: "docs", visible: true },
  { id: "activity", visible: true },
  { id: "actions", visible: true },
];

describe("dock slot preferences", () => {
  it("offers MAIN, MEM, DOCS, ACT and ACC and no longer knows the retired slots", () => {
    expect(DOCK_SLOTS.map((slot) => slot.id)).toEqual([
      "main",
      "memory",
      "docs",
      "activity",
      "actions",
    ]);
    expect(DOCK_SLOTS.find((slot) => slot.id === "activity")?.label).toBe("Actividad");
    expect(DOCK_SLOTS.find((slot) => slot.id === "actions")?.label).toBe("Acciones");
    expect(dockSlotExists("activity")).toBe(true);
    expect(dockSlotExists("actions")).toBe(true);
    for (const retired of ["explorer", "git", "youtube", "themes"]) {
      expect(dockSlotExists(retired)).toBe(false);
    }
    expect(dockSlotExists("main")).toBe(true);
    expect(dockSlotExists("docs")).toBe(true);
  });

  it("accepts the five-entry list as it is", () => {
    expect(dockPreferenceErrors(current)).toEqual([]);
    expect(resolveDockSlots(current)).toEqual(current);
  });

  it("keeps validating the four-entry list of the previous release: ACC is appended, visible", () => {
    expect(dockPreferenceErrors(fourCurrent)).toEqual([]);
    expect(resolveDockSlots(fourCurrent)).toEqual(current);
    // It is not written back by a read: the stored list is untouched.
    const stored = fourCurrent.map((slot) => ({ ...slot }));
    resolveDockSlots(stored);
    expect(stored).toEqual(fourCurrent);
  });

  it("keeps validating the three-entry list of the release before: ACT and ACC are appended, visible", () => {
    expect(dockPreferenceErrors(threeSlots)).toEqual([]);
    expect(resolveDockSlots(threeSlots)).toEqual(current);
    // Where the user put the others stays; ACT and ACC go after them.
    const reordered = [threeSlots[0], threeSlots[2], threeSlots[1]];
    expect(resolveDockSlots(reordered).map((slot) => slot.id)).toEqual([
      "main",
      "docs",
      "memory",
      "activity",
      "actions",
    ]);
    // It is not written back by a read: the stored list is untouched.
    const stored = threeSlots.map((slot) => ({ ...slot }));
    resolveDockSlots(stored);
    expect(stored).toEqual(threeSlots);
  });

  it("keeps a hidden ACT hidden and its place in the list", () => {
    const stored = [
      { id: "main", visible: true },
      { id: "activity", visible: false },
      { id: "docs", visible: true },
      { id: "memory", visible: true },
      { id: "actions", visible: true },
    ];
    expect(dockPreferenceErrors(stored)).toEqual([]);
    expect(resolveDockSlots(stored)).toEqual(stored);
  });

  it("keeps a hidden ACC hidden and a moved ACC where the user put it", () => {
    const stored = [
      { id: "main", visible: true },
      { id: "actions", visible: false },
      { id: "memory", visible: true },
      { id: "docs", visible: true },
      { id: "activity", visible: true },
    ];
    expect(dockPreferenceErrors(stored)).toEqual([]);
    expect(resolveDockSlots(stored)).toEqual(stored);
    const moved = [
      { id: "main", visible: true },
      { id: "actions", visible: true },
      { id: "docs", visible: true },
    ];
    expect(resolveDockSlots(moved).map((slot) => slot.id)).toEqual([
      "main",
      "actions",
      "docs",
      "memory",
      "activity",
    ]);
  });

  it("defaults to every slot visible, with main first, when nothing is stored", () => {
    expect(resolveDockSlots(undefined)).toEqual(defaults);
  });

  describe("main is always the first slot and always visible", () => {
    it("rejects a stored main that is hidden, at the index it has in the file", () => {
      const hidden = [
        { id: "memory", visible: true },
        { id: "main", visible: false },
        { id: "docs", visible: true },
      ];
      expect(dockPreferenceErrors(hidden)).toEqual([
        "/ui/plugins/1/visible: the main slot cannot be hidden",
      ]);
      expect(resolveDockSlots(hidden)).toEqual(defaults);
    });

    it("puts main first when it is stored elsewhere, and keeps the order of the rest", () => {
      const stored = [
        { id: "docs", visible: true },
        { id: "main", visible: true },
        { id: "memory", visible: false },
      ];
      expect(dockPreferenceErrors(stored)).toEqual([]);
      expect(resolveDockSlots(stored)).toEqual([
        { id: "main", visible: true },
        { id: "docs", visible: true },
        { id: "memory", visible: false },
        { id: "activity", visible: true },
        { id: "actions", visible: true },
      ]);
    });
  });

  describe("a stored list that lacks a current slot", () => {
    it("is valid: the missing slots are filled in as visible, main first", () => {
      expect(dockPreferenceErrors([])).toEqual([]);
      expect(resolveDockSlots([])).toEqual(defaults);
      expect(dockPreferenceErrors([{ id: "docs", visible: false }])).toEqual([]);
      expect(resolveDockSlots([{ id: "docs", visible: false }])).toEqual([
        { id: "main", visible: true },
        { id: "docs", visible: false },
        { id: "memory", visible: true },
        { id: "activity", visible: true },
        { id: "actions", visible: true },
      ]);
    });
  });

  describe("a stored list written before MAIN, MEM and DOCS", () => {
    it("is valid: git, youtube, themes and explorer are retired and ignored", () => {
      expect(dockPreferenceErrors(fourSlots)).toEqual([]);
      expect(dockPreferenceErrors(withExplorer)).toEqual([]);
    });

    it("resolves to every slot of the registry, keeping the visibility and the place of memory", () => {
      expect(resolveDockSlots(fourSlots)).toEqual([
        { id: "main", visible: true },
        { id: "memory", visible: false },
        { id: "docs", visible: true },
        { id: "activity", visible: true },
        { id: "actions", visible: true },
      ]);
      expect(resolveDockSlots(withExplorer)).toEqual(resolveDockSlots(fourSlots));
      const reordered = [fourSlots[3], fourSlots[2], fourSlots[0], fourSlots[1]];
      expect(resolveDockSlots(reordered).map((slot) => slot.id)).toEqual([
        "main",
        "memory",
        "docs",
        "activity",
        "actions",
      ]);
    });

    it("does not mutate the stored value, so the next write is what heals the file", () => {
      const stored = withExplorer.map((slot) => ({ ...slot }));
      resolveDockSlots(stored);
      expect(stored).toEqual(withExplorer);
    });

    it("still reports real problems, at the index they have in the stored list", () => {
      const duplicated = [...withExplorer, { id: "memory", visible: true }];
      expect(dockPreferenceErrors(duplicated)).toEqual([
        "/ui/plugins/5/id: duplicate dock slot memory",
      ]);
      const unknown = [withExplorer[0], { id: "mystery", visible: true }, ...withExplorer.slice(1)];
      expect(dockPreferenceErrors(unknown)).toEqual(["/ui/plugins/1/id: unknown dock slot"]);
      const wrongType = [withExplorer[0], { id: "memory", visible: "yes" }];
      expect(dockPreferenceErrors(wrongType)).toEqual(["/ui/plugins/1/visible: must be boolean"]);
      const extraKey = [{ id: "docs", visible: true, color: "red" }];
      expect(dockPreferenceErrors(extraKey)).toEqual(["/ui/plugins/0/color: unknown key"]);
      expect(dockPreferenceErrors(["main"])).toEqual([
        "/ui/plugins/0: must be an object with id and visible",
      ]);
      expect(dockPreferenceErrors({ id: "main" })).toEqual([
        "/ui/plugins: must be an array of dock slots",
      ]);
    });
  });
});
