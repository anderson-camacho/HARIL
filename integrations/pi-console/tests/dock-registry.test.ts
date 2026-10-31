import { describe, expect, it } from "vitest";
// The two registries are twins: the console bundles into one file and cannot import the contracts package, so the
// only thing that keeps them equal is this comparison.
import { DOCK_SLOTS } from "../../../packages/contracts/src/plugin-dock.js";
import { DOCK_LABELS, readDockSlots } from "../src/dock-registry.js";

describe("the dock registry of the console", () => {
  it("offers the same slots, in the same order, as the contracts the CLI validates with", () => {
    expect(DOCK_LABELS.map((slot) => slot.id)).toEqual(DOCK_SLOTS.map((slot) => slot.id));
    expect(DOCK_LABELS.map((slot) => slot.label)).toEqual(DOCK_SLOTS.map((slot) => slot.label));
  });

  it("opens on MAIN: it is the first slot", () => {
    expect(DOCK_LABELS[0].id).toBe("main");
    expect(DOCK_LABELS.map((slot) => slot.tab)).toEqual(["MAIN", "MEM", "DOCS", "ACT"]);
  });

  describe("readDockSlots", () => {
    const ids = (raw: unknown) => readDockSlots({ value: raw }).map((slot) => slot.id);

    it("defaults to every slot visible, MAIN first, when nothing usable is stored", () => {
      const all = [
        { id: "main", visible: true },
        { id: "memory", visible: true },
        { id: "docs", visible: true },
        { id: "activity", visible: true },
      ];
      expect(readDockSlots(undefined)).toEqual(all);
      expect(readDockSlots({ value: "nope" })).toEqual(all);
      expect(readDockSlots({ value: [] })).toEqual(all);
    });

    it("keeps MAIN first and visible, whatever the stored list says", () => {
      const slots = readDockSlots({
        value: [
          { id: "docs", visible: true },
          { id: "main", visible: false },
          { id: "memory", visible: false },
        ],
      });
      expect(slots).toEqual([
        { id: "main", visible: true },
        { id: "docs", visible: true },
        { id: "memory", visible: false },
        { id: "activity", visible: true },
      ]);
    });

    it("appends ACT, visible, to the three-entry list of the previous release and keeps the rest", () => {
      expect(
        readDockSlots({
          value: [
            { id: "main", visible: true },
            { id: "docs", visible: false },
            { id: "memory", visible: true },
          ],
        }),
      ).toEqual([
        { id: "main", visible: true },
        { id: "docs", visible: false },
        { id: "memory", visible: true },
        { id: "activity", visible: true },
      ]);
    });

    it("keeps a stored ACT where the user put it, hidden or not", () => {
      expect(
        readDockSlots({
          value: [
            { id: "main", visible: true },
            { id: "activity", visible: false },
            { id: "memory", visible: true },
            { id: "docs", visible: true },
          ],
        }),
      ).toEqual([
        { id: "main", visible: true },
        { id: "activity", visible: false },
        { id: "memory", visible: true },
        { id: "docs", visible: true },
      ]);
    });

    it("ignores the slots that older releases stored and that are gone, keeping what is left", () => {
      expect(
        readDockSlots({
          value: [
            { id: "explorer", visible: true },
            { id: "git", visible: true },
            { id: "youtube", visible: false },
            { id: "memory", visible: false },
            { id: "themes", visible: true },
          ],
        }),
      ).toEqual([
        { id: "main", visible: true },
        { id: "memory", visible: false },
        { id: "docs", visible: true },
        { id: "activity", visible: true },
      ]);
    });

    it("drops duplicates and malformed entries instead of letting them reach the dock", () => {
      expect(
        ids([
          { id: "memory", visible: true },
          { id: "memory", visible: false },
          { id: "docs", visible: "yes" },
          null,
          "main",
          { id: "untrusted", visible: false },
        ]),
      ).toEqual(["main", "memory", "docs", "activity"]);
    });
  });
});
