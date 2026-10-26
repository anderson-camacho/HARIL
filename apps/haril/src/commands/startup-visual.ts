import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, posix, resolve, win32 } from "node:path";

// Half-width katakana retain one terminal cell on Windows Terminal, unlike full-width kana.
// The mix of kana, digits and symbols follows the green rain seen in TTE's Matrix effect.
const MATRIX_GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ012345789+-*/:;";
const FRAMES = 16;
const INTERVAL_MS = 85;
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
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const column = (x * 17 + index * 2 + 19) % (height + 8);
      const trail = 7 + ((x * 11) % 8);
      const lit = x % 17 !== 0 && y <= column && column - y < trail;
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
          const head = (columnIndex * 17 + frame * 2 + 19) % (height + 8);
          const distance = head - rowIndex;
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

function loadedBanner(out: StartupOutput): void {
  const { width, height } = terminalSize(out);
  out.write("\u001b[0m\u001b[2J\u001b[H");
  const sections = height >= 21 && width >= 43 ? ["SISTEMA", "CARGADO", "HARIL"] : ["HARIL"];
  const bigHeight = sections.length * 5 + (sections.length - 1);
  const top = Math.max(1, Math.floor((height - bigHeight - 2) / 2) + 1);
  const fontFits = width >= 30 && height >= 9;
  if (fontFits) {
    for (const [sectionIndex, word] of sections.entries()) {
      for (const [lineIndex, line] of largeText(word).entries()) {
        const x = Math.max(1, Math.floor((width - line.length) / 2) + 1);
        const y = top + sectionIndex * 6 + lineIndex;
        out.write(`\u001b[${y};${x}H\u001b[1;92m${line}`);
      }
    }
  }
  const label = "SISTEMA CARGADO  ·  HARIL";
  const caption = width >= label.length ? label : width >= 12 ? "HARIL LISTO" : "HARIL";
  const x = Math.max(1, Math.floor((width - caption.length) / 2) + 1);
  const labelY = fontFits ? Math.min(height, top + bigHeight + 1) : Math.ceil(height / 2);
  out.write(`\u001b[${labelY};${x}H\u001b[1;32m${caption}\u001b[0m`);
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
  "matrix",
  "--rain-time",
  "1",
  "--rain-column-delay-range",
  "1-3",
  "--rain-fall-delay-range",
  "1-4",
  "--resolve-delay",
  "1",
] as const;

const TTE_MAX_MS = 2_500;

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
      finish(true);
    }, TTE_MAX_MS);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end("SISTEMA CARGADO · HARIL\n");
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
    const playedExternal =
      settings.engine !== "built-in" &&
      (await (options.runExternalMatrix ?? (() => matrixTte(options.env, options.platform)))());
    // Alternative screen uses the complete window, protects scrollback and is restored for Pi.
    options.out.write("\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H");
    try {
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
