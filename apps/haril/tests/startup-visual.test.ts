import { describe, expect, it } from "vitest";
import {
  harilBannerLines,
  matrixExecutable,
  matrixFrame,
  matrixMorphFrame,
  playHarilStartup,
  startupSettings,
  TTE_MATRIX_ARGS,
} from "../src/commands/startup-visual.js";

describe("full-terminal Matrix startup", () => {
  it("uses full-width, half-width katakana rain with stable row dimensions", () => {
    for (let n = 0; n < 16; n++) {
      const frame = matrixFrame(n, 95, 27);
      expect(frame).toHaveLength(27);
      expect(frame.every((row) => Array.from(row).length === 95)).toBe(true);
    }
    expect(matrixFrame(4, 95, 27).join("")).toMatch(/[ｱ-ﾝ]/u);
    // The bottom half must be populated from the first frame, not after
    // rain has fallen halfway through a tall Windows Terminal.
    for (const row of [0, 10, 26]) {
      expect(matrixFrame(0, 95, 27)[row]?.trim().length).toBeGreaterThan(10);
    }
  });

  it("selects the real TerminalTextEffects Matrix when available", () => {
    expect(startupSettings({})).toEqual({ enabled: true, engine: "auto" });
    expect(startupSettings({ HARIL_STARTUP_MATRIX_ENGINE: "tte" }).engine).toBe("tte");
    expect(startupSettings({ HARIL_STARTUP_MATRIX_ENGINE: "built-in" }).engine).toBe("built-in");
    expect(TTE_MATRIX_ARGS).toContain("matrix");
    expect(TTE_MATRIX_ARGS).toContain("--rain-time");
    expect(TTE_MATRIX_ARGS).toContain("--anchor-text");
    expect(TTE_MATRIX_ARGS).toContain("--final-gradient-stops");
    expect(TTE_MATRIX_ARGS[TTE_MATRIX_ARGS.indexOf("--anchor-text") + 1]).toBe("c");
    expect(TTE_MATRIX_ARGS[TTE_MATRIX_ARGS.indexOf("--rain-time") + 1]).toBe("3");
    expect(TTE_MATRIX_ARGS.slice(0, 4)).toEqual(["--canvas-width", "0", "--canvas-height", "0"]);
    expect(startupSettings({ HARIL_STARTUP_ANIMATION: "off" }).enabled).toBe(false);
    expect(startupSettings({ CI: "true" }).enabled).toBe(false);
  });

  it("prefers the TTE executable installed by haril update over the global PATH", () => {
    expect(
      matrixExecutable(
        { HARIL_RUNTIME_DIR: "C:\\Users\\Anderson\\AppData\\Local\\HARIL" },
        "win32",
        () => true,
      ),
    ).toBe("C:\\Users\\Anderson\\AppData\\Local\\HARIL\\tools\\bin\\tte.exe");
    expect(matrixExecutable({ HARIL_RUNTIME_DIR: "/local/haril" }, "linux", () => true)).toBe(
      "/local/haril/tools/bin/tte",
    );
    expect(matrixExecutable({ HARIL_RUNTIME_DIR: "/local/haril" }, "linux", () => false)).toBe(
      "tte",
    );
  });

  it("scales a HARIL-only logo to the terminal's full available width", () => {
    const lines = harilBannerLines(190, 50);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines[0]?.length).toBeGreaterThan(100);
    expect(lines.every((line) => line.length === lines[0]?.length)).toBe(true);
    expect(lines.join("")).not.toContain("SISTEMA");
  });

  it("fills every terminal row and holds a large centered HARIL for three seconds", async () => {
    const output: string[] = [];
    const delays: number[] = [];
    await playHarilStartup({
      out: { columns: 96, rows: 28, write: (piece) => output.push(piece) },
      env: {},
      cwd: ".",
      platform: "linux",
      runExternalMatrix: async () => false,
      wait: async (ms) => {
        delays.push(ms);
      },
    });
    const combined = output.join("");
    expect(combined).not.toContain("SISTEMA CARGADO");
    // The word is drawn as block glyphs, not literal text bytes.
    expect(combined).toContain("█");
    expect(combined).toContain("\u001b[28;1H");
    expect(combined).toContain("\u001b[?1049h");
    expect(combined).toContain("\u001b[?1049l");
    expect(combined).toContain("\u001b[?25h");
    expect(delays).toEqual([...Array(32).fill(55), ...Array(14).fill(75), 3_000]);
  });

  it("uses TTE's own rain when present and still shows HARIL for three seconds", async () => {
    const output: string[] = [];
    const delays: number[] = [];
    await playHarilStartup({
      out: { columns: 98, rows: 30, write: (piece) => output.push(piece) },
      env: {},
      cwd: ".",
      platform: "win32",
      runExternalMatrix: async () => {
        expect(output.join("")).toContain("\u001b[?1049h");
        return true;
      },
      wait: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([3_000]);
    expect(output.join("")).not.toContain("SISTEMA CARGADO");
    // The real TTE itself leaves the final large logo on-screen; there is no
    // second clear + external replacement with a different logo size.
    expect(output.join("").split("\u001b[2J")).toHaveLength(2);
  });

  it("fades characters into HARIL in fourteen stable full-screen frames", () => {
    const first = matrixMorphFrame(0, 96, 28);
    const middle = matrixMorphFrame(7, 96, 28);
    const final = matrixMorphFrame(14, 96, 28);
    expect(first).toHaveLength(28);
    expect(middle).toHaveLength(28);
    expect(final).toHaveLength(28);
    expect(final.every((row) => row.length === 96)).toBe(true);
    expect(first.join("")).toMatch(/[ｱ-ﾝ]/u);
    expect(middle.join("")).toContain("█");
    expect(middle.join("")).toMatch(/[ｱ-ﾝ]/u);
    expect(final.join("")).toContain("█");
    expect(final.join("")).not.toMatch(/[ｱ-ﾝ]/u);
  });

  it("can be fully disabled or fall back safely on narrow terminals", async () => {
    const writes: string[] = [];
    const out = { columns: 20, rows: 8, write: (piece: string) => writes.push(piece) };
    await playHarilStartup({
      out,
      env: { HARIL_STARTUP_ANIMATION: "off" },
      cwd: ".",
      platform: "linux",
    });
    expect(writes).toHaveLength(0);
    await playHarilStartup({
      out,
      env: {},
      cwd: ".",
      platform: "linux",
      runExternalMatrix: async () => false,
      wait: async () => undefined,
    });
    expect(writes.join("")).toContain("HARIL");
    expect(writes.join("")).toContain("\u001b[8;1H");
  });
});
