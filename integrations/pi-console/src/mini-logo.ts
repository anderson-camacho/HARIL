import { paddedCell, visualText } from "./dashboard-theme.js";
import { stripAnsi, textWidth } from "./text.js";

// The small HARIL logo: a miniature of the welcome's block logo, always on screen. The right rail pins it under its
// content while it is open, and the chat's header draws it while the rail is closed; it is never in both.

// Half blocks, two rows of letters. The third row is the shadow's: like the welcome's, one cell down and to the right.
const LETTERS: readonly string[] = ["█▄█ █▀█ █▀█ ▀█▀ █", "█ █ █▀█ █▀▄ ▄█▄ █▄▄"];
const WORD = "HARIL";

export const MINI_LOGO_WIDTH = (LETTERS[1]?.length ?? 0) + 1;

type Background = "panel" | undefined;

function shadowRow(row: number): string {
  const here = LETTERS[row] ?? "";
  const above = LETTERS[row - 1] ?? "";
  let out = "";
  for (let x = 0; x < MINI_LOGO_WIDTH; x++) {
    const cell = here[x] ?? " ";
    out += cell === " " && above[x - 1] !== undefined && above[x - 1] !== " " ? "░" : cell;
  }
  return out.trimEnd();
}

// Draws one row: the letters in the logo tone, what the shadow added in the darker one. Only the shadow's cells carry
// "░" until here, and they leave as half blocks so the shadow stays thinner than the letters.
function paint(row: string, background: Background): string {
  return row
    .split(/(░+)/u)
    .filter((part) => part !== "")
    .map((part) =>
      part.startsWith("░")
        ? visualText("▀".repeat(part.length), "dim", background)
        : visualText(part, "cyan", background),
    )
    .join("");
}

// The logo's rows for `width` columns, unpadded and with no background: the word where the blocks do not fit or
// cannot be trusted (ASCII mode), and nothing where not even the word does.
export function miniLogo(
  width: number,
  options: { readonly ascii?: boolean; readonly background?: Background } = {},
): string[] {
  if (width < WORD.length) return [];
  if (width < MINI_LOGO_WIDTH || options.ascii === true) {
    return [visualText(WORD, "cyan", options.background)];
  }
  return [0, 1, 2].map((row) => paint(shadowRow(row), options.background));
}

// `content` with the logo on the last rows of a rail `height` rows tall and `width` wide. Real content always wins: when
// the logo does not fit whole in the free rows, the content comes back as it was.
export function withPinnedLogo(
  content: readonly string[],
  height: number,
  width: number,
  ascii = false,
): readonly string[] {
  const logo = miniLogo(width - 1, { ascii, background: "panel" });
  const free = height - content.length;
  if (logo.length === 0 || free < logo.length) return content;
  const blank = paddedCell("", width, "text", "panel");
  const rows = logo.map((row) => {
    const shown = textWidth(stripAnsi(row));
    return `${paddedCell("", 1, "text", "panel")}${row}${paddedCell("", width - 1 - shown, "text", "panel")}`;
  });
  return [...content, ...Array.from({ length: free - logo.length }, () => blank), ...rows];
}
