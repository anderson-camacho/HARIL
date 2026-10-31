// The MAIN tab of the native right rail as cards: a status card, the areas and the sections that open and close, each a
// rounded box with its title in the top border (rail-cards.ts draws the box). The tab declares its cards as data
// (MainCard) and this module draws them with the hit a click on each row runs, aligned with the rows: a click is
// located by its row only, so every row of a wrapped text shares the hit of the text.
//
// A card that opens and closes carries its toggle on the title row, the top border. Closed, it is drawn as a box with
// nothing in it: its top border (the one that is clicked, with the arrow `▶` in the title) over its bottom border. That
// keeps it as much a card as the open ones, and two rows tall instead of a title floating without a box.
import { type DashboardTone, paddedCell } from "./dashboard-theme.js";
import { boxFrame, inset, railGlyphs, type TitleLead, textRow } from "./rail-cards.js";
import { CARD_GAP, RAIL_MARGIN } from "./rail-metrics.js";
import { plainText, textWidth, truncate, wrap } from "./text.js";

// A row of a card. `text` goes after `prefix` ("! " before a warning); a text that is too long for one row goes on, up
// to `rows` rows, the next ones indented under the text (not under the prefix), and the last of them is cut with an
// ellipsis. Without `rows` a text that does not fit is cut at the end of its row, which keeps the label in front of a
// value (`Estoy en: C:\Users\…`) whole.
export interface MainRow<Hit> {
  readonly text: string;
  readonly prefix?: string;
  readonly tone?: DashboardTone;
  readonly hit?: Hit;
  readonly rows?: number;
}

export interface MainCard<Hit> {
  readonly title: string;
  readonly titleTone?: DashboardTone;
  readonly lead?: TitleLead;
  // A card that opens and closes: whether it is open now, and what a click on its title row asks for.
  readonly toggle?: { readonly open: boolean; readonly hit: Hit };
  readonly rows: readonly MainRow<Hit>[];
}

interface MainRows<Hit> {
  readonly lines: string[];
  readonly hits: (Hit | undefined)[];
}

// What a card's own width leaves for its rows: the borders and one padding column at each side.
function contentWidth(cardWidth: number): number {
  return Math.max(1, cardWidth - 4);
}

// The width of a card in a rail row `width` wide: the margins at each side take their columns.
function cardWidthOf(width: number): number {
  return Math.max(5, width - 2 * RAIL_MARGIN);
}

// The text of a row as the rows it is drawn in, before they are fitted to the card.
function rowTexts<Hit>(row: MainRow<Hit>, content: number): string[] {
  const prefix = row.prefix ?? "";
  const text = plainText(row.text);
  const indent = textWidth(prefix);
  const room = content - indent;
  const most = row.rows ?? 1;
  if (most <= 1 || room < 1 || indent + textWidth(text) <= content) return [`${prefix}${text}`];
  const parts = wrap(text.trim(), room);
  const shown =
    parts.length <= most
      ? parts
      : [...parts.slice(0, most - 1), truncate(parts.slice(most - 1).join(" "), room)];
  return shown.map((part, index) => `${index === 0 ? prefix : " ".repeat(indent)}${part}`);
}

// The cards as rows `width` columns wide (the margins included) and the hit of each row.
export function drawMainCards<Hit>(
  cards: readonly MainCard<Hit>[],
  width: number,
  ascii: boolean,
): MainRows<Hit> {
  const glyphs = railGlyphs(ascii);
  const cardWidth = cardWidthOf(width);
  const content = contentWidth(cardWidth);
  const lines: string[] = [];
  const hits: (Hit | undefined)[] = [];
  for (const [index, card] of cards.entries()) {
    if (index > 0) {
      for (let gap = 0; gap < CARD_GAP; gap++) {
        lines.push(paddedCell("", width, "text", "panel"));
        hits.push(undefined);
      }
    }
    const open = card.toggle?.open ?? true;
    const inner: string[] = [];
    const innerHits: (Hit | undefined)[] = [];
    if (open) {
      for (const row of card.rows) {
        for (const part of rowTexts(row, content)) {
          inner.push(textRow(part, row.tone ?? "text", content));
          innerHits.push(row.hit);
        }
      }
    }
    const title =
      card.toggle === undefined
        ? card.title
        : `${open ? glyphs.open : glyphs.closed} ${card.title}`;
    const framed = boxFrame(title, inner, {
      ascii,
      width: cardWidth,
      ...(card.titleTone === undefined ? {} : { titleTone: card.titleTone }),
      ...(card.lead === undefined ? {} : { lead: card.lead }),
    });
    lines.push(...framed.map(inset));
    hits.push(card.toggle?.hit, ...innerHits, undefined);
  }
  return { lines, hits };
}

// The hints under the cards: a blank row and a muted row for each, outside any card and with no action.
export function drawMainHints(hints: readonly string[], width: number): MainRows<never> {
  const rowWidth = cardWidthOf(width);
  return {
    lines: [
      paddedCell("", width, "text", "panel"),
      ...hints.map((hint) => inset(textRow(hint, "muted", rowWidth))),
    ],
    hits: [undefined, ...hints.map(() => undefined)],
  };
}
