// The boxes of the right rail: a card (a titled section), a button (one action) and a plain box (the tab header), built
// as styled rows. paddedCell and visualText strip ANSI and give one tone to what they are handed, so a border, a title
// and a body are separate calls whose results are concatenated here. Every row a helper returns is exactly as wide as
// the box it draws, whatever the text it was given: text that does not fit is cut with an ellipsis, never allowed to
// push a border out of its column.
import { type DashboardTone, lineTone, paddedCell, visualText } from "./dashboard-theme.js";
import {
  BUTTON_LABEL_WIDTH,
  BUTTON_WIDTH,
  CARD_CONTENT_WIDTH,
  CARD_WIDTH,
  RAIL_BODY_WIDTH,
  RAIL_MARGIN,
} from "./rail-metrics.js";
import { plainText, textWidth, truncate, wrap } from "./text.js";

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
  // The MAIN cards' markers: the eye in front of the status card's title, the open and the other areas, a listed item
  // and the arrow of a row that opens something.
  readonly eye: string;
  readonly selected: string;
  readonly unselected: string;
  readonly bullet: string;
  readonly external: string;
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
  eye: "◉",
  selected: "●",
  unselected: "○",
  bullet: "•",
  external: "↗",
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
  eye: "@",
  selected: "*",
  unselected: "o",
  bullet: "-",
  external: "->",
};

export function railGlyphs(ascii: boolean | undefined): RailGlyphs {
  return ascii === true ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

const TITLE_TONE: DashboardTone = "cyan";

// A mark in front of a card's title, in a tone of its own (the status card's eye).
export interface TitleLead {
  readonly text: string;
  readonly tone: DashboardTone;
}

export interface BoxOptions {
  // ASCII borders and markers.
  readonly ascii?: boolean;
  // The box's outer width; a card's by default, a button's for `button`.
  readonly width?: number;
  // The tone of the title; cyan by default.
  readonly titleTone?: DashboardTone;
  // A mark before the title, which goes with it: a title that does not fit takes the mark's room too.
  readonly lead?: TitleLead;
}

// The top edge of a box: `╭─ Title ───╮` (the title in its own tone), or a plain `╭──────╮` when there is none or it
// does not fit.
function topEdge(
  title: string,
  width: number,
  glyphs: RailGlyphs,
  titleTone: DashboardTone = TITLE_TONE,
  lead?: TitleLead,
): string {
  if (width < 2) return "";
  const leadWidth = lead === undefined ? 0 : textWidth(plainText(lead.text)) + 1;
  const room = width - 6 - leadWidth;
  const shown = room >= 1 ? truncate(plainText(title).trim(), room) : "";
  if (shown === "") {
    return visualText(
      `${glyphs.topLeft}${glyphs.horizontal.repeat(width - 2)}${glyphs.topRight}`,
      lineTone("teal"),
      "panel",
    );
  }
  const rest = width - 5 - leadWidth - textWidth(shown);
  return (
    visualText(`${glyphs.topLeft}${glyphs.horizontal} `, lineTone("teal"), "panel") +
    (lead === undefined
      ? ""
      : visualText(plainText(lead.text), lead.tone, "panel") +
        visualText(" ", lineTone("teal"), "panel")) +
    visualText(shown, titleTone, "panel") +
    visualText(` ${glyphs.horizontal.repeat(rest)}${glyphs.topRight}`, lineTone("teal"), "panel")
  );
}

function bottomEdge(width: number, glyphs: RailGlyphs): string {
  if (width < 2) return "";
  return visualText(
    `${glyphs.bottomLeft}${glyphs.horizontal.repeat(width - 2)}${glyphs.bottomRight}`,
    lineTone("teal"),
    "panel",
  );
}

// A row of content between the vertical borders, one padding column on each side. `inner` is already styled and
// exactly `width - 4` columns wide.
function sideRow(inner: string, glyphs: RailGlyphs): string {
  return (
    visualText(`${glyphs.vertical} `, lineTone("teal"), "panel") +
    inner +
    visualText(` ${glyphs.vertical}`, lineTone("teal"), "panel")
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
    topEdge(title, width, glyphs, options.titleTone, options.lead),
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

// One action as a small bordered button: three rows for a label of one row, which is nearly every label. Its label is
// `▸ label`. One that is too long for a row goes on, indented under the first word, on a second row (so the long
// actions of an area read whole) and is cut with an ellipsis only after that.
export function button(label: string, options: BoxOptions = {}): string[] {
  const glyphs = railGlyphs(options.ascii);
  const width = options.width ?? BUTTON_WIDTH;
  const indent = textWidth(glyphs.pointer) + 1;
  const room = width - 4 - indent;
  const lines = room >= 1 ? wrap(plainText(label).trim(), room) : [];
  const [first = "", ...rest] = lines;
  const rows =
    room < 1
      ? [`${glyphs.pointer} ${label}`]
      : [
          `${glyphs.pointer} ${first}`,
          ...(rest.length === 0 ? [] : [`${" ".repeat(indent)}${truncate(rest.join(" "), room)}`]),
        ];
  return boxFrame(
    "",
    rows.map((row) => textRow(row, "text", width - 4)),
    { ...options, width },
  );
}

// A chip is a small bordered box around a short label: three rows tall, a border and one padding column at each side of
// the label (what a button keeps around its own). Chips sit side by side on one row, one column apart.
const CHIP_CHROME = BUTTON_WIDTH - BUTTON_LABEL_WIDTH;
const CHIP_GAP = 1;
// The chip of the range in force, and the one whose dialog is open, wear the selected tone.
const ACTIVE_TONE: DashboardTone = "yellow";

export interface ChipSpec {
  readonly label: string;
  readonly active?: boolean;
}

// The columns a chip takes in the row, counted from the first column of the card's content: `from` is the first column
// of its border and `to` the one after the last (the gap between two chips belongs to neither).
interface ChipCell {
  readonly from: number;
  readonly to: number;
}

export interface ChipRow {
  // The three styled rows, each exactly `width` columns wide.
  readonly rows: string[];
  // One cell for each chip that was drawn.
  readonly cells: ChipCell[];
}

// The width of the label of each chip so that the row fits `room` columns. A label that does not fit is cut with an
// ellipsis, as a button's is: the widest first (the last of equals), a column at a time, down to one column. Chips that
// still do not fit are dropped from the end, so the row never grows.
function fitChipLabels(natural: readonly number[], room: number): number[] {
  const labels = [...natural];
  const total = (): number =>
    labels.reduce((sum, width) => sum + width + CHIP_CHROME, 0) +
    CHIP_GAP * Math.max(0, labels.length - 1);
  while (total() > room) {
    let widest = -1;
    for (const [index, width] of labels.entries()) {
      if (width > 1 && (widest < 0 || width >= (labels[widest] ?? 0))) widest = index;
    }
    if (widest < 0) break;
    labels[widest] = (labels[widest] ?? 1) - 1;
  }
  while (labels.length > 0 && total() > room) labels.pop();
  return labels;
}

// Several actions as chips on one row: three rows of `width` columns (a card's content by default) and the columns each
// chip answers a click in. The chips are as narrow as their labels and left-aligned; what is left of the row is blank.
export function chipRow(
  chips: readonly ChipSpec[],
  options: { readonly ascii?: boolean; readonly width?: number } = {},
): ChipRow {
  const glyphs = railGlyphs(options.ascii);
  const room = options.width ?? CARD_CONTENT_WIDTH;
  const labels = chips.map((chip) => plainText(chip.label).trim());
  const widths = fitChipLabels(
    labels.map((label) => textWidth(label)),
    room,
  );
  const top: string[] = [];
  const middle: string[] = [];
  const bottom: string[] = [];
  const cells: ChipCell[] = [];
  let used = 0;
  for (const [index, labelWidth] of widths.entries()) {
    const chip = chips[index];
    const width = labelWidth + CHIP_CHROME;
    const border = chip?.active === true ? ACTIVE_TONE : lineTone("teal");
    const text = chip?.active === true ? ACTIVE_TONE : "text";
    if (index > 0) {
      const gap = visualText(" ".repeat(CHIP_GAP), "text", "panel");
      top.push(gap);
      middle.push(gap);
      bottom.push(gap);
      used += CHIP_GAP;
    }
    top.push(
      visualText(
        `${glyphs.topLeft}${glyphs.horizontal.repeat(width - 2)}${glyphs.topRight}`,
        border,
        "panel",
      ),
    );
    middle.push(
      visualText(`${glyphs.vertical} `, border, "panel") +
        paddedCell(labels[index] ?? "", labelWidth, text, "panel") +
        visualText(` ${glyphs.vertical}`, border, "panel"),
    );
    bottom.push(
      visualText(
        `${glyphs.bottomLeft}${glyphs.horizontal.repeat(width - 2)}${glyphs.bottomRight}`,
        border,
        "panel",
      ),
    );
    cells.push({ from: used, to: used + width });
    used += width;
  }
  const rest = paddedCell("", room - used, "text", "panel");
  return { rows: [top, middle, bottom].map((parts) => parts.join("") + rest), cells };
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
