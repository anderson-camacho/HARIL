import { describe, expect, it } from "vitest";
import {
  aiEyeTone,
  getHarilPalette,
  HARIL_PALETTES,
  setHarilPalette,
  visualText,
} from "../src/dashboard-theme.js";

describe("Matrix default and optional pastel HARIL palettes with compact AI eye", () => {
  it("defaults to Matrix and keeps four optional soft palettes", () => {
    expect(HARIL_PALETTES).toEqual(["matrix", "violet", "rose", "amber", "obsidian"]);
    const previousColor = process.env.NO_COLOR;
    const previousTerm = process.env.TERM;
    try {
      delete process.env.NO_COLOR;
      process.env.TERM = "xterm-256color";
      setHarilPalette("matrix");
      const matrix = visualText("HARIL", "cyan", "panel");
      setHarilPalette("rose");
      const rose = visualText("HARIL", "cyan", "panel");
      expect(matrix).not.toBe(rose);
      expect(matrix).toContain("38;2;38;238;104m");
      expect(setHarilPalette("external-code")).toBe("matrix");
      expect(getHarilPalette()).toBe("matrix");
    } finally {
      setHarilPalette("matrix");
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
