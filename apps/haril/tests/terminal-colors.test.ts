import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureQuietStartup } from "../src/commands/pi-settings.js";
import {
  openTerminalSession,
  terminalColorsApply,
  withTerminalSession,
} from "../src/commands/terminal-colors.js";

const SET = "\u001b]11;#07172c\u001b\\";
const RESTORE = "\u001b]111\u001b\\";

function harness() {
  const writes: string[] = [];
  const handlers = new Map<string, () => void>();
  const raised: string[] = [];
  return {
    writes,
    handlers,
    raised,
    ports: {
      write: (text: string) => {
        writes.push(text);
      },
      on: (event: string, handler: () => void) => {
        handlers.set(event, handler);
      },
      off: (event: string) => {
        handlers.delete(event);
      },
      raise: (signal: string) => {
        raised.push(signal);
      },
    },
  };
}

describe("terminal colours for the future palette", () => {
  it("applies only on a TTY, outside CI, with the future palette and no off switch", () => {
    const base = { isTTY: true, theme: "haril-future", env: {} };
    expect(terminalColorsApply(base)).toBe(true);
    expect(terminalColorsApply({ ...base, isTTY: false })).toBe(false);
    expect(terminalColorsApply({ ...base, env: { CI: "true" } })).toBe(false);
    expect(terminalColorsApply({ ...base, env: { CI: "1" } })).toBe(false);
    expect(terminalColorsApply({ ...base, theme: "haril-matrix" })).toBe(false);
    expect(terminalColorsApply({ ...base, theme: undefined })).toBe(false);
    expect(terminalColorsApply({ ...base, env: { TERM: "dumb" } })).toBe(false);
    expect(terminalColorsApply({ ...base, env: { HARIL_TERMINAL_COLORS: "off" } })).toBe(false);
  });

  it("sets background, foreground and cursor, and restores all of them once", () => {
    const h = harness();
    const session = openTerminalSession({ ...h.ports, colors: true });
    expect(h.writes.join("")).toContain(SET);
    expect(h.writes.join("")).toContain("\u001b]10;#c4e9ff\u001b\\");
    expect(h.writes.join("")).toContain("\u001b]12;#5ec2ff\u001b\\");
    session.restore();
    session.restore();
    const all = h.writes.join("");
    expect(all.split(RESTORE)).toHaveLength(2);
    expect(all).toContain("\u001b]110\u001b\\");
    expect(all).toContain("\u001b]112\u001b\\");
    expect(h.handlers.size).toBe(0);
  });

  it("writes nothing when the colours do not apply and the screen was not kept", () => {
    const h = harness();
    openTerminalSession({ ...h.ports, colors: false }).restore();
    expect(h.writes).toEqual([]);
  });

  it("restores when the body throws", async () => {
    const h = harness();
    await expect(
      withTerminalSession({ ...h.ports, colors: true }, async () => {
        throw new Error("pi failed");
      }),
    ).rejects.toThrow("pi failed");
    expect(h.writes.join("")).toContain(RESTORE);
  });

  it("restores on a signal and on exit, then lets the signal do its work", () => {
    const h = harness();
    openTerminalSession({ ...h.ports, colors: true });
    expect([...h.handlers.keys()]).toEqual(
      expect.arrayContaining(["exit", "SIGTERM", "SIGHUP", "SIGBREAK"]),
    );
    h.handlers.get("SIGTERM")?.();
    expect(h.writes.join("")).toContain(RESTORE);
    expect(h.raised).toEqual(["SIGTERM"]);
    const other = harness();
    openTerminalSession({ ...other.ports, colors: true });
    other.handlers.get("exit")?.();
    expect(other.writes.join("")).toContain(RESTORE);
    expect(other.raised).toEqual([]);
  });

  it("recovers the cursor and the screen a kept welcome left behind", () => {
    const h = harness();
    const session = openTerminalSession({ ...h.ports, colors: false });
    session.screenKept();
    session.restore();
    expect(h.writes.join("")).toContain("\u001b[?25h\u001b[?1049l");
  });
});

describe("the quiet startup setting in the agent directory", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "haril-quiet-"));

  it("adds the setting when absent and keeps the rest of the file", () => {
    const agent = dir();
    writeFileSync(join(agent, "settings.json"), '{"theme":"dark","packages":["npm:x"]}');
    ensureQuietStartup(agent);
    expect(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      packages: ["npm:x"],
      quietStartup: "header",
    });
  });

  it("creates the file when missing, respects a choice and leaves a broken file alone", () => {
    const fresh = dir();
    ensureQuietStartup(fresh);
    expect(JSON.parse(readFileSync(join(fresh, "settings.json"), "utf8")).quietStartup).toBe(
      "header",
    );
    const chosen = dir();
    writeFileSync(join(chosen, "settings.json"), '{"quietStartup":false}');
    ensureQuietStartup(chosen);
    expect(readFileSync(join(chosen, "settings.json"), "utf8")).toBe('{"quietStartup":false}');
    const broken = dir();
    writeFileSync(join(broken, "settings.json"), "{ not json");
    ensureQuietStartup(broken);
    expect(readFileSync(join(broken, "settings.json"), "utf8")).toBe("{ not json");
  });
});
