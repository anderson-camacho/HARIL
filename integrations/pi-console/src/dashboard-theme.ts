import { plainText, textWidth, truncate } from "./text.js";

export type DashboardTone = "cyan" | "teal" | "yellow" | "text" | "muted" | "dim" | "error";

const RESET = "\u001b[0m";
const FOREGROUND: Record<DashboardTone, readonly [number, number, number]> = {
  cyan: [67, 230, 230],
  teal: [30, 190, 169],
  yellow: [247, 209, 76],
  text: [190, 216, 216],
  muted: [111, 153, 157],
  dim: [55, 97, 103],
  error: [255, 111, 105],
};
const BACKGROUND: Record<"base" | "panel" | "selected", readonly [number, number, number]> = {
  base: [5, 14, 20],
  panel: [9, 25, 31],
  selected: [78, 66, 24],
};

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
  const fg = sequence(FOREGROUND[tone], false, mode.trueColor);
  const bg = background === undefined ? "" : sequence(BACKGROUND[background], true, mode.trueColor);
  return `${bg}${fg}${safe}${RESET}`;
}

export function paddedCell(
  text: string,
  width: number,
  tone: DashboardTone = "text",
  background: "base" | "panel" | "selected" = "base",
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
