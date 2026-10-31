// The one place that says how wide the right rail is and how its columns are shared. Every row the rail draws, and
// every click that is mapped back to a column, derives from RAIL_WIDTH; nothing else in the console hard-codes 40, 39
// or 38 for it.
//
//   col 0            the rail's own "│" separator (drawn by renderRightDock)
//   col 1            the left margin
//   cols 2..38       a card: its border, one padding column, 33 columns of content, one padding column, its border
//   col 39           the right margin
//
// A card holds a button as wide as its content; a button keeps one padding column inside each of its borders.

// Columns the rail takes in Pi's layout.
export const RAIL_WIDTH = 40;
// Columns of a rail row after the separator (what renderRightDock hands each row, and what the status block is built at).
export const RAIL_BODY_WIDTH = RAIL_WIDTH - 1;
// The margin on each side of a card.
export const RAIL_MARGIN = 1;
// A card's outer width: the body less the margin at each side, so a card never touches the separator or the edge.
export const CARD_WIDTH = RAIL_BODY_WIDTH - 2 * RAIL_MARGIN;
// What is between a card's borders is its content plus one padding column on each side.
const CARD_PADDING = 1;
const CARD_BORDER = 1;
// Columns of content a row of a card has.
export const CARD_CONTENT_WIDTH = CARD_WIDTH - 2 * (CARD_BORDER + CARD_PADDING);
// A button is drawn inside a card, as wide as the card's content.
export const BUTTON_WIDTH = CARD_WIDTH - 2 * (CARD_BORDER + CARD_PADDING);
// Columns of label a button has (its borders and padding take the rest).
export const BUTTON_LABEL_WIDTH = BUTTON_WIDTH - 2 * (CARD_BORDER + CARD_PADDING);
// The column of the first character of a card's content: the separator, the margin, the border and the padding. A tab
// of the header box is hit this many columns after its offset in the tab text.
export const CARD_TEXT_X = 1 + RAIL_MARGIN + CARD_BORDER + CARD_PADDING;
// Blank rows between two stacked cards.
export const CARD_GAP = 0;
