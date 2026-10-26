import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";

// Single-column glyphs prevent the multi-byte/wide-character drift seen in some Windows fonts.
const MATRIX_GLYPHS = "010101abcdef0123456789";
const MATRIX_WIDTH = 54;
const MATRIX_HEIGHT = 9;
const FRAMES = 6;
const INTERVAL_MS = 65;

export interface StartupOutput {
  readonly columns?: number;
  write(text: string): void;
}

export interface StartupSettings {
  readonly enabled: boolean;
  readonly engine: "built-in" | "tte";
  readonly soundFile?: string;
}

export function startupSettings(
  env: Readonly<Record<string, string | undefined>>,
): StartupSettings {
  return {
    enabled: env.HARIL_STARTUP_ANIMATION !== "off" && env.CI !== "true",
    engine: env.HARIL_STARTUP_MATRIX_ENGINE === "tte" ? "tte" : "built-in",
    ...(env.HARIL_STARTUP_SOUND_FILE ? { soundFile: env.HARIL_STARTUP_SOUND_FILE } : {}),
  };
}

// Constant dimensions and positions: every frame occupies the same cell grid. No extra lines
// are appended mid-animation, avoiding cursor drift and scrollback flicker.
export function matrixFrame(index: number, width = MATRIX_WIDTH): readonly string[] {
  const lines: string[] = [];
  const glyphs = Array.from(MATRIX_GLYPHS);
  for (let y = 0; y < MATRIX_HEIGHT; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const column = (x * 17 + 19) % (MATRIX_HEIGHT + 3);
      const lit = (y + index * 2 + column) % (MATRIX_HEIGHT + 3) < 4;
      row += lit ? glyphs[(x * 13 + y * 7 + index * 11) % glyphs.length] : " ";
    }
    lines.push(row);
  }
  return lines;
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function matrixBuiltIn(
  out: StartupOutput,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  const width = Math.min(MATRIX_WIDTH, Math.max(0, (out.columns ?? 80) - 4));
  if (width < 36) return;
  out.write("\u001b[?25l\n".repeat(1));
  out.write("\n".repeat(MATRIX_HEIGHT));
  try {
    for (let frame = 0; frame < FRAMES; frame++) {
      out.write(`\u001b[${MATRIX_HEIGHT}A`);
      for (const row of matrixFrame(frame, width)) {
        out.write(`\r\u001b[2K\u001b[38;5;${frame % 2 ? 46 : 34}m${row}\u001b[0m\n`);
      }
      await wait(INTERVAL_MS);
    }
    out.write(`\u001b[${MATRIX_HEIGHT}A`);
    for (let line = 0; line < MATRIX_HEIGHT; line++) out.write("\r\u001b[2K\n");
    out.write(`\u001b[${MATRIX_HEIGHT}A`);
  } finally {
    out.write("\u001b[0m\u001b[?25h");
  }
}

// Optional use of ChrisBuilds/terminaltexteffects. It is never downloaded or run unless the
// user explicitly selects it, and cannot delay Pi startup for more than 900 ms.
async function matrixTte(): Promise<boolean> {
  return new Promise<boolean>((done) => {
    let finished = false;
    const child = spawn("tte", ["matrix"], {
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
    }, 900);
    child.once("error", () => finish(false));
    child.once("exit", () => finish(true));
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
}): Promise<void> {
  const settings = startupSettings(options.env);
  if (!settings.enabled) return;
  playSound(settings.soundFile, options.cwd, options.platform, options.env, options.out);
  try {
    if (settings.engine !== "tte" || !(await matrixTte())) {
      await matrixBuiltIn(options.out, options.wait ?? delay);
    }
  } catch {
    // A decorative startup is not allowed to block the core shell.
  }
  options.out.write("\u001b[0m\u001b[?25h");
  options.out.write("\u001b[1;32m  ╔══════════════════════════════════════╗\n");
  options.out.write("  ║    SISTEMA CARGADO  ·  HARIL        ║\n");
  options.out.write("  ╚══════════════════════════════════════╝\u001b[0m\n");
  await (options.wait ?? delay)(130);
}
