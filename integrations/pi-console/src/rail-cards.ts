// The boxes of the right rail: a card (a titled section), a button (one action) and a plain box (the tab header), built
// as styled rows. paddedCell and visualText strip ANSI and give one tone to what they are handed, so a border, a title
// and a body are separate calls whose results are concatenated here. Every row a helper returns is exactly as wide as
// the box it draws, whatever the text it was given: text that does not fit is cut with an ellipsis, never allowed to
// push a border out of its column.
import { type DashboardTone, paddedCell, visualText } from "./dashboard-theme.js";
import {
  BUTTON_WIDTH,
  CARD_CONTENT_WIDTH,
  CARD_WIDTH,
  RAIL_BODY_WIDTH,
  RAIL_MARGIN,
} from "./rail-metrics.js";
import { plainText, textWidth, truncate } from "./text.js";

// The glyphs a row of the rail draws: rounded corners and the rail's own markers, or their ASCII forms for a terminal
// font without them (HARIL_CONSOLE_ASCII). The middle dot and the ellipsis stay in both, as in the rest of the console.
export interface RailGlyphs {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
  // In front of a button's label.
  readonly pointer: string;
  // The space header's markers: its dock open, closed, and the dock that sits beside the chat.
  readonly open: string;
  readonly closed: string;
  readonly docked: string;
}

const UNICODE_GLYPHS: RailGlyphs = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  pointer: "▸",
  open: "▼",
  closed: "▶",
  docked: "▣",
};

const ASCII_GLYPHS: RailGlyphs = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
  pointer: ">",
  open: "v",
  closed: ">",
  docked: "#",
};

export function railGlyphs(ascii: boolean | undefined): RailGlyphs {
  return ascii === true ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

const BORDER_TONE: DashboardTone = "teal";
const TITLE_TONE: DashboardTone = "cyan";

export interface BoxOptions {
  // ASCII borders and markers.
  readonly ascii?: boolean;
  // The box's outer width; a card's by default, a button's for `button`.
  readonly width?: number;
}

// The top edge of a box: `╭─ Title ───╮` (the title in its own tone), or a plain `╭──────╮` when there is none or it
// does not fit.
function topEdge(title: string, width: number, glyphs: RailGlyphs): string {
  if (width < 2) return "";
  const room = width - 6;
  const shown = room >= 1 ? truncate(plainText(title).trim(), room) : "";
  if (shown === "") {
    return visualText(
      `${glyphs.topLeft}${glyphs.horizontal.repeat(width - 2)}${glyphs.topRight}`,
      BORDER_TONE,
      "panel",
    );
  }
  const rest = width - 5 - textWidth(shown);
  return (
    visualText(`${glyphs.topLeft}${glyphs.horizontal} `, BORDER_TONE, "panel") +
    visualText(shown, TITLE_TONE, "panel") +
    visualText(` ${glyphs.horizontal.repeat(rest)}${glyphs.topRight}`, BORDER_TONE, "panel")
  );
}

function bottomEdge(width: number, glyphs: RailGlyphs): string {
  if (width < 2) return "";
  return visualText(
    `${glyphs.bottomLeft}${glyphs.horizontal.repeat(width - 2)}${glyphs.bottomRight}`,
    BORDER_TONE,
    "panel",
  );
}

// A row of content between the vertical borders, one padding column on each side. `inner` is already styled and
// exactly `width - 4` columns wide.
function sideRow(inner: string, glyphs: RailGlyphs): string {
  return (
    visualText(`${glyphs.vertical} `, BORDER_TONE, "panel") +
    inner +
    visualText(` ${glyphs.vertical}`, BORDER_TONE, "panel")
  );
}

// A row of plain text fitted to `width` columns: cut with an ellipsis or padded, in one tone.
export function textRow(
  text: string,
  tone: DashboardTone = "text",
  width = CARD_CONTENT_WIDTH,
): string {
  return paddedCell(text, width, tone, "panel");
}

// A box around rows that are already styled and `width - 4` columns wide, with its title in the top border.
export function boxFrame(
  title: string,
  inner: readonly string[],
  options: BoxOptions = {},
): string[] {
  const glyphs = railGlyphs(options.ascii);
  const width = options.width ?? CARD_WIDTH;
  return [
    topEdge(title, width, glyphs),
    ...inner.map((row) => sideRow(row, glyphs)),
    bottomEdge(width, glyphs),
  ];
}

// A titled section: `╭─ Title ───╮`, a row for each text, `╰────────╯`.
export function card(title: string, rows: readonly string[], options: BoxOptions = {}): string[] {
  const content = (options.width ?? CARD_WIDTH) - 4;
  return boxFrame(
    title,
    rows.map((row) => textRow(row, "text", content)),
    options,
  );
}

// One action as a small bordered button of three rows. Its label is `▸ label`, cut when it is too long.
export function button(label: string, options: BoxOptions = {}): string[] {
  const glyphs = railGlyphs(options.ascii);
  const width = options.width ?? BUTTON_WIDTH;
  return boxFrame("", [textRow(`${glyphs.pointer} ${label}`, "text", width - 4)], {
    ...options,
    width,
  });
}

// A row of a titleless box: text and the tone it is drawn in (the header's selected row is yellow).
export interface BoxRow {
  readonly text: string;
  readonly tone?: DashboardTone;
}

// A box without a title (the tab header): a row for each entry.
export function plainBox(rows: readonly BoxRow[], options: BoxOptions = {}): string[] {
  const content = (options.width ?? CARD_WIDTH) - 4;
  return boxFrame(
    "",
    rows.map((row) => textRow(row.text, row.tone ?? "text", content)),
    options,
  );
}

// A card's row as a row of the rail: the margin on each side, in the panel's background.
export function inset(row: string): string {
  const margin = visualText(" ".repeat(RAIL_MARGIN), "text", "panel");
  return `${margin}${row}${margin}`;
}

// A row of the rail with nothing in it.
export function blankRow(): string {
  return paddedCell("", RAIL_BODY_WIDTH, "text", "panel");
}
