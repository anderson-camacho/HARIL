import { colorMode, sequence } from "./dashboard-theme.js";
import { ASCII_GLYPHS, orchestrationGlyphs } from "./orchestration-draw.js";
import { plainText, textWidth, truncate } from "./text.js";

// The factory's visual kit: the exact palette and round boxes of the reference pieces (MIT, ascii-magic-art), kept apart
// from the console's themed palettes so the factory looks the same under each of them. Colors follow the console's own
// rules (truecolor, 256 under PI_TRUE_COLOR=0, plain under NO_COLOR or TERM=dumb). Nothing here paints a background: the
// image a terminal draws shows only behind cells with the default one (tests/unpainted-surfaces.test.ts).

const RESET = "\u001b[0m";

// In the reference's order: a piece's palette keys index this list.
export const FACTORY_TOKENS = {
  text: "#e6edf3",
  muted: "#8b949e",
  green: "#7ee787",
  blue: "#79c0ff",
  orange: "#ffa657",
  red: "#ff7b72",
  purple: "#d2a8ff",
  dim: "#484f58",
  line: "#30363d",
  yellow: "#f2cc60",
  cyan: "#56d4dd",
} as const;

export type FactoryToken = keyof typeof FACTORY_TOKENS;

function rgbOf(token: FactoryToken): readonly [number, number, number] {
  const value = Number.parseInt(FACTORY_TOKENS[token].slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export interface FactoryGlyphs {
  readonly h: string;
  readonly v: string;
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly barOn: string;
  readonly barOff: string;
  readonly dot: string;
  readonly leftRight: string;
  readonly upDown: string;
}

export const UNICODE_FACTORY_GLYPHS: FactoryGlyphs = {
  h: "─",
  v: "│",
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  barOn: "█",
  barOff: "░",
  dot: "●",
  leftRight: "←/→",
  upDown: "↑/↓",
};

export const ASCII_FACTORY_GLYPHS: FactoryGlyphs = {
  h: "-",
  v: "|",
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  barOn: "#",
  barOff: "-",
  dot: "*",
  leftRight: "Left/Right",
  upDown: "Up/Down",
};

// The same choice as the rest of the console: HARIL_CONSOLE_ASCII selects the ASCII set.
export function factoryGlyphs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FactoryGlyphs {
  return orchestrationGlyphs(env) === ASCII_GLYPHS ? ASCII_FACTORY_GLYPHS : UNICODE_FACTORY_GLYPHS;
}

export function factoryText(text: string, token: FactoryToken): string {
  const safe = plainText(text);
  const mode = colorMode();
  if (safe === "" || !mode.enabled) return safe;
  return `${sequence(rgbOf(token), false, mode.trueColor)}${safe}${RESET}`;
}

// `╭─ Title ──── right ─╮`, exactly `width` columns. The right part gives way first, then the title is cut.
export function factoryFrameTop(
  width: number,
  title: string,
  right: string,
  g: FactoryGlyphs,
): string {
  if (width <= 0) return "";
  if (width === 1) return factoryText(g.topLeft, "line");
  const inside = width - 2;
  const safeTitle = plainText(title);
  const safeRight = plainText(right);
  // The title's own frame: "─ " before it and " " after it.
  const titleRoom = inside - 3;
  if (titleRoom < 1) return factoryText(`${g.topLeft}${g.h.repeat(inside)}${g.topRight}`, "line");
  const shownTitle = truncate(safeTitle, titleRoom);
  const leftWidth = 3 + textWidth(shownTitle);
  // The right part's own frame: " " before it and " ─" after it.
  const rightWidth = safeRight === "" ? 0 : textWidth(safeRight) + 3;
  const showRight = rightWidth > 0 && leftWidth + rightWidth <= inside;
  const fill = inside - leftWidth - (showRight ? rightWidth : 0);
  return [
    factoryText(`${g.topLeft}${g.h} `, "line"),
    factoryText(shownTitle, "text"),
    factoryText(` ${g.h.repeat(fill)}`, "line"),
    showRight ? factoryText(" ", "line") : "",
    showRight ? factoryText(safeRight, "muted") : "",
    showRight ? factoryText(` ${g.h}`, "line") : "",
    factoryText(g.topRight, "line"),
  ].join("");
}

export function factoryFrameBottom(width: number, g: FactoryGlyphs): string {
  if (width <= 0) return "";
  if (width === 1) return factoryText(g.bottomLeft, "line");
  return factoryText(`${g.bottomLeft}${g.h.repeat(width - 2)}${g.bottomRight}`, "line");
}

export interface FactorySeg<Target> {
  readonly text: string;
  readonly token: FactoryToken;
  readonly target?: Target;
}

export interface FactoryRow<Target> {
  readonly text: string;
  readonly hits: { readonly start: number; readonly end: number; readonly target: Target }[];
}

export function factorySegsWidth<Target>(segs: readonly FactorySeg<Target>[]): number {
  return segs.reduce((sum, seg) => sum + textWidth(plainText(seg.text)), 0);
}

// Segments on one line of exactly `width` columns: cut when they do not fit, padded with unpainted spaces when they do.
export function factoryCompose<Target>(
  segs: readonly FactorySeg<Target>[],
  width: number,
): FactoryRow<Target> {
  if (width <= 0) return { text: "", hits: [] };
  let text = "";
  let used = 0;
  const hits: { start: number; end: number; target: Target }[] = [];
  for (const seg of segs) {
    const left = width - used;
    if (left <= 0) break;
    const shown = truncate(plainText(seg.text), left);
    const size = textWidth(shown);
    if (size === 0) continue;
    text += factoryText(shown, seg.token);
    if (seg.target !== undefined) hits.push({ start: used, end: used + size, target: seg.target });
    used += size;
  }
  return { text: `${text}${" ".repeat(width - used)}`, hits };
}

// One row between the frame's sides. Too narrow for sides, it is the row alone.
export function factoryBoxRow<Target>(
  segs: readonly FactorySeg<Target>[],
  width: number,
  g: FactoryGlyphs,
): FactoryRow<Target> {
  if (width < 3) return factoryCompose(segs, width);
  const row = factoryCompose(segs, width - 2);
  const side = factoryText(g.v, "line");
  return {
    text: `${side}${row.text}${side}`,
    hits: row.hits.map((hit) => ({ ...hit, start: hit.start + 1, end: hit.end + 1 })),
  };
}

export function factoryProgressBar(
  ratio: number,
  cells: number,
  g: FactoryGlyphs,
  token: FactoryToken = "green",
): string {
  const size = Math.max(0, Math.floor(cells));
  const clamped = Number.isNaN(ratio) ? 0 : Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * size);
  return `${factoryText(g.barOn.repeat(filled), token)}${factoryText(g.barOff.repeat(size - filled), "dim")}`;
}

export function factoryStatusDot(token: FactoryToken, g: FactoryGlyphs): string {
  return factoryText(g.dot, token);
}
