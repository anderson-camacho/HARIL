import { plainText, textWidth, truncate } from "./text.js";

export type DashboardTone = "cyan" | "teal" | "yellow" | "text" | "muted" | "dim" | "error";

const RESET = "\u001b[0m";
export const HARIL_PALETTES = ["matrix", "violet", "rose", "amber", "obsidian"] as const;
export type HarilPalette = (typeof HARIL_PALETTES)[number];
type Color = readonly [number, number, number];
type BackgroundTone = "base" | "panel" | "selected";
interface Palette {
  readonly foreground: Record<DashboardTone, Color>;
  readonly background: Record<BackgroundTone, Color>;
}

const PALETTES: Record<HarilPalette, Palette> = {
  matrix: {
    foreground: {
      cyan: [38, 238, 104],
      teal: [119, 255, 165],
      yellow: [231, 207, 117],
      text: [198, 244, 210],
      muted: [118, 151, 129],
      dim: [75, 112, 88],
      error: [255, 101, 118],
    },
    background: { base: [0, 0, 0], panel: [6, 20, 10], selected: [23, 65, 38] },
  },
  violet: {
    foreground: {
      cyan: [191, 163, 240],
      teal: [231, 171, 216],
      yellow: [241, 197, 153],
      text: [224, 213, 237],
      muted: [159, 142, 172],
      dim: [105, 88, 126],
      error: [255, 96, 116],
    },
    background: { base: [12, 9, 19], panel: [23, 17, 33], selected: [64, 39, 77] },
  },
  rose: {
    foreground: {
      cyan: [236, 164, 202],
      teal: [204, 173, 239],
      yellow: [243, 196, 157],
      text: [238, 218, 229],
      muted: [171, 142, 161],
      dim: [115, 81, 106],
      error: [255, 94, 114],
    },
    background: { base: [19, 10, 17], panel: [32, 19, 29], selected: [76, 39, 59] },
  },
  amber: {
    foreground: {
      cyan: [233, 178, 126],
      teal: [224, 177, 164],
      yellow: [243, 208, 145],
      text: [237, 220, 206],
      muted: [174, 145, 125],
      dim: [117, 93, 75],
      error: [253, 104, 111],
    },
    background: { base: [18, 12, 9], panel: [32, 22, 16], selected: [75, 49, 25] },
  },
  obsidian: {
    foreground: {
      cyan: [173, 177, 233],
      teal: [187, 164, 219],
      yellow: [227, 192, 139],
      text: [217, 215, 224],
      muted: [147, 146, 164],
      dim: [98, 99, 119],
      error: [255, 93, 106],
    },
    background: { base: [5, 6, 9], panel: [12, 13, 19], selected: [40, 33, 53] },
  },
};

let activePalette: HarilPalette = "matrix";

export function setHarilPalette(candidate: unknown): HarilPalette {
  activePalette = HARIL_PALETTES.find((item) => item === candidate) ?? "matrix";
  return activePalette;
}

export function getHarilPalette(): HarilPalette {
  return activePalette;
}

// A one-cell AI eye. Higher reasoning levels are signaled red without resizing the header.
export function aiEyeTone(level: string | undefined): DashboardTone {
  return level !== undefined && ["high", "xhigh", "max", "ultra"].includes(level)
    ? "error"
    : level === undefined || level === "off"
      ? "muted"
      : "teal";
}

function colorMode(): { readonly enabled: boolean; readonly trueColor: boolean } {
  const env = process.env;
  const enabled = env.NO_COLOR === undefined && env.TERM?.toLowerCase() !== "dumb";
  return { enabled, trueColor: env.PI_TRUE_COLOR !== "0" };
}

function sequence(
  rgb: readonly [number, number, number],
  background: boolean,
  trueColor: boolean,
): string {
  const [red, green, blue] = rgb;
  if (trueColor) return `\u001b[${background ? 48 : 38};2;${red};${green};${blue}m`;
  const index =
    Math.round((red / 255) * 5) * 36 +
    Math.round((green / 255) * 5) * 6 +
    Math.round((blue / 255) * 5) +
    16;
  return `\u001b[${background ? 48 : 38};5;${index}m`;
}

export function visualText(
  text: string,
  tone: DashboardTone,
  background?: "base" | "panel" | "selected",
): string {
  const safe = plainText(text);
  const mode = colorMode();
  if (!mode.enabled) return safe;
  const palette = PALETTES[activePalette];
  const fg = sequence(palette.foreground[tone], false, mode.trueColor);
  const bg =
    background === undefined ? "" : sequence(palette.background[background], true, mode.trueColor);
  return `${bg}${fg}${safe}${RESET}`;
}

export function paddedCell(
  text: string,
  width: number,
  tone: DashboardTone = "text",
  background: BackgroundTone = "base",
): string {
  if (width <= 0) return "";
  const safe = plainText(text);
  const fitted = truncate(safe, width);
  return visualText(
    `${fitted}${" ".repeat(Math.max(0, width - textWidth(fitted)))}`,
    tone,
    background,
  );
}

export function frameGlyph(text: string): string {
  return visualText(text, "cyan", "base");
}
