// How a dock view (the MEM and DOCS tabs) is laid out in the right rail: as cards, the actions of a card as buttons.
// The view declares its sections as data (DockCard) and this module draws them, so what a menu or a click needs (an
// action and its label) is carried by the data and never read back from the rows that were drawn.
import { blankRow, boxFrame, button, inset, textRow } from "./rail-cards.js";
import { CARD_GAP } from "./rail-metrics.js";
import { textWidth } from "./text.js";

// The most a card title may take before it shares the top border's room with the corners and the rule.
const TITLE_ROOM = 31;

// An action a view offers: the words on its button and the id the console runs.
interface DockButton {
  readonly label: string;
  readonly action: string;
}

// A section of a view: a title, rows of plain text (each at most a card's content wide) and then, optionally, the
// buttons that act on it.
export interface DockCard {
  readonly title: string;
  readonly rows: readonly string[];
  readonly buttons?: readonly DockButton[];
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
    for (const row of card.rows) lines.push(row === "" ? "" : `  ${row}`);
    for (const { label, action } of card.buttons ?? []) {
      actions.push({ line: lines.length, action, label });
      lines.push(`▸ ${label}`);
    }
  }
  return { lines, actions };
}

// What the rail draws for a view: its rows (each exactly RAIL_BODY_WIDTH wide, margins included) and, aligned with
// them, the action a click on each row runs (undefined for a row that runs nothing).
export interface RailRows {
  readonly rows: string[];
  readonly hits: (string | undefined)[];
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
  };
}

// One card as rows of the rail. `textHits` is the action of each text row (none of a card's own rows runs anything); the
// three rows of a button share the button's action, so a click on any of them runs it.
function drawCard(
  card: DockCard,
  ascii: boolean,
  textHits: readonly (string | undefined)[] = [],
): RailRows {
  const inner: string[] = card.rows.map((row) => textRow(row));
  const innerHits: (string | undefined)[] = card.rows.map((_row, index) => textHits[index]);
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
  const hits: (string | undefined)[] = [];
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
