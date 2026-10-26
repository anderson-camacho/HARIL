import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, posix, resolve, win32 } from "node:path";

// Half-width katakana retain one terminal cell on Windows Terminal, unlike full-width kana.
// The mix of kana, digits and symbols follows the green rain seen in TTE's Matrix effect.
const MATRIX_GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ012345789+-*/:;";
const FRAMES = 32;
const INTERVAL_MS = 55;
const LOADED_HOLD_MS = 3_000;

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
    enabled: env.HARIL_STARTUP_ANIMATION !== "off" && env.CI !== "true",
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

async function matrixBuiltIn(
  out: StartupOutput,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  const { width, height } = terminalSize(out);
  for (let frame = 0; frame < FRAMES; frame++) {
    let screen = "";
    for (const [rowIndex, row] of matrixFrame(frame, width, height).entries()) {
      let colored = "";
      let previousTone = "";
      for (const [columnIndex, character] of Array.from(row).entries()) {
        if (character !== " ") {
          const distance = (((rowIndex + columnIndex * 7 - frame * 2) % 16) + 16) % 16;
          const tone =
            distance === 0
              ? "\u001b[97m"
              : distance < 3
                ? "\u001b[92m"
                : distance < 7
                  ? "\u001b[32m"
                  : "\u001b[38;5;22m";
          if (tone !== previousTone) {
            colored += tone;
            previousTone = tone;
          }
        }
        colored += character;
      }
      screen += `\u001b[${rowIndex + 1};1H${colored}`;
    }
    out.write(screen);
    await wait(INTERVAL_MS);
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
  const horizontal = Math.max(1, Math.min(6, Math.floor((width * 0.8) / (original[0]?.length ?? 29))));
  const vertical = Math.max(1, Math.min(3, Math.floor((height * 0.42) / original.length)));
  return original.flatMap((line) => {
    const expanded = Array.from(line, (ch) => ch.repeat(horizontal)).join("");
    return Array.from({ length: vertical }, () => expanded);
  });
}

function loadedBanner(out: StartupOutput): void {
  const { width, height } = terminalSize(out);
  out.write("\u001b[0m\u001b[2J\u001b[H");
  const lines = width >= 29 && height >= 7 ? harilBannerLines(width, height) : ["HARIL"];
  const top = Math.max(1, Math.floor((height - lines.length) / 2) + 1);
  for (const [lineIndex, line] of lines.entries()) {
    const x = Math.max(1, Math.floor((width - line.length) / 2) + 1);
    out.write(`\u001b[${top + lineIndex};${x}H\u001b[1;92m${line}\u001b[0m`);
  }
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
] as const;

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

async function matrixTte(env: NodeJS.ProcessEnv, platform: string): Promise<boolean> {
  return new Promise<boolean>((done) => {
    let finished = false;
    const child = spawn(matrixExecutable(env, platform), TTE_MATRIX_ARGS, {
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
    // TTE resolves the rain into this word, centered in the full-screen canvas.
    child.stdin?.end("HARIL\n");
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
}): Promise<void> {
  const settings = startupSettings(options.env);
  if (!settings.enabled) return;
  playSound(settings.soundFile, options.cwd, options.platform, options.env, options.out);
  const wait = options.wait ?? delay;
  try {
    // Enter the alternate full-screen buffer BEFORE starting TTE. Otherwise the
    // external rain paints the main console while our logo uses another buffer.
    options.out.write("\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H");
    try {
      const playedExternal =
        settings.engine !== "built-in" &&
        (await (options.runExternalMatrix ?? (() => matrixTte(options.env, options.platform)))());
      if (!playedExternal) await matrixBuiltIn(options.out, wait);
      loadedBanner(options.out);
      await wait(LOADED_HOLD_MS);
    } finally {
      options.out.write("\u001b[0m\u001b[?25h\u001b[?1049l");
    }
  } catch {
    // A decorative startup is not allowed to block the core shell.
  }
}
