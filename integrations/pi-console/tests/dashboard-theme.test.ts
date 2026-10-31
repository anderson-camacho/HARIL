import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aiEyeTone,
  frameGlyph,
  getHarilPalette,
  HARIL_PALETTES,
  lineTone,
  setHarilPalette,
  visualText,
} from "../src/dashboard-theme.js";

type Rgb = readonly [number, number, number];

const saved = { noColor: process.env.NO_COLOR, term: process.env.TERM };

beforeEach(() => {
  delete process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
});

afterEach(() => {
  setHarilPalette("future");
  if (saved.noColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = saved.noColor;
  if (saved.term === undefined) delete process.env.TERM;
  else process.env.TERM = saved.term;
});

function foreground(painted: string): Rgb {
  const match = /38;2;(\d+);(\d+);(\d+)m/.exec(painted);
  if (match === null) throw new Error("no truecolor foreground");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

describe("Future default and optional HARIL palettes with compact AI eye", () => {
  it("defaults to Future and keeps Matrix and the soft palettes selectable", () => {
    expect(HARIL_PALETTES).toEqual(["future", "matrix", "violet", "rose", "amber", "obsidian"]);
    expect(getHarilPalette()).toBe("future");
    setHarilPalette("matrix");
    const matrix = visualText("HARIL", "cyan", "panel");
    expect(matrix).toContain("38;2;38;238;104m");
    expect(getHarilPalette()).toBe("matrix");
    setHarilPalette("rose");
    expect(visualText("HARIL", "cyan", "panel")).not.toBe(matrix);
    expect(setHarilPalette("external-code")).toBe("future");
    expect(getHarilPalette()).toBe("future");
  });

  it("paints Future blue without a background, except on the selected surface", () => {
    setHarilPalette("future");
    // The terminal's own background shows through base and panel.
    expect(visualText("x", "cyan", "base")).not.toContain("48;2;");
    expect(visualText("x", "cyan", "panel")).not.toContain("48;2;");
    expect(visualText("x", "cyan", "selected")).toContain("48;2;22;54;92m");
    expect(foreground(visualText("x", "cyan"))).toEqual([94, 194, 255]);
    expect(foreground(visualText("x", "teal"))).toEqual([125, 248, 213]);
    expect(foreground(visualText("x", "text"))).toEqual([196, 233, 255]);
  });

  it("keeps Future's muted text readable on its background", () => {
    setHarilPalette("future");
    expect(contrast(foreground(visualText("x", "muted")), [7, 23, 44])).toBeGreaterThanOrEqual(4.5);
  });

  it("draws Future's lines orange, in two strengths, apart from its warning amber", () => {
    setHarilPalette("future");
    expect(foreground(visualText("─", lineTone("cyan")))).toEqual([184, 110, 46]);
    expect(foreground(visualText("─", lineTone("teal", "accent")))).toEqual([255, 159, 69]);
    expect(foreground(frameGlyph("│"))).toEqual([184, 110, 46]);
    expect(foreground(visualText("!", "yellow"))).not.toEqual([255, 159, 69]);
    expect(foreground(visualText("!", "yellow"))).not.toEqual([184, 110, 46]);
  });

  it("leaves the lines of every other palette in the tone they already had", () => {
    for (const palette of HARIL_PALETTES.filter((name) => name !== "future")) {
      setHarilPalette(palette);
      for (const legacy of ["cyan", "teal", "muted", "dim"] as const) {
        expect(lineTone(legacy)).toBe(legacy);
        expect(lineTone(legacy, "accent")).toBe(legacy);
      }
      expect(frameGlyph("│")).toBe(visualText("│", "cyan", "base"));
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
