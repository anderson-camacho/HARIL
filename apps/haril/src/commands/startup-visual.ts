import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, posix, resolve, win32 } from "node:path";
import { VERSION } from "../version.js";
import { isCi } from "./terminal-colors.js";

// Half-width katakana retain one terminal cell on Windows Terminal, unlike full-width kana.
// The mix of kana, digits and symbols follows the green rain seen in TTE's Matrix effect.
const MATRIX_GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ012345789+-*/:;";
const FRAMES = 32;
const INTERVAL_MS = 55;
const LOADED_HOLD_MS = 1_600;
const MORPH_FRAMES = 14;
const MORPH_INTERVAL_MS = 75;

const LARGE_FONT: Record<string, readonly string[]> = {
  A: [" ### ", "#   #", "#####", "#   #", "#   #"],
  C: [" ####", "#    ", "#    ", "#    ", " ####"],
  D: ["#### ", "#   #", "#   #", "#   #", "#### "],
  E: ["#####", "#    ", "#### ", "#    ", "#####"],
  G: [" ####", "#    ", "# ###", "#   #", " ####"],
  H: ["#   #", "#   #", "#####", "#   #", "#   #"],
  I: ["#####", "  #  ", "  #  ", "  #  ", "#####"],
  L: ["#    ", "#    ", "#    ", "#    ", "#####"],
  M: ["#   #", "## ##", "# # #", "#   #", "#   #"],
  O: [" ### ", "#   #", "#   #", "#   #", " ### "],
  R: ["#### ", "#   #", "#### ", "#  # ", "#   #"],
  S: [" ####", "#    ", " ### ", "    #", "#### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  "],
};

// What the welcome paints with. `future` is blue with thin orange lines over the deep navy; `matrix` (and every palette
// that keeps the Matrix Pi theme) is green on the terminal's own background.
export type WelcomePalette = "future" | "matrix";

interface WelcomeTones {
  readonly background: string;
  readonly head: string;
  readonly bright: string;
  readonly middle: string;
  readonly faint: string;
  readonly logo: string;
  readonly shadow: string;
  readonly online: string;
  readonly muted: string;
  readonly line: string;
}

const rgb = (red: number, green: number, blue: number): string =>
  `\u001b[22;38;2;${red};${green};${blue}m`;

const WELCOME_TONES: Record<WelcomePalette, WelcomeTones> = {
  future: {
    // The terminal's default background: the navy of OSC 11, or the user's background image through it.
    background: "",
    head: rgb(196, 233, 255),
    bright: rgb(94, 194, 255),
    middle: rgb(47, 127, 192),
    faint: rgb(22, 58, 96),
    logo: "\u001b[1;38;2;94;194;255m",
    shadow: rgb(27, 74, 120),
    online: rgb(125, 248, 213),
    muted: rgb(127, 163, 199),
    line: rgb(184, 110, 46),
  },
  matrix: {
    background: "",
    head: "\u001b[22;97m",
    bright: "\u001b[22;92m",
    middle: "\u001b[22;32m",
    faint: "\u001b[22;38;5;22m",
    logo: "\u001b[1;92m",
    shadow: "\u001b[22;38;5;22m",
    online: "\u001b[22;92m",
    muted: "\u001b[22;32m",
    line: "\u001b[22;32m",
  },
};

export interface StartupOutput {
  readonly columns?: number;
  readonly rows?: number;
  write(text: string): void;
}

export interface StartupSettings {
  readonly enabled: boolean;
  readonly engine: "auto" | "built-in" | "tte";
  readonly soundFile?: string;
}

export function startupSettings(
  env: Readonly<Record<string, string | undefined>>,
): StartupSettings {
  return {
    enabled: env.HARIL_STARTUP_ANIMATION !== "off" && !isCi(env),
    engine:
      env.HARIL_STARTUP_MATRIX_ENGINE === "built-in"
        ? "built-in"
        : env.HARIL_STARTUP_MATRIX_ENGINE === "tte"
          ? "tte"
          : "auto",
    ...(env.HARIL_STARTUP_SOUND_FILE ? { soundFile: env.HARIL_STARTUP_SOUND_FILE } : {}),
  };
}

// Each frame covers the terminal's current grid, with constant row sizes and coordinates.
export function matrixFrame(index: number, width = 80, height = 24): readonly string[] {
  const lines: string[] = [];
  const glyphs = Array.from(MATRIX_GLYPHS);
  // Wrap full-length vertical streams across the entire window from the very first
  // frame. A short stream starting at y=0 leaves the lower half black on tall screens.
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const distance = (((y + x * 7 - index * 2) % 16) + 16) % 16;
      const lit = x % 29 !== 0 && distance < 12;
      row += lit ? glyphs[(x * 13 + y * 7 + index * 11) % glyphs.length] : " ";
    }
    lines.push(row);
  }
  return lines;
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function terminalSize(out: StartupOutput): { width: number; height: number } {
  return {
    // Keep the last cell empty: printing in the bottom-right cell scrolls some terminals.
    width: Math.max(1, Math.floor(out.columns ?? 80) - 1),
    height: Math.max(1, Math.floor(out.rows ?? 24)),
  };
}

// One frame of rain or dissolve as positioned, coloured rows. Every row ends by clearing to its end in the frame's
// background, so the last column (never printed: it can scroll) matches the rest.
function paintedFrame(
  lines: readonly string[],
  frame: number,
  palette: WelcomePalette,
): readonly string[] {
  const tones = WELCOME_TONES[palette];
  return lines.map((row, rowIndex) => {
    let colored = tones.background;
    let previousTone = "";
    for (const [columnIndex, character] of Array.from(row).entries()) {
      const distance = (((rowIndex + columnIndex * 7 - frame * 2) % 16) + 16) % 16;
      const tone =
        character === "█"
          ? tones.logo
          : distance === 0
            ? tones.head
            : distance < 3
              ? tones.bright
              : distance < 7
                ? tones.middle
                : tones.faint;
      if (character !== " " && tone !== previousTone) {
        colored += tone;
        previousTone = tone;
      }
      colored += character;
    }
    return `${colored}\u001b[K\u001b[0m`;
  });
}

// A frame of the dissolve (step 1 to MORPH_FRAMES), as rows, for the given window.
export function welcomeMorph(
  step: number,
  width: number,
  height: number,
  palette: WelcomePalette,
): readonly string[] {
  return paintedFrame(matrixMorphFrame(step, width, height), FRAMES + step - 1, palette);
}

function writeRows(out: StartupOutput, rows: readonly string[]): void {
  out.write(rows.map((row, index) => `\u001b[${index + 1};1H${row}`).join(""));
}

async function matrixBuiltIn(
  out: StartupOutput,
  wait: (ms: number) => Promise<void>,
  palette: WelcomePalette,
): Promise<void> {
  const { width, height } = terminalSize(out);
  // Rain dissolves into the same large HARIL, without clearing the canvas.
  for (let frame = 0; frame < FRAMES + MORPH_FRAMES; frame++) {
    const resolving = frame >= FRAMES;
    const lines = resolving
      ? matrixMorphFrame(frame - FRAMES + 1, width, height)
      : matrixFrame(frame, width, height);
    writeRows(out, paintedFrame(lines, frame, palette));
    await wait(resolving ? MORPH_INTERVAL_MS : INTERVAL_MS);
  }
}

function largeText(word: string): readonly string[] {
  return Array.from({ length: 5 }, (_, row) =>
    Array.from(word)
      .map((letter) => LARGE_FONT[letter]?.[row] ?? "     ")
      .join(" ")
      .replaceAll("#", "█"),
  );
}

export function harilBannerLines(width: number, height: number): readonly string[] {
  const original = largeText("HARIL");
  // Fill roughly four fifths of the available width while retaining all glyph
  // proportions. On small consoles the title still fits without scrolling.
  const horizontal = Math.max(
    1,
    Math.min(6, Math.floor((width * 0.8) / (original[0]?.length ?? 29))),
  );
  const vertical = Math.max(1, Math.min(3, Math.floor((height * 0.42) / original.length)));
  return original.flatMap((line) => {
    const expanded = Array.from(line, (ch) => ch.repeat(horizontal)).join("");
    return Array.from({ length: vertical }, () => expanded);
  });
}

// Final target exactly matches TTE's input silhouette and the built-in dissolve.
function harilMask(width: number, height: number): readonly string[] {
  const logo = width >= 29 && height >= 7 ? harilBannerLines(width, height) : ["HARIL"];
  const top = Math.max(0, Math.floor((height - logo.length) / 2));
  const rows = Array.from({ length: height }, () => " ".repeat(width));
  for (const [i, line] of logo.entries()) {
    if (top + i >= height) break;
    const clipped = line.slice(0, width);
    const left = Math.max(0, Math.floor((width - clipped.length) / 2));
    rows[top + i] = " ".repeat(left) + clipped + " ".repeat(width - left - clipped.length);
  }
  return rows;
}

function spaced(text: string): string {
  return Array.from(text).join(" ");
}

// The last frame: the logo where the dissolve left it, its shadow one cell down and right, the line that says it is
// ready and, as room allows, the label above, the thin lines and the footer. The cursor stands after the ready line.
export function welcomeFinal(
  width: number,
  height: number,
  palette: WelcomePalette,
): { readonly rows: readonly string[]; readonly cursor?: { row: number; column: number } } {
  const tones = WELCOME_TONES[palette];
  const mask = harilMask(width, height);
  const first = mask.findIndex((row) => row.trim() !== "");
  const count = mask.filter((row) => row.trim() !== "").length;
  const solid = mask.some((row) => row.includes("█"));
  const bottom = first + count + (solid ? 1 : 0);
  const logoRow = (y: number): string => {
    const here = mask[y] ?? "";
    const above = solid ? (mask[y - 1] ?? "") : "";
    let row = "";
    let tone = "";
    for (let x = 0; x < width; x++) {
      const cell = here[x] ?? " ";
      const shade = cell === " " && x > 0 && above[x - 1] === "█";
      const next = cell !== " " ? tones.logo : shade ? tones.shadow : tone;
      if (next !== tone) {
        row += next;
        tone = next;
      }
      row += shade ? "█" : cell;
    }
    return row.trimEnd();
  };
  const centered = (text: string, tone: string): string => {
    const size = Math.min(Array.from(text).length, width);
    const shown = Array.from(text).slice(0, size).join("");
    return `${" ".repeat(Math.floor((width - size) / 2))}${tone}${shown}`;
  };
  const texts = new Map<number, string>();
  const logoWidth = (mask[first] ?? "").trim().length;
  const rule = "─".repeat(Math.min(width, Math.max(logoWidth, 20)));
  const ready = width >= 34 ? "✓ SYSTEM ONLINE _ READY FOR INPUT" : "✓ ONLINE";
  const readyRow = bottom + 1 < height ? bottom + 1 : bottom < height ? bottom : -1;
  if (readyRow >= 0) texts.set(readyRow, centered(ready, tones.online));
  if (readyRow + 1 < height && readyRow === bottom + 1)
    texts.set(readyRow + 1, centered(rule, tones.line));
  if (first >= 2) {
    const label = "INITIALIZING WORKSPACE...";
    const spacedLabel = `▸ ${spaced(label)}`;
    texts.set(
      first - 2,
      centered(Array.from(spacedLabel).length <= width ? spacedLabel : `▸ ${label}`, tones.muted),
    );
  }
  if (first >= 3) texts.set(first - 3, centered(rule, tones.line));
  const footerRow = height - 1;
  if (footerRow > readyRow + 2 && width >= 40) {
    texts.set(footerRow, centered(`HARIL ${VERSION}  ·  /haril  ·  Alt+C comandos`, tones.muted));
  }
  const rows = Array.from({ length: height }, (_row, y) => {
    const body = texts.get(y) ?? logoRow(y);
    return `${tones.background}${body}\u001b[K\u001b[0m`;
  });
  if (readyRow < 0) return { rows };
  const column = Math.floor((width - Array.from(ready).length) / 2) + Array.from(ready).length + 2;
  return { rows, cursor: { row: readyRow + 1, column: Math.min(column, width) } };
}

export function matrixMorphFrame(step: number, width = 80, height = 24): readonly string[] {
  const progress = Math.min(1, Math.max(0, step / MORPH_FRAMES));
  const target = harilMask(width, height);
  const rain = matrixFrame(FRAMES - 1 + step, width, height);
  return target.map((line, y) =>
    Array.from(line, (pixel, x) => {
      const threshold = ((x * 73 + y * 41) % 101) / 100;
      return progress >= threshold ? pixel : (rain[y]?.[x] ?? " ");
    }).join(""),
  );
}

// The actual Matrix implementation from ChrisBuilds/terminaltexteffects takes priority when
// `tte` is installed. Full-terminal canvas dimensions are critical: TTE otherwise defaults
// to the tiny bounds of its input text. Never download or install third-party code on boot.
export const TTE_MATRIX_ARGS = [
  "--canvas-width",
  "0",
  "--canvas-height",
  "0",
  "--anchor-canvas",
  "c",
  "--anchor-text",
  "c",
  "matrix",
  // One second ends before the streams reach the bottom of a large terminal.
  "--rain-time",
  "3",
  "--rain-column-delay-range",
  "1-2",
  "--rain-fall-delay-range",
  "1-2",
  "--resolve-delay",
  "1",
  "--final-gradient-stops",
  "77ffa5",
  "26ee68",
  "--final-gradient-frames",
  "2",
] as const;

// The same effect in the blue of the Future palette; the Matrix palette keeps TTE's own green rain.
export function tteMatrixArgs(palette: WelcomePalette): readonly string[] {
  if (palette === "matrix") return TTE_MATRIX_ARGS;
  const stops = TTE_MATRIX_ARGS.indexOf("--final-gradient-stops");
  return [
    ...TTE_MATRIX_ARGS.slice(0, stops),
    "--highlight-color",
    "c4e9ff",
    "--rain-color-gradient",
    "163a60",
    "5ec2ff",
    "--final-gradient-stops",
    "5ec2ff",
    "2f7fc0",
    ...TTE_MATRIX_ARGS.slice(stops + 3),
  ];
}

const TTE_MAX_MS = 12_000;

// The updater owns this binary under HARIL_RUNTIME_DIR: users don't need uv,
// Python, or tte on PATH after installation. A separately installed tte is supported.
export function matrixExecutable(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const root = env.HARIL_RUNTIME_DIR;
  if (root) {
    const ops = platform === "win32" ? win32 : posix;
    const binary = ops.join(root, "tools", "bin", platform === "win32" ? "tte.exe" : "tte");
    if (exists(binary)) return binary;
  }
  return "tte";
}

async function matrixTte(
  out: StartupOutput,
  env: NodeJS.ProcessEnv,
  platform: string,
  palette: WelcomePalette,
): Promise<boolean> {
  return new Promise<boolean>((done) => {
    let finished = false;
    const child = spawn(matrixExecutable(env, platform), tteMatrixArgs(palette), {
      stdio: ["pipe", "inherit", "ignore"],
      windowsHide: true,
    });
    const finish = (available: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(available);
    };
    const timer = setTimeout(() => {
      child.kill();
      // A timed-out effect did not finish resolving. Render our own complete
      // fallback rather than claiming a partial Matrix finished successfully.
      finish(false);
    }, TTE_MAX_MS);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    child.stdin?.on("error", () => undefined);
    // TTE resolves the rain to the final large logo directly. No tiny-text jump.
    const { width, height } = terminalSize(out);
    const logo = width >= 29 && height >= 7 ? harilBannerLines(width, height) : ["HARIL"];
    child.stdin?.end(`${logo.join("\n")}\n`);
  });
}

function playSound(
  soundFile: string | undefined,
  cwd: string,
  platform: string,
  env: NodeJS.ProcessEnv,
  out: StartupOutput,
): void {
  if (soundFile === undefined) {
    out.write("\u0007");
    return;
  }
  const path = isAbsolute(soundFile) ? soundFile : resolve(cwd, soundFile);
  try {
    if (extname(path).toLowerCase() !== ".wav") return;
    const info = statSync(path);
    if (!info.isFile() || info.size > 5 * 1024 * 1024) return;
  } catch {
    return;
  }
  const windows = platform === "win32";
  const player = windows ? "powershell.exe" : "ffplay";
  const args = windows
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$s=New-Object System.Media.SoundPlayer($env:HARIL_STARTUP_SOUND_FILE); $s.PlaySync()",
      ]
    : ["-nodisp", "-autoexit", "-loglevel", "quiet", path];
  const child = spawn(player, args, {
    stdio: "ignore",
    windowsHide: true,
    env: { ...env, HARIL_STARTUP_SOUND_FILE: path },
  });
  child.on("error", () => undefined); // A missing OS player never prevents Pi from opening.
}

export async function playHarilStartup(options: {
  readonly out: StartupOutput;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly platform: string;
  readonly wait?: (ms: number) => Promise<void>;
  readonly runExternalMatrix?: () => Promise<boolean>;
  // Blue for Future, green otherwise. Absent is the green the welcome has always had.
  readonly palette?: WelcomePalette;
  // Stays in the full-screen buffer with the cursor hidden, so Pi takes over with no flash of the shell's screen. The
  // caller then owes the way back (terminal-colors.ts screenKept). A welcome that fails leaves the screen itself.
  readonly keepScreen?: boolean;
}): Promise<boolean> {
  const settings = startupSettings(options.env);
  if (!settings.enabled) return false;
  playSound(settings.soundFile, options.cwd, options.platform, options.env, options.out);
  const wait = options.wait ?? delay;
  const palette = options.palette ?? "matrix";
  let kept = false;
  try {
    // Enter the alternate full-screen buffer BEFORE starting TTE. Otherwise the
    // external rain paints the main console while our logo uses another buffer.
    const background = WELCOME_TONES[palette].background;
    options.out.write(`\u001b[?1049h\u001b[?25l${background}\u001b[2J\u001b[H`);
    try {
      const playedExternal =
        settings.engine !== "built-in" &&
        (await (
          options.runExternalMatrix ??
          (() => matrixTte(options.out, options.env, options.platform, palette))
        )());
      if (!playedExternal) await matrixBuiltIn(options.out, wait, palette);
      // Whole rows over the last frame of either engine: the logo stays, nothing is erased first.
      const { width, height } = terminalSize(options.out);
      const final = welcomeFinal(width, height, palette);
      writeRows(options.out, final.rows);
      if (final.cursor !== undefined) {
        options.out.write(
          `\u001b[${final.cursor.row};${final.cursor.column}H\u001b[1 q\u001b[?25h`,
        );
      }
      await wait(LOADED_HOLD_MS);
      kept = options.keepScreen === true;
    } finally {
      options.out.write(kept ? "\u001b[?25l\u001b[0m" : "\u001b[0m\u001b[?25h\u001b[?1049l");
    }
  } catch {
    // A decorative startup is not allowed to block the core shell.
  }
  return kept;
}
