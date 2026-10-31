// How a dock view (the TOOLS and DOCS tabs) is laid out in the right rail: as cards, the actions of a card as buttons.
// The view declares its sections as data (DockCard) and this module draws them, so what a menu or a click needs (an
// action and its label) is carried by the data and never read back from the rows that were drawn.
import type { DashboardTone } from "./dashboard-theme.js";
import { blankRow, boxFrame, button, chipRow, inset, textRow } from "./rail-cards.js";
import { CARD_GAP, CARD_TEXT_X } from "./rail-metrics.js";
import { textWidth } from "./text.js";

// The most a card title may take before it shares the top border's room with the corners and the rule.
const TITLE_ROOM = 31;

// An action a view offers: the words on its button and the id the console runs.
interface DockButton {
  readonly label: string;
  readonly action: string;
}

// An action drawn as a compact chip, several to a row: the short word on the chip, the full words the keyboard menu and
// the flat form read, and the id the console runs. The chip of the choice in force is drawn highlighted.
export interface DockChip {
  readonly label: string;
  readonly name: string;
  readonly action: string;
  readonly active?: boolean;
}

// A section of a view: a title, rows of plain text (each at most a card's content wide) and then, optionally, a row of
// chips and the buttons that act on it.
export interface DockCard {
  readonly title: string;
  readonly rows: readonly string[];
  // The tone of a row, by its index in `rows`; a row left out (or undefined) is drawn in the text tone. Only the rail
  // reads it: the flat form is text.
  readonly tones?: readonly (DashboardTone | undefined)[];
  readonly chips?: readonly DockChip[];
  readonly buttons?: readonly DockButton[];
  // What a click on a text row runs, by its index in `rows`. A row with a label is also an entry of the keyboard menu.
  readonly rowActions?: readonly (DockRowAction | undefined)[];
}

export interface DockRowAction {
  readonly action: string;
  readonly label?: string;
}

export interface DockAction {
  readonly line: number;
  readonly action: string;
  // The words the action reads as, for the keyboard menu ("Comprobar e instalar Engram").
  readonly label?: string;
}

// The flat form of cards, for the left dock and the inline details: a title, its rows indented under it, a pointer in
// front of each button, a blank line between two cards. `actions` names the line of each button.
export function flatView(cards: readonly DockCard[]): {
  lines: string[];
  actions: DockAction[];
} {
  const lines: string[] = [];
  const actions: DockAction[] = [];
  for (const [index, card] of cards.entries()) {
    if (index > 0) lines.push("");
    if (card.title !== "") lines.push(card.title);
    for (const [rowIndex, row] of card.rows.entries()) {
      const rowAction = card.rowActions?.[rowIndex];
      if (rowAction?.label !== undefined) {
        actions.push({ line: lines.length, action: rowAction.action, label: rowAction.label });
      }
      lines.push(row === "" ? "" : `  ${row}`);
    }
    // A chip reads as a line of its own, with the words of its menu entry.
    for (const { name, action } of card.chips ?? []) {
      actions.push({ line: lines.length, action, label: name });
      lines.push(`▸ ${name}`);
    }
    for (const { label, action } of card.buttons ?? []) {
      actions.push({ line: lines.length, action, label });
      lines.push(`▸ ${label}`);
    }
  }
  return { lines, actions };
}

// The columns of a row that run an action, when several actions share the row (chips): `from` is the first column and
// `to` the one after the last, counted from the first column of the card's content.
interface HitCell {
  readonly from: number;
  readonly to: number;
  readonly action: string;
}

// What a click on a row of the rail runs: one action for the whole row (a button, a line), an action for each range of
// columns (a row of chips), or nothing.
export type RailHit = string | { readonly cells: readonly HitCell[] } | undefined;

// The action a click at column `x` of the rail (0 is its separator, as in a mouse event) runs on a row: the row's action,
// or the one of the cell that holds the column. A click on a gap, a border or a margin runs nothing.
export function railHitAt(hit: RailHit, x: number): string | undefined {
  if (hit === undefined || typeof hit === "string") return hit;
  const column = x - CARD_TEXT_X;
  return hit.cells.find((cell) => column >= cell.from && column < cell.to)?.action;
}

// What the rail draws for a view: its rows (each exactly RAIL_BODY_WIDTH wide, margins included) and, aligned with
// them, what a click on each row runs (nothing for a row that runs nothing).
export interface RailRows {
  readonly rows: string[];
  readonly hits: RailHit[];
}

// What the rail needs of a view. DockDetails satisfies it; a view without cards is drawn from its lines.
export interface RailDetail {
  readonly title: string;
  readonly lines: readonly string[];
  readonly actions?: readonly { line: number; action: string }[];
  readonly cards?: readonly DockCard[];
}

// A title too long for the border keeps its first part there ("Engram y gentle-ai") and gives the rest of what follows
// its " · " ("no disponible") to the first row of the card.
function fitTitle(card: DockCard): DockCard {
  if (textWidth(card.title) <= TITLE_ROOM) return card;
  const cut = card.title.indexOf(" · ");
  if (cut <= 0) return card;
  return {
    ...card,
    title: card.title.slice(0, cut),
    rows: [card.title.slice(cut + 3), ...card.rows],
    // The row that was moved in has no tone of its own; the others keep theirs.
    ...(card.tones === undefined ? {} : { tones: [undefined, ...card.tones] }),
  };
}

// One card as rows of the rail. `textHits` is the action of each text row (none of a card's own rows runs anything); the
// three rows of a button share the button's action, so a click on any of them runs it.
function drawCard(
  card: DockCard,
  ascii: boolean,
  textHits: readonly (string | undefined)[] = [],
): RailRows {
  const inner: string[] = card.rows.map((row, index) =>
    textRow(row, card.tones?.[index] ?? "text"),
  );
  const innerHits: RailHit[] = card.rows.map(
    (_row, index) => textHits[index] ?? card.rowActions?.[index]?.action,
  );
  if (card.chips !== undefined && card.chips.length > 0) {
    const drawn = chipRow(card.chips, { ascii });
    // The three rows of the chips share their cells: each chip answers a click on any of its rows and columns.
    const hit: RailHit = {
      cells: drawn.cells.flatMap((cell, index) => {
        const chip = card.chips?.[index];
        return chip === undefined ? [] : [{ ...cell, action: chip.action }];
      }),
    };
    for (const row of drawn.rows) {
      inner.push(row);
      innerHits.push(hit);
    }
  }
  for (const { label, action } of card.buttons ?? []) {
    for (const row of button(label, { ascii })) {
      inner.push(row);
      innerHits.push(action);
    }
  }
  const framed = boxFrame(card.title, inner, { ascii });
  return { rows: framed.map(inset), hits: [undefined, ...innerHits, undefined] };
}

// A view as rows of the rail. A view with cards draws one box for each; one without (a plain list of lines) draws them
// in a single box titled with the view's own name, and a line that has an action stays clickable.
export function railRows(detail: RailDetail, ascii: boolean): RailRows {
  if (detail.cards === undefined) {
    if (detail.lines.length === 0) return { rows: [], hits: [] };
    return drawCard(
      { title: detail.title, rows: detail.lines },
      ascii,
      detail.lines.map(
        (_line, index) => detail.actions?.find((item) => item.line === index)?.action,
      ),
    );
  }
  const rows: string[] = [];
  const hits: RailHit[] = [];
  for (const [index, card] of detail.cards.entries()) {
    if (index > 0) {
      for (let gap = 0; gap < CARD_GAP; gap++) {
        rows.push(blankRow());
        hits.push(undefined);
      }
    }
    const drawn = drawCard(fitTitle(card), ascii);
    rows.push(...drawn.rows);
    hits.push(...drawn.hits);
  }
  return { rows, hits };
}
