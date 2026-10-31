import { tailFit } from "./docs-folder.js";
import type { GitSummary } from "./git-summary.js";
import type { ConsoleTheme, ThemeColor } from "./pi-types.js";
import { plainText, textWidth, truncate } from "./text.js";

// The folder line of the bar drawn as powerline segments, after the `craver` theme of Oh My Posh: a folder segment and
// a git segment (branch and change counts), each a block of colour closed by an arrow. The statuses other extensions
// set are not segments; view.ts prints them after this head.
//
// It needs a Nerd Font (or any font with the Powerline glyphs); HARIL_POWERLINE=off keeps the plain line.

// Powerline and Nerd Font code points, built from numbers so no invisible private-use character sits in the source.
// U+E0B0: powerline "left hard divider", the solid arrow that points right and closes a segment.
const ARROW = String.fromCodePoint(0xe0b0);
// U+E0A0: powerline branch symbol.
const BRANCH_ICON = String.fromCodePoint(0xe0a0);
// U+F07B: Font Awesome folder (Nerd Fonts nf-fa-folder).
const FOLDER_ICON = String.fromCodePoint(0xf07b);

// Colour. `ConsoleTheme` offers a foreground (`fg`) and bold, no background, and every colour here must still be a
// theme token (haril-dark, -light, -blossom, -crimson and -matrix each define their own). So:
//  - A segment is printed as reverse video (SGR 7) over `theme.fg(tone, ...)`: the token's colour becomes the block and
//    the terminal's own background the letters, which reads on every theme without choosing a text colour here.
//  - An arrow that joins two segments needs the first one's colour over the second one's. The second colour is the
//    foreground sequence the theme itself gives for that token with its code 38 turned into 48 (backgrounds are the
//    same colour numbers), so no colour is invented. When the sequence cannot be read (a theme that prints no colour
//    codes, or one this does not know), the arrow stands on the terminal's background and the next block follows it.
// Every line is closed with a reset, so no attribute leaks into the lines Pi draws after this one.
const ESC = "\u001b";
const REVERSE_ON = `${ESC}[7m`;
const REVERSE_OFF = `${ESC}[27m`;
const BACKGROUND_DEFAULT = `${ESC}[49m`;
const RESET = `${ESC}[0m`;
// What `theme.fg` may start with, as the number list of the SGR: truecolor, 256 colours, the 8 basic and the 8 bright.
const FOREGROUND_CODE = /^(38;2;\d{1,3};\d{1,3};\d{1,3}|38;5;\d{1,3}|3[0-7]|9[0-7])$/;

// The least a shortened folder or branch is worth showing; below it the part gives way entirely.
const MIN_FOLDER_COLUMNS = 4;
const MIN_BRANCH_COLUMNS = 6;

// HARIL_POWERLINE=off (or 0, or false) keeps the plain folder line; anything else, or nothing, draws the segments.
export function powerlineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.HARIL_POWERLINE?.trim().toLowerCase();
  return !(value === "off" || value === "0" || value === "false");
}

export interface PowerlineInput {
  // The folder as it should read (the home directory already shown as ~).
  readonly folder: string;
  // The git branch, or null outside a repository: no git segment then.
  readonly branch: string | null;
  // The change counts, undefined while unknown (git has not answered, or failed).
  readonly git: GitSummary | undefined;
}

export interface PowerlineHead {
  readonly line: string;
  // The columns the line takes, with the escape sequences left out.
  readonly width: number;
}

interface Segment {
  // The text of the block, its padding included.
  readonly text: string;
  readonly tone: ThemeColor;
}

// One column for the arrow that follows each block.
function widthOf(segments: readonly Segment[]): number {
  return segments.reduce((sum, segment) => sum + textWidth(segment.text) + 1, 0);
}

// `+1 ~2 ?3`: staged, modified and untracked; a count of zero is left out.
function countsText(git: GitSummary | undefined): string {
  if (git === undefined) return "";
  const counts = [
    git.staged > 0 ? `+${git.staged}` : "",
    git.modified > 0 ? `~${git.modified}` : "",
    git.untracked > 0 ? `?${git.untracked}` : "",
  ];
  return counts.filter((count) => count !== "").join(" ");
}

// Clean is success, changes are a warning, and a state git has not told is the quiet muted tone.
function gitTone(git: GitSummary | undefined): ThemeColor {
  if (git === undefined) return "muted";
  return git.staged + git.modified + git.untracked > 0 ? "warning" : "success";
}

function folderSegment(text: string, icon: boolean): Segment {
  return { text: icon ? ` ${FOLDER_ICON} ${text} ` : ` ${text} `, tone: "accent" };
}

// The git segment: the icon, then the branch and the counts that are given.
function gitSegment(git: GitSummary | undefined, branch?: string, counts?: string): Segment {
  const name = branch === undefined ? "" : ` ${branch}`;
  const changes = counts === undefined || counts === "" ? "" : ` ${counts}`;
  return { text: ` ${BRANCH_ICON}${name}${changes} `, tone: gitTone(git) };
}

// The background that matches `tone`, from the foreground sequence the theme gives it; undefined when it cannot be read.
function backgroundOf(theme: ConsoleTheme, tone: ThemeColor): string | undefined {
  const sample = theme.fg(tone, "x");
  if (!sample.startsWith(`${ESC}[`)) return undefined;
  const code = sample.slice(2, sample.indexOf("m"));
  if (!FOREGROUND_CODE.test(code)) return undefined;
  return code.startsWith("38;") ? `48;${code.slice(3)}` : String(Number(code) + 10);
}

// The arrow that closes a block of `tone`, over the block of `next` that follows (or the terminal's background).
export function blockArrow(theme: ConsoleTheme, tone: ThemeColor, next?: ThemeColor): string {
  const arrow = theme.fg(tone, ARROW);
  const background = next === undefined ? undefined : backgroundOf(theme, next);
  return background === undefined ? arrow : `${ESC}[${background}m${arrow}${BACKGROUND_DEFAULT}`;
}

// A block of colour: the tone is the block and the terminal's background the letters.
export function block(theme: ConsoleTheme, tone: ThemeColor, text: string): string {
  return `${REVERSE_ON}${theme.fg(tone, text)}${REVERSE_OFF}`;
}

function render(segments: readonly Segment[], theme: ConsoleTheme): string {
  let line = "";
  segments.forEach((segment, index) => {
    line += `${REVERSE_ON}${theme.fg(segment.tone, segment.text)}${REVERSE_OFF}`;
    const arrow = theme.fg(segment.tone, ARROW);
    const next = segments[index + 1];
    const background = next === undefined ? undefined : backgroundOf(theme, next.tone);
    line += background === undefined ? arrow : `${ESC}[${background}m${arrow}${BACKGROUND_DEFAULT}`;
  });
  return line + RESET;
}

// What the head is made of at `width`, from the richest to the leanest, the first that fits:
//   folder + git with branch and counts; the same without counts; the branch cut to what is left (at least
//   MIN_BRANCH_COLUMNS); the git segment as its icon alone; the folder alone; the folder cut from its start.
// Undefined when not even a one-column folder fits.
function segmentsFor(input: PowerlineInput, width: number): Segment[] | undefined {
  const folderText = plainText(input.folder);
  const branch = input.branch === null ? "" : plainText(input.branch).trim();
  const folder = folderSegment(folderText, true);
  const options: Segment[][] = [];
  if (branch !== "") {
    const counts = countsText(input.git);
    if (counts !== "") options.push([folder, gitSegment(input.git, branch, counts)]);
    options.push([folder, gitSegment(input.git, branch)]);
    // The room the branch name has when the icon is all else the git segment holds, less the space before the name.
    const room = width - widthOf([folder, gitSegment(input.git)]) - 1;
    if (room >= MIN_BRANCH_COLUMNS && textWidth(branch) > room) {
      options.push([folder, gitSegment(input.git, truncate(branch, room))]);
    }
    options.push([folder, gitSegment(input.git)]);
  }
  options.push([folder]);
  const fitting = options.find((segments) => widthOf(segments) <= width);
  if (fitting !== undefined) return fitting;
  // The folder, cut from its start (its name is what tells folders apart), with its icon while that leaves room. The
  // block takes two columns of padding and the arrow one, the icon two more.
  if (width - 5 >= MIN_FOLDER_COLUMNS) return [folderSegment(tailFit(folderText, width - 5), true)];
  if (width - 3 >= 1) return [folderSegment(tailFit(folderText, width - 3), false)];
  return undefined;
}

// The folder and git segments for a line of `width` columns, or undefined when not even one fits (the caller then draws
// the plain line). Text that is not ours (the folder, the branch) goes through plainText first.
export function powerlineHead(
  input: PowerlineInput,
  width: number,
  theme: ConsoleTheme,
): PowerlineHead | undefined {
  if (width <= 0) return undefined;
  const segments = segmentsFor(input, width);
  if (segments === undefined) return undefined;
  return { line: render(segments, theme), width: widthOf(segments) };
}
