import { describe, expect, it } from "vitest";
import {
  matrixFrame,
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
  });

  it("selects the real TerminalTextEffects Matrix when available", () => {
    expect(startupSettings({})).toEqual({ enabled: true, engine: "auto" });
    expect(startupSettings({ HARIL_STARTUP_MATRIX_ENGINE: "tte" }).engine).toBe("tte");
    expect(startupSettings({ HARIL_STARTUP_MATRIX_ENGINE: "built-in" }).engine).toBe("built-in");
    expect(TTE_MATRIX_ARGS).toContain("matrix");
    expect(TTE_MATRIX_ARGS).toContain("--rain-time");
    expect(TTE_MATRIX_ARGS.slice(0, 4)).toEqual(["--canvas-width", "0", "--canvas-height", "0"]);
    expect(startupSettings({ HARIL_STARTUP_ANIMATION: "off" }).enabled).toBe(false);
    expect(startupSettings({ CI: "true" }).enabled).toBe(false);
  });

  it("fills every terminal row and holds a large centered loaded banner for three seconds", async () => {
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
    expect(combined).toContain("SISTEMA CARGADO");
    expect(combined).toContain("HARIL");
    expect(combined).toContain("█");
    expect(combined).toContain("\u001b[28;1H");
    expect(combined).toContain("\u001b[?1049h");
    expect(combined).toContain("\u001b[?1049l");
    expect(combined).toContain("\u001b[?25h");
    expect(delays).toEqual([...Array(16).fill(85), 3_000]);
  });

  it("uses TTE's own rain when present and still shows HARIL for three seconds", async () => {
    const output: string[] = [];
    const delays: number[] = [];
    await playHarilStartup({
      out: { columns: 98, rows: 30, write: (piece) => output.push(piece) },
      env: {},
      cwd: ".",
      platform: "win32",
      runExternalMatrix: async () => true,
      wait: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([3_000]);
    expect(output.join("")).toContain("SISTEMA CARGADO");
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
    expect(writes.join("")).toContain("HARIL LISTO");
    expect(writes.join("")).toContain("\u001b[8;1H");
  });
});
