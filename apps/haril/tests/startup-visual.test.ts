import { describe, expect, it } from "vitest";
import { matrixFrame, playHarilStartup, startupSettings } from "../src/commands/startup-visual.js";

describe("optional fast Matrix startup", () => {
  it("draws stable frames at a fixed position with no changing row length", () => {
    for (let n = 0; n < 6; n++) {
      const frame = matrixFrame(n, 42);
      expect(frame).toHaveLength(9);
      expect(frame.every((row) => Array.from(row).length === 42)).toBe(true);
    }
  });

  it("provides a quick integrated default and an opt-in external TTE engine", () => {
    expect(startupSettings({})).toEqual({ enabled: true, engine: "built-in" });
    expect(startupSettings({ HARIL_STARTUP_MATRIX_ENGINE: "tte" }).engine).toBe("tte");
    expect(startupSettings({ HARIL_STARTUP_ANIMATION: "off" }).enabled).toBe(false);
    expect(startupSettings({ CI: "true" }).enabled).toBe(false);
  });

  it("shows the loaded banner and restores the cursor while allowing Pi to continue", async () => {
    const output: string[] = [];
    const delays: number[] = [];
    await playHarilStartup({
      out: { columns: 78, write: (piece) => output.push(piece) },
      env: {},
      cwd: ".",
      platform: "linux",
      wait: async (ms) => {
        delays.push(ms);
      },
    });
    const combined = output.join("");
    expect(combined).toContain("SISTEMA CARGADO");
    expect(combined).toContain("HARIL");
    expect(combined).toContain("\u001b[?25h");
    expect(delays).toEqual([65, 65, 65, 65, 65, 65, 130]);
  });

  it("can be fully disabled or fall back safely on narrow terminals", async () => {
    const writes: string[] = [];
    const out = { columns: 20, write: (piece: string) => writes.push(piece) };
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
      wait: async () => undefined,
    });
    expect(writes.join("")).toContain("SISTEMA CARGADO");
    expect(writes.join("")).not.toContain("\u001b[9A");
  });
});
