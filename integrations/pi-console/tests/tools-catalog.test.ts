import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flatView, railRows } from "../src/rail-view.js";
import { statusLines } from "../src/status-info.js";
import { stripAnsi } from "../src/text.js";
import { buildCatalog, type CatalogSources, setMcpEnabled } from "../src/tools-catalog.js";
import { CATALOG_ACTIONS, catalogView } from "../src/tools-catalog-view.js";
import { createToolsPanel, type ToolsHost } from "../src/tools-panel.js";

const FAKE_SECRET = "fake-secret-fixture";

let root: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-catalog-"));
  agentDir = join(root, "agent");
  cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const sources = (over: Partial<CatalogSources> = {}): CatalogSources => ({
  commands: [],
  tools: [],
  registered: [],
  promptSkills: undefined,
  agentDir,
  cwd,
  ...over,
});

const writeGlobal = (value: unknown): void =>
  writeFileSync(
    join(agentDir, "mcp.json"),
    typeof value === "string" ? value : JSON.stringify(value, null, 4),
  );

const allText = (view: ReturnType<typeof catalogView>): string =>
  flatView(view.cards).lines.join("\n");

const actionsOf = (view: ReturnType<typeof catalogView>): string[] =>
  view.cards.flatMap((card) => card.buttons ?? []).map(({ action }) => action);

describe("the skills", () => {
  it("lists what Pi reports, from the commands and the prompt options, once each", () => {
    const catalog = buildCatalog(
      sources({
        commands: [
          {
            name: "skill:pdf-tools",
            description: "Reads PDFs",
            source: "skill",
            sourceInfo: { path: "C:/skills/pdf-tools/SKILL.md", source: "user" },
          },
          { name: "haril-status", description: "x", source: "extension" },
          { name: "review", description: "x", source: "prompt" },
        ],
        promptSkills: [
          {
            name: "pdf-tools",
            description: "Reads PDFs",
            filePath: "C:/skills/pdf-tools/SKILL.md",
          },
          {
            name: "manual-only",
            description: "Only by command",
            filePath: "C:/skills/manual-only/SKILL.md",
            disableModelInvocation: true,
          },
        ],
      }),
    );
    expect(catalog.skills.map(({ name }) => name)).toEqual(["manual-only", "pdf-tools"]);
    expect(catalog.skills[0]?.modelInvocable).toBe(false);
  });

  it("explains where to put a skill when there is none, in both languages", () => {
    const catalog = buildCatalog(sources());
    const es = allText(catalogView(catalog, { kind: "list", filter: "" }, "es"));
    const en = allText(catalogView(catalog, { kind: "list", filter: "" }, "en"));
    expect(es).toContain("SKILL.md");
    expect(es).toContain("Sin skills");
    expect(en).toContain("No skills");
    expect(en).toContain(".pi/skills");
  });

  it("opens a summary whose action is the real invocation", () => {
    const catalog = buildCatalog(
      sources({
        commands: [
          {
            name: "skill:pdf-tools",
            description: "Reads PDFs",
            source: "skill",
            sourceInfo: { path: "C:/skills/pdf-tools/SKILL.md" },
          },
        ],
      }),
    );
    const view = catalogView(catalog, { kind: "skill", name: "pdf-tools" }, "en");
    const text = allText(view);
    expect(text).toContain("Reads PDFs");
    expect(text).toContain("SKILL.md");
    expect(text).toContain("/skill:pdf-tools");
    expect(actionsOf(view)).toContain(`${CATALOG_ACTIONS.useSkill}pdf-tools`);
  });
});

describe("the MCP servers", () => {
  it("says connected only when Pi registered visible tools, and lists them", () => {
    writeGlobal({
      mcpServers: {
        "my-docs": { url: "https://example.com/mcp" },
        idle: { command: "idle.exe" },
        off: { command: "off.exe", enabled: false },
        broken: { args: [] },
        gone: { command: "gone.exe" },
      },
    });
    const catalog = buildCatalog(
      sources({
        tools: [
          { name: "mcp__my_docs__search", exposure: "direct" },
          { name: "mcp__my_docs__read", exposure: "codemode" },
          { name: "mcp__gone__old", exposure: "hidden" },
          { name: "read", exposure: "direct" },
        ],
      }),
    );
    const state = Object.fromEntries(catalog.servers.map((s) => [s.name, s.state]));
    expect(state).toEqual({
      broken: "invalid",
      gone: "not_checked",
      idle: "not_checked",
      "my-docs": "connected",
      off: "disabled",
    });
    expect(catalog.servers.find((s) => s.name === "my-docs")?.tools).toEqual(["read", "search"]);
  });

  it("never shows a secret from env, headers, args, a URL or a command line", () => {
    writeGlobal({
      mcpServers: {
        one: {
          command: "C:/bin/server.exe",
          args: ["--token", FAKE_SECRET],
          env: { SOME_VALUE: FAKE_SECRET },
        },
        two: {
          url: `https://user:${FAKE_SECRET}@example.com/mcp?token=${FAKE_SECRET}`,
          headers: { Authorization: `Bearer ${FAKE_SECRET}` },
          oauth: { clientSecret: FAKE_SECRET },
        },
        three: { command: `tool.exe --password=${FAKE_SECRET}` },
      },
    });
    const catalog = buildCatalog(sources());
    expect(JSON.stringify(catalog)).not.toContain(FAKE_SECRET);
    for (const name of ["one", "two", "three"]) {
      const text = allText(catalogView(catalog, { kind: "mcp", name }, "en"));
      expect(text).not.toContain(FAKE_SECRET);
    }
    const two = allText(catalogView(catalog, { kind: "mcp", name: "two" }, "en"));
    expect(two).toContain("example.com/mcp");
    expect(two.replace(/\s+/g, " ")).toContain("1 header");
  });

  it("turns a damaged or misshapen file into a warning that quotes nothing of it", () => {
    writeGlobal(`{ "mcpServers": { "a": { "env": { "X": "${FAKE_SECRET}" `);
    const damaged = buildCatalog(sources());
    expect(damaged.servers).toEqual([]);
    expect(damaged.warnings).toHaveLength(1);
    const text = allText(catalogView(damaged, { kind: "list", filter: "" }, "en"));
    expect(text).toContain("could not be read");
    expect(text).not.toContain(FAKE_SECRET);

    writeGlobal({ mcpServers: ["not", "an", "object"] });
    expect(buildCatalog(sources()).warnings).toHaveLength(1);
    writeGlobal("[]");
    expect(buildCatalog(sources()).warnings).toHaveLength(1);
  });

  it("treats a missing file as no servers, with an empty state and no warning", () => {
    const catalog = buildCatalog(sources());
    expect(catalog.servers).toEqual([]);
    expect(catalog.warnings).toEqual([]);
    expect(allText(catalogView(catalog, { kind: "list", filter: "" }, "es"))).toContain("mcp.json");
  });

  it("marks project and extension servers, and offers no file toggle for them", () => {
    writeGlobal({ mcpServers: { global: { command: "g.exe" } } });
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { mine: { command: "m.exe" } } }),
    );
    const catalog = buildCatalog(
      sources({
        commands: [{ name: "mcp", source: "extension" }],
        registered: [{ name: "reg", config: { url: "https://r.example/mcp" } }],
      }),
    );
    expect(catalog.servers.map((s) => `${s.name}:${s.scope}`)).toEqual([
      "global:global",
      "mine:project",
      "reg:extension",
    ]);
    const of = (name: string): string[] =>
      actionsOf(catalogView(catalog, { kind: "mcp", name }, "en"));
    expect(of("global")).toContain(`${CATALOG_ACTIONS.mcpToggle}global`);
    expect(of("mine")).not.toContain(`${CATALOG_ACTIONS.mcpToggle}mine`);
    expect(of("reg")).not.toContain(`${CATALOG_ACTIONS.mcpToggle}reg`);
    expect(of("global")).toContain(`${CATALOG_ACTIONS.mcpReconnect}global`);
    expect(of("global")).toContain(CATALOG_ACTIONS.mcpManager);
  });

  it("offers no toggle for the Engram entry HARIL rewrites, and says why", () => {
    writeGlobal({ mcpServers: { engram: { command: "engram.exe" } } });
    const view = catalogView(
      buildCatalog(sources({ commands: [{ name: "mcp", source: "extension" }] })),
      { kind: "mcp", name: "engram" },
      "en",
    );
    expect(actionsOf(view)).not.toContain(`${CATALOG_ACTIONS.mcpToggle}engram`);
    expect(allText(view).replace(/\s+/g, " ")).toContain("haril tools ensure");
  });

  it("offers no /mcp action when Pi has no such command", () => {
    writeGlobal({ mcpServers: { one: { command: "o.exe" } } });
    const actions = actionsOf(
      catalogView(buildCatalog(sources()), { kind: "mcp", name: "one" }, "en"),
    );
    expect(actions).not.toContain(CATALOG_ACTIONS.mcpManager);
    expect(actions).not.toContain(`${CATALOG_ACTIONS.mcpReconnect}one`);
  });

  it("filters the list by name or description", () => {
    writeGlobal({ mcpServers: { alpha: { command: "a" }, beta: { command: "b" } } });
    const catalog = buildCatalog(
      sources({
        commands: [
          { name: "skill:one", description: "Handles alpha things", source: "skill" },
          { name: "skill:two", description: "Other", source: "skill" },
        ],
      }),
    );
    const text = allText(catalogView(catalog, { kind: "list", filter: "ALPHA" }, "en"));
    expect(text).toContain("alpha");
    expect(text).toContain("one");
    expect(text).not.toContain("beta");
    expect(text).not.toContain("▸ two");
  });

  it("draws rows the mouse can click and the keyboard menu can list, none past the card", () => {
    writeGlobal({
      mcpServers: { "a-very-long-server-name-that-goes-on-forever": { command: "a" } },
    });
    const view = catalogView(
      buildCatalog(
        sources({
          commands: [{ name: "skill:one", description: "D".repeat(90), source: "skill" }],
        }),
      ),
      { kind: "list", filter: "" },
      "en",
    );
    const flat = flatView(view.cards);
    expect(flat.actions.map(({ action }) => action)).toContain(`${CATALOG_ACTIONS.skill}one`);
    const rail = railRows({ title: "", lines: [], cards: view.cards }, false);
    const row = rail.rows.findIndex((text) => stripAnsi(text).includes("▸ one"));
    expect(rail.hits[row]).toBe(`${CATALOG_ACTIONS.skill}one`);
    for (const card of view.cards) {
      for (const text of card.rows) expect(text.length).toBeLessThanOrEqual(33);
    }
  });
});

describe("setMcpEnabled", () => {
  const path = (): string => join(agentDir, "mcp.json");

  it("keeps every unknown key and the file's indentation", () => {
    writeGlobal({
      autoEnableCodemode: false,
      futureKey: { deep: [1, 2] },
      mcpServers: {
        one: { command: "o", custom: "kept", env: { A: FAKE_SECRET } },
        other: { url: "https://x" },
      },
    });
    expect(setMcpEnabled(path(), "one", false)).toEqual({ ok: true });
    const off = readFileSync(path(), "utf8");
    expect(off.startsWith('{\n    "autoEnableCodemode"')).toBe(true);
    const parsed = JSON.parse(off);
    expect(parsed.autoEnableCodemode).toBe(false);
    expect(parsed.futureKey).toEqual({ deep: [1, 2] });
    expect(parsed.mcpServers.one).toEqual({
      command: "o",
      custom: "kept",
      env: { A: FAKE_SECRET },
      enabled: false,
    });
    expect(parsed.mcpServers.other).toEqual({ url: "https://x" });
    // Pi's own default: turning it back on removes the key.
    expect(setMcpEnabled(path(), "one", true)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(path(), "utf8")).mcpServers.one.enabled).toBeUndefined();
  });

  it("leaves a damaged file byte for byte and refuses a missing entry", () => {
    writeGlobal("{ damaged");
    expect(setMcpEnabled(path(), "one", false)).toEqual({ ok: false, reason: "damaged" });
    expect(readFileSync(path(), "utf8")).toBe("{ damaged");
    writeGlobal({ mcpServers: {} });
    expect(setMcpEnabled(path(), "one", false)).toEqual({ ok: false, reason: "no_entry" });
    rmSync(path());
    expect(setMcpEnabled(path(), "one", false)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("the panel's routes", () => {
  function host() {
    const notes: [string, string | undefined][] = [];
    const inserted: string[] = [];
    const ui = {
      notify: (message: string, level?: string) => notes.push([message, level]),
      confirm: vi.fn(async () => true),
      setEditorText: (text: string) => inserted.push(text),
      input: vi.fn(async (): Promise<string | undefined> => "alpha"),
    };
    const value: ToolsHost = {
      run: async () => ({ ok: true, code: 0, stdout: "{}", stderr: "" }),
      env: () => ({}),
      locale: () => "en",
      ui: () => ui,
      memoryOpen: () => true,
      repaint: () => undefined,
      reload: () => undefined,
      catalog: () =>
        buildCatalog(
          sources({
            commands: [
              { name: "mcp", source: "extension" },
              { name: "skill:one", description: "Skill one", source: "skill" },
            ],
          }),
        ),
    };
    return { value, notes, inserted, ui };
  }

  it("goes home, list, summary, insert and back", async () => {
    const h = host();
    const panel = createToolsPanel(h.value);
    const home = await panel.load();
    expect(home.actions?.map(({ action }) => action)).toContain(CATALOG_ACTIONS.list);
    await panel.act(CATALOG_ACTIONS.list);
    expect(panel.view()?.lines.join("\n")).toContain("one");
    await panel.act(`${CATALOG_ACTIONS.skill}one`);
    expect(panel.view()?.lines.join("\n")).toContain("/skill:one");
    await panel.act(`${CATALOG_ACTIONS.useSkill}one`);
    expect(h.inserted).toEqual(["/skill:one "]);
    await panel.act(CATALOG_ACTIONS.back);
    await panel.act(CATALOG_ACTIONS.back);
    expect(panel.view()?.actions?.map(({ action }) => action)).toContain(CATALOG_ACTIONS.list);
  });

  it("asks before toggling, writes on yes and says when it applies", async () => {
    writeGlobal({ mcpServers: { one: { command: "o" } } });
    const h = host();
    const panel = createToolsPanel(h.value);
    await panel.load();
    await panel.act(`${CATALOG_ACTIONS.mcp}one`);
    await panel.act(`${CATALOG_ACTIONS.mcpToggle}one`);
    expect(h.ui.confirm).toHaveBeenCalledOnce();
    const saved = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    expect(saved.mcpServers.one.enabled).toBe(false);
    expect(h.notes.at(-1)?.[0]).toContain("/reload");
  });

  it("writes nothing when the question is declined, and refuses engram outright", async () => {
    writeGlobal({ mcpServers: { one: { command: "o" }, engram: { command: "e" } } });
    const before = readFileSync(join(agentDir, "mcp.json"), "utf8");
    const h = host();
    h.ui.confirm.mockResolvedValue(false);
    const panel = createToolsPanel(h.value);
    await panel.load();
    await panel.act(`${CATALOG_ACTIONS.mcpToggle}one`);
    h.ui.confirm.mockResolvedValue(true);
    await panel.act(`${CATALOG_ACTIONS.mcpToggle}engram`);
    expect(readFileSync(join(agentDir, "mcp.json"), "utf8")).toBe(before);
  });

  it("keeps the filter the input gave, and clears it with an empty answer", async () => {
    const h = host();
    const panel = createToolsPanel(h.value);
    await panel.load();
    await panel.act(CATALOG_ACTIONS.list);
    await panel.act(CATALOG_ACTIONS.filter);
    expect(panel.view()?.lines.join("\n")).not.toContain("Skill one");
    h.ui.input.mockResolvedValue("");
    await panel.act(CATALOG_ACTIONS.filter);
    expect(panel.view()?.lines.join("\n")).toContain("Skill one");
  });
});

describe("/haril-status", () => {
  it("shows the counts", () => {
    const text = statusLines({
      locale: "en",
      version: "1",
      cwd: "c",
      project: "p",
      mode: "m",
      modelLevel: "l",
      context: "1%",
      cost: "$0",
      runtime: "r",
      memory: "m",
      warnings: [],
      extensions: [],
      contextFiles: [],
      shortcuts: [],
      catalog: { skills: 3, servers: 2, connected: 1 },
    }).join("\n");
    expect(text).toContain("Skills: 3");
    expect(text).toContain("MCP: 2 · 1 connected this session");
  });
});
