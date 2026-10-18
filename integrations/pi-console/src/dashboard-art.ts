const LETTERS: Readonly<Record<string, readonly string[]>> = {
  H: ["10001", "10001", "10001", "11111", "10001"],
  A: ["01110", "10001", "11111", "10001", "10001"],
  R: ["11110", "10001", "11110", "10100", "10010"],
  I: ["11111", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "11111"],
};

const NEURAL_PROFILE = [
  "       .-~~~~~~~~~~-.                 .---o---.",
  "     .'  ◉   ·   ◉   '.___o________.-'  / ◎ /",
  "    /  ·      .-----.      '-.       o--| ◎ |--●",
  "   |      o--/  ◉    /__ ·    '---.     / ◎ /",
  "   |         /  .-.     '---.   /  '---o-'-'",
  "   |    ·     /   '.__    /--'       .-'",
  "    /  ·       | |    '----'   o---●",
  "     '.___ ___|_|_.-'---'",
];

export function renderWordmark(compact: boolean): string[] {
  const glyphRows = [..."HARIL"].map((letter) => LETTERS[letter] ?? []);
  const rows = compact ? [0, 2, 4] : [0, 1, 2, 3, 4];
  return rows.map((row) =>
    glyphRows
      .map((glyph) =>
        (glyph[row] ?? "")
          .replaceAll("1", compact ? "█" : "██")
          .replaceAll("0", compact ? " " : "  "),
      )
      .join(compact ? " " : "  "),
  );
}

export function renderNeuralProfile(width: number, compact: boolean): string[] {
  const artwork = compact ? ["  ◉───╲___╱───o────●   NEURAL LINK"] : NEURAL_PROFILE;
  return artwork.map((line) =>
    line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line,
  );
}
