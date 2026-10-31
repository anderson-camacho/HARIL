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
    expect(ids(list.out)).toEqual(["main", "memory", "docs", "activity", "actions"]);
    expect(parseJson(list.out)).toMatchObject({ scope: "dock-preferences-only" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("hides, shows, reorders and resets dock slots, preserving the other settings", async () => {
    writeFileSync(path, '{\r\n    "ui": { "theme": "haril-blossom", "locale": "es" }\r\n}\r\n');
    expect((await cli("hide", "docs")).code).toBe(0);
    const moved = await cli("move", "docs", "up", "--json");
    expect(moved.code).toBe(0);
    expect(ids(moved.out)).toEqual(["main", "docs", "memory", "activity", "actions"]);
    const hidden = parseJson<{ plugins: { id: string; visible: boolean }[] }>(moved.out);
    expect(hidden.plugins.find((plugin) => plugin.id === "docs")?.visible).toBe(false);
    expect((await cli("show", "docs")).code).toBe(0);
    const stored = readFileSync(path, "utf8");
    expect(stored).toContain("\r\n");
    const document = JSON.parse(stored);
    expect(document.ui.theme).toBe("haril-blossom");
    expect(document.ui.locale).toBe("es");
    expect(document.ui.plugins[1]).toEqual({ id: "docs", visible: true });
    expect(readdirSync(root)).toEqual(["haril.json"]);

    expect((await cli("reset")).code).toBe(0);
    expect(ids((await cli("list", "--json")).out)).toEqual([
      "main",
      "memory",
      "docs",
      "activity",
      "actions",
    ]);
  });

  it("hides, shows and moves the activity slot like any other", async () => {
    const hidden = await cli("hide", "activity", "--json");
    expect(hidden.code).toBe(0);
    const slots = parseJson<{ plugins: { id: string; visible: boolean }[] }>(hidden.out).plugins;
    expect(slots.find((plugin) => plugin.id === "activity")?.visible).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).ui.plugins).toEqual([
      { id: "main", visible: true },
      { id: "memory", visible: true },
      { id: "docs", visible: true },
      { id: "activity", visible: false },
      { id: "actions", visible: true },
    ]);
    const moved = await cli("move", "activity", "up", "--json");
    expect(moved.code).toBe(0);
    expect(ids(moved.out)).toEqual(["main", "memory", "activity", "docs", "actions"]);
    expect((await cli("move", "activity", "up")).code).toBe(0);
    expect(ids((await cli("list", "--json")).out)).toEqual([
      "main",
      "activity",
      "memory",
      "docs",
      "actions",
    ]);
    // The first slot below main is as far up as a slot goes.
    const refused = await cli("move", "activity", "up");
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toContain("main");
    const shown = await cli("show", "activity", "--json");
    expect(shown.code).toBe(0);
    expect(
      parseJson<{ plugins: { id: string; visible: boolean }[] }>(shown.out).plugins.find(
        (plugin) => plugin.id === "activity",
      )?.visible,
    ).toBe(true);
  });

  it("hides, shows and moves the actions slot like any other", async () => {
    const hidden = await cli("hide", "actions", "--json");
    expect(hidden.code).toBe(0);
    const slots = parseJson<{ plugins: { id: string; visible: boolean }[] }>(hidden.out).plugins;
    expect(slots.find((plugin) => plugin.id === "actions")?.visible).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).ui.plugins).toEqual([
      { id: "main", visible: true },
      { id: "memory", visible: true },
      { id: "docs", visible: true },
      { id: "activity", visible: true },
      { id: "actions", visible: false },
    ]);
    const moved = await cli("move", "actions", "up", "--json");
    expect(moved.code).toBe(0);
    expect(ids(moved.out)).toEqual(["main", "memory", "docs", "actions", "activity"]);
    for (let step = 0; step < 2; step++) expect((await cli("move", "actions", "up")).code).toBe(0);
    expect(ids((await cli("list", "--json")).out)).toEqual([
      "main",
      "actions",
      "memory",
      "docs",
      "activity",
    ]);
    // The first slot below main is as far up as a slot goes.
    const refused = await cli("move", "actions", "up");
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toContain("main");
    const shown = await cli("show", "actions", "--json");
    expect(shown.code).toBe(0);
    expect(
      parseJson<{ plugins: { id: string; visible: boolean }[] }>(shown.out).plugins.find(
        (plugin) => plugin.id === "actions",
      )?.visible,
    ).toBe(true);
  });

  it("names the activity and actions slots in its usage text", async () => {
    const result = await cli("hide", "nope");
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("<main|memory|docs|activity|actions>");
  });

  it("does not overwrite malformed configuration or duplicate slots", async () => {
    const invalid = JSON.stringify({
      ui: {
        plugins: [
          { id: "main", visible: true },
          { id: "memory", visible: true },
          { id: "memory", visible: false },
          { id: "docs", visible: true },
        ],
      },
    });
    writeFileSync(path, invalid);
    const result = await cli("hide", "docs");
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("duplicate dock slot");
    expect(readFileSync(path, "utf8")).toBe(invalid);
  });

  it("rejects unknown ids/directions without touching the file", async () => {
    expect((await cli("hide", "../external")).code).toBe(2);
    expect((await cli("move", "memory", "left")).code).toBe(2);
    expect((await cli("list", "extraneous")).code).toBe(2);
    // The slots that were retired are not targets any more.
    for (const retired of ["git", "youtube", "themes", "explorer"]) {
      expect((await cli("hide", retired)).code, retired).toBe(2);
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it("does not move outside the last position", async () => {
    expect((await cli("move", "actions", "down")).code).toBe(0);
    expect(ids((await cli("list", "--json")).out)).toEqual([
      "main",
      "memory",
      "docs",
      "activity",
      "actions",
    ]);
    expect((await cli("move", "docs", "down")).code).toBe(0);
    expect(ids((await cli("list", "--json")).out)).toEqual([
      "main",
      "memory",
      "activity",
      "docs",
      "actions",
    ]);
  });

  describe("main is always the first slot and always visible", () => {
    it("refuses to hide or move main, saying why, and writes nothing", async () => {
      for (const args of [
        ["hide", "main"],
        ["move", "main", "down"],
        ["move", "main", "up"],
      ]) {
        const result = await cli(...args);
        expect(result.code, args.join(" ")).toBe(2);
        expect(result.err.join("\n"), args.join(" ")).toContain("main");
        expect(result.err.join("\n"), args.join(" ")).toContain("first and visible");
      }
      expect(readdirSync(root)).toEqual([]);
    });

    it("refuses to move another slot above main", async () => {
      const result = await cli("move", "memory", "up");
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toContain("main");
      expect(readdirSync(root)).toEqual([]);
    });

    it("lets main be shown, which changes nothing", async () => {
      const shown = await cli("show", "main", "--json");
      expect(shown.code).toBe(0);
      expect(ids(shown.out)).toEqual(["main", "memory", "docs", "activity", "actions"]);
    });

    it("rejects a stored list that hides main instead of rewriting it", async () => {
      const stored = JSON.stringify({
        ui: {
          plugins: [
            { id: "main", visible: false },
            { id: "memory", visible: true },
            { id: "docs", visible: true },
          ],
        },
      });
      writeFileSync(path, stored);
      const result = await cli("list");
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toContain("the main slot cannot be hidden");
      expect(readFileSync(path, "utf8")).toBe(stored);
    });
  });

  // Releases before MAIN/MEM/DOCS stored GIT, YT, MEM and THEME (and, before the TREE removal, a fifth "explorer"
  // entry). Such a file must keep working: every command reads it and the next write replaces it by the new list.
  describe("a haril.json written before the MAIN, MEM and DOCS slots", () => {
    const legacy = JSON.stringify({
      ui: {
        theme: "haril-blossom",
        plugins: [
          { id: "explorer", visible: true },
          { id: "memory", visible: false },
          { id: "git", visible: true },
          { id: "youtube", visible: false },
          { id: "themes", visible: true },
        ],
      },
    });
    const fourSlots = JSON.stringify({
      ui: {
        plugins: [
          { id: "git", visible: true },
          { id: "youtube", visible: false },
          { id: "memory", visible: true },
          { id: "themes", visible: true },
        ],
      },
    });

    it("lists every slot of the registry, keeping what memory had, without rewriting the file", async () => {
      writeFileSync(path, legacy);
      const list = await cli("list", "--json");
      expect(list.code).toBe(0);
      expect(ids(list.out)).toEqual(["main", "memory", "docs", "activity", "actions"]);
      const plugins = parseJson<{ plugins: { id: string; visible: boolean }[] }>(list.out).plugins;
      expect(plugins.find((plugin) => plugin.id === "memory")?.visible).toBe(false);
      expect(plugins.find((plugin) => plugin.id === "main")?.visible).toBe(true);
      expect(plugins.find((plugin) => plugin.id === "docs")?.visible).toBe(true);
      expect(plugins.find((plugin) => plugin.id === "activity")?.visible).toBe(true);
      expect(plugins.find((plugin) => plugin.id === "actions")?.visible).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(legacy);
    });

    it("lists the four-entry list of the previous release the same way", async () => {
      writeFileSync(path, fourSlots);
      const list = await cli("list", "--json");
      expect(list.code).toBe(0);
      expect(ids(list.out)).toEqual(["main", "memory", "docs", "activity", "actions"]);
      expect(readFileSync(path, "utf8")).toBe(fourSlots);
    });

    it("writes the new five-entry list on the next change and keeps the other settings", async () => {
      writeFileSync(path, legacy);
      const hidden = await cli("hide", "docs", "--json");
      expect(hidden.code).toBe(0);
      expect(ids(hidden.out)).toEqual(["main", "memory", "docs", "activity", "actions"]);
      const document = JSON.parse(readFileSync(path, "utf8"));
      expect(document.ui.theme).toBe("haril-blossom");
      expect(document.ui.plugins).toEqual([
        { id: "main", visible: true },
        { id: "memory", visible: false },
        { id: "docs", visible: false },
        { id: "activity", visible: true },
        { id: "actions", visible: true },
      ]);
    });

    it("lets the rest of the CLI load the file: the dock list is not what rejects it", async () => {
      writeFileSync(path, legacy);
      const h = harness();
      const code = await run(["config", "get", "ui.locale", "--json"], h.io, host());
      expect(code, h.err.join("\n")).toBe(0);
    });

    it("no longer accepts a retired slot as a command target", async () => {
      writeFileSync(path, legacy);
      for (const retired of ["explorer", "git", "youtube", "themes"]) {
        expect((await cli("show", retired)).code, retired).toBe(2);
      }
      expect(readFileSync(path, "utf8")).toBe(legacy);
    });
  });

  // The release before ACT wrote MAIN, MEM and DOCS only. Reading it appends ACT and ACC, visible, and does not touch
  // the file; the next write stores the five slots.
  describe("a haril.json written with the three slots of the previous release", () => {
    const threeSlots = JSON.stringify({
      ui: {
        theme: "haril-blossom",
        plugins: [
          { id: "main", visible: true },
          { id: "docs", visible: false },
          { id: "memory", visible: true },
        ],
      },
    });

    it("lists ACT and ACC last and visible, keeping the others, and leaves the file as it was", async () => {
      writeFileSync(path, threeSlots);
      const list = await cli("list", "--json");
      expect(list.code, list.err.join("\n")).toBe(0);
      expect(ids(list.out)).toEqual(["main", "docs", "memory", "activity", "actions"]);
      const plugins = parseJson<{ plugins: { id: string; visible: boolean }[] }>(list.out).plugins;
      expect(plugins.map((plugin) => plugin.visible)).toEqual([true, false, true, true, true]);
      expect(readFileSync(path, "utf8")).toBe(threeSlots);
    });

    it("writes the five slots on the next change, so ACT and ACC are stored from then on", async () => {
      writeFileSync(path, threeSlots);
      expect((await cli("hide", "memory")).code).toBe(0);
      const document = JSON.parse(readFileSync(path, "utf8"));
      expect(document.ui.theme).toBe("haril-blossom");
      expect(document.ui.plugins).toEqual([
        { id: "main", visible: true },
        { id: "docs", visible: false },
        { id: "memory", visible: false },
        { id: "activity", visible: true },
        { id: "actions", visible: true },
      ]);
    });

    it("lets the rest of the CLI load the file", async () => {
      writeFileSync(path, threeSlots);
      const h = harness();
      const code = await run(["config", "get", "ui.locale", "--json"], h.io, host());
      expect(code, h.err.join("\n")).toBe(0);
    });
  });

  // The release before ACC wrote MAIN, MEM, DOCS and ACT. Reading it appends ACC, visible, and does not touch the
  // file; the next write stores the five slots, and ACC can be hidden, shown and moved from then on.
  describe("a haril.json written with the four slots of the previous release", () => {
    const fourSlots = JSON.stringify({
      ui: {
        theme: "haril-blossom",
        plugins: [
          { id: "main", visible: true },
          { id: "activity", visible: false },
          { id: "memory", visible: true },
          { id: "docs", visible: true },
        ],
      },
    });

    it("lists ACC last and visible, keeping the others, and leaves the file as it was", async () => {
      writeFileSync(path, fourSlots);
      const list = await cli("list", "--json");
      expect(list.code, list.err.join("\n")).toBe(0);
      expect(ids(list.out)).toEqual(["main", "activity", "memory", "docs", "actions"]);
      const plugins = parseJson<{ plugins: { id: string; visible: boolean }[] }>(list.out).plugins;
      expect(plugins.map((plugin) => plugin.visible)).toEqual([true, false, true, true, true]);
      expect(readFileSync(path, "utf8")).toBe(fourSlots);
    });

    it("writes the five slots when ACC is hidden, and keeps the other settings", async () => {
      writeFileSync(path, fourSlots);
      expect((await cli("hide", "actions")).code).toBe(0);
      const document = JSON.parse(readFileSync(path, "utf8"));
      expect(document.ui.theme).toBe("haril-blossom");
      expect(document.ui.plugins).toEqual([
        { id: "main", visible: true },
        { id: "activity", visible: false },
        { id: "memory", visible: true },
        { id: "docs", visible: true },
        { id: "actions", visible: false },
      ]);
    });
  });
});
