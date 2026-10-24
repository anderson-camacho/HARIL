import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostInfo, run } from "../src/cli.js";
import { harness, parseJson } from "./helpers.js";

let root: string;
let path: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-plugin-dock-"));
  path = join(root, "haril.json");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function host(): HostInfo {
  return {
    nodeVersion: "v24.21.0",
    platform: "linux",
    arch: "x64",
    homeDir: root,
    cwd: root,
    env: { HARIL_CONFIG: path },
  };
}

async function cli(...args: string[]) {
  const h = harness();
  const code = await run(["plugins", ...args], h.io, host());
  return { code, ...h };
}

function ids(out: readonly string[]): string[] {
  return parseJson<{ plugins: { id: string; visible: boolean }[] }>(out).plugins.map(
    (entry) => entry.id,
  );
}

describe("haril plugins (dock preferences, not Pi extension control)", () => {
  it("lists the default five slots without creating config and explains the scope", async () => {
    const list = await cli("list", "--json");
    expect(list.code).toBe(0);
    expect(ids(list.out)).toEqual(["explorer", "git", "youtube", "memory", "themes"]);
    expect(parseJson(list.out)).toMatchObject({ scope: "dock-preferences-only" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("hides, shows, reorders and resets dock slots, preserving the other settings", async () => {
    writeFileSync(path, '{\r\n    "ui": { "theme": "haril-blossom", "locale": "es" }\r\n}\r\n');
    expect((await cli("hide", "youtube")).code).toBe(0);
    const moved = await cli("move", "youtube", "up", "--json");
    expect(moved.code).toBe(0);
    expect(ids(moved.out)).toEqual(["explorer", "youtube", "git", "memory", "themes"]);
    const hidden = parseJson<{ plugins: { id: string; visible: boolean }[] }>(moved.out);
    expect(hidden.plugins.find((plugin) => plugin.id === "youtube")?.visible).toBe(false);
    expect((await cli("show", "youtube")).code).toBe(0);
    const stored = readFileSync(path, "utf8");
    expect(stored).toContain("\r\n");
    const document = JSON.parse(stored);
    expect(document.ui.theme).toBe("haril-blossom");
    expect(document.ui.locale).toBe("es");
    expect(document.ui.plugins[1]).toEqual({ id: "youtube", visible: true });
    expect(readdirSync(root)).toEqual(["haril.json"]);

    expect((await cli("reset")).code).toBe(0);
    expect(ids((await cli("list", "--json")).out)).toEqual([
      "explorer",
      "git",
      "youtube",
      "memory",
      "themes",
    ]);
  });

  it("does not overwrite malformed configuration or duplicate slots", async () => {
    const invalid = JSON.stringify({
      ui: {
        plugins: [
          { id: "git", visible: true },
          { id: "git", visible: false },
          { id: "memory", visible: true },
          { id: "themes", visible: true },
          { id: "youtube", visible: true },
        ],
      },
    });
    writeFileSync(path, invalid);
    const result = await cli("hide", "git");
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("duplicate dock slot");
    expect(readFileSync(path, "utf8")).toBe(invalid);
  });

  it("rejects unknown ids/directions without touching the file", async () => {
    expect((await cli("hide", "../external")).code).toBe(2);
    expect((await cli("move", "git", "left")).code).toBe(2);
    expect((await cli("list", "extraneous")).code).toBe(2);
    expect(readdirSync(root)).toEqual([]);
  });

  it("does not move outside the first or last position", async () => {
    expect((await cli("move", "explorer", "up")).code).toBe(0);
    expect((await cli("move", "themes", "down")).code).toBe(0);
    expect(ids((await cli("list", "--json")).out)).toEqual([
      "explorer",
      "git",
      "youtube",
      "memory",
      "themes",
    ]);
  });
});
