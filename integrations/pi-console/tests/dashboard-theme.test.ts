import { describe, expect, it } from "vitest";
import {
  aiEyeTone,
  getHarilPalette,
  HARIL_PALETTES,
  setHarilPalette,
  visualText,
} from "../src/dashboard-theme.js";

describe("pastel HARIL palettes and compact AI eye", () => {
  it("supports four soft palettes and falls back safely to violet", () => {
    expect(HARIL_PALETTES).toEqual(["violet", "rose", "amber", "obsidian"]);
    const previousColor = process.env.NO_COLOR;
    const previousTerm = process.env.TERM;
    try {
      delete process.env.NO_COLOR;
      process.env.TERM = "xterm-256color";
      setHarilPalette("violet");
      const violet = visualText("HARIL", "cyan", "panel");
      setHarilPalette("rose");
      const rose = visualText("HARIL", "cyan", "panel");
      expect(violet).not.toBe(rose);
      expect(setHarilPalette("external-code")).toBe("violet");
      expect(getHarilPalette()).toBe("violet");
    } finally {
      setHarilPalette("violet");
      if (previousColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousColor;
      if (previousTerm === undefined) delete process.env.TERM;
      else process.env.TERM = previousTerm;
    }
  });

  it("lights the one-cell eye red for high reasoning and stays muted when inactive", () => {
    for (const level of ["high", "xhigh", "max", "ultra"]) {
      expect(aiEyeTone(level)).toBe("error");
    }
    expect(aiEyeTone("medium")).toBe("teal");
    expect(aiEyeTone("off")).toBe("muted");
    expect(aiEyeTone(undefined)).toBe("muted");
  });
});
