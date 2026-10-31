import { describe, expect, it } from "vitest";
import {
  matrixMorphFrame,
  playHarilStartup,
  startupSettings,
  TTE_MATRIX_ARGS,
  tteMatrixArgs,
  welcomeFinal,
  welcomeMorph,
} from "../src/commands/startup-visual.js";

const ESC = String.fromCharCode(27);
const plain = (text: string) => text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");

describe("palette-aware welcome", () => {
  it("is on by default, off in any CI and with the off switch", () => {
    expect(startupSettings({}).enabled).toBe(true);
    expect(startupSettings({ CI: "1" }).enabled).toBe(false);
    expect(startupSettings({ CI: "false" }).enabled).toBe(true);
    expect(startupSettings({ HARIL_STARTUP_ANIMATION: "off" }).enabled).toBe(false);
  });

  it("composes the final frame: label, centered logo, online line, footer", () => {
    const { rows, cursor } = welcomeFinal(119, 30, "future");
    expect(rows).toHaveLength(30);
    const text = rows.map(plain);
    expect(text.join("\n")).toContain("█");
    expect(text.some((row) => row.includes("I N I T I A L I Z I N G"))).toBe(true);
    const online = text.findIndex((row) => row.includes("SYSTEM ONLINE _ READY FOR INPUT"));
    expect(online).toBeGreaterThan(0);
    expect(cursor?.row).toBe(online + 1);
    expect(rows.join("")).toContain("38;2;94;194;255");
    expect(rows.join("")).toContain("38;2;125;248;213");
    expect(rows.join("")).toContain("38;2;184;110;46");
    const logo = text.filter((row) => row.includes("█"));
    expect((logo[0] ?? "").search(/█/)).toBeGreaterThan(5);
  });

  it("keeps the logo at the same place as the last frame of the dissolve", () => {
    const mask = matrixMorphFrame(14, 119, 30);
    const { rows } = welcomeFinal(119, 30, "future");
    const first = mask.findIndex((row) => row.includes("█"));
    expect(plain(rows[first] ?? "").includes("█")).toBe(true);
    expect(plain(rows[first - 1] ?? "").includes("█")).toBe(false);
  });

  it("colours rain and logo by palette: blue for future, green for matrix", () => {
    expect(welcomeMorph(7, 80, 24, "future").join("")).toContain("48;2;7;23;44");
    expect(welcomeMorph(7, 80, 24, "matrix").join("")).toContain("[1;92m");
    expect(welcomeMorph(7, 80, 24, "matrix").join("")).not.toContain("48;2;7;23;44");
    expect(tteMatrixArgs("future")).toContain("--rain-color-gradient");
    expect(tteMatrixArgs("future")).toContain("5ec2ff");
    expect(tteMatrixArgs("matrix")).toEqual(TTE_MATRIX_ARGS);
  });

  it("fits narrow and tiny windows without overflowing", () => {
    for (const [width, height] of [
      [59, 20],
      [28, 8],
      [10, 3],
    ] as const) {
      const { rows } = welcomeFinal(width, height, "future");
      expect(rows).toHaveLength(height);
      for (const row of rows) expect(Array.from(plain(row)).length).toBeLessThanOrEqual(width);
    }
    expect(welcomeFinal(28, 8, "future").rows.map(plain).join("")).toContain("HARIL");
  });

  it("recovers the cursor and leaves the screen unless the caller keeps it", async () => {
    const run = async (keepScreen: boolean) => {
      const writes: string[] = [];
      await playHarilStartup({
        out: { columns: 80, rows: 24, write: (piece) => writes.push(piece) },
        env: {},
        cwd: ".",
        platform: "linux",
        palette: "future",
        keepScreen,
        runExternalMatrix: async () => false,
        wait: async () => undefined,
      });
      return writes.join("");
    };
    expect(await run(false)).toContain(`${ESC}[?25h${ESC}[?1049l`);
    const kept = await run(true);
    expect(kept).not.toContain(`${ESC}[?1049l`);
    expect(kept.endsWith(`${ESC}[?25l${ESC}[0m`)).toBe(true);
  });

  it("leaves the screen when the welcome fails, even if it was to be kept", async () => {
    const writes: string[] = [];
    await playHarilStartup({
      out: { columns: 80, rows: 24, write: (piece) => writes.push(piece) },
      env: {},
      cwd: ".",
      platform: "linux",
      palette: "future",
      keepScreen: true,
      runExternalMatrix: async () => {
        throw new Error("no effect");
      },
      wait: async () => undefined,
    });
    expect(writes.join("")).toContain(`${ESC}[?25h${ESC}[?1049l`);
  });
});
