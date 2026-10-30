import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostInfo, run } from "../src/cli.js";
import { harness, parseJson } from "./helpers.js";

// `docs.path` (the DOCS tab of the panel): the folder with the user's documentation, an Obsidian vault kept outside
// HARIL. HARIL stores the path and only reads the folder. `haril config set docs.path` needs an existing directory at
// the moment it is set; loading haril.json never looks at the folder; doctor warns, never fails, when it is gone.

let root: string;
let vault: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-docs-config-"));
  vault = join(root, "vault");
  mkdirSync(vault);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function hostFor(configPath: string): HostInfo {
  return {
    nodeVersion: "v24.21.0",
    platform: "linux",
    arch: "x64",
    homeDir: root,
    cwd: root,
    env: { HARIL_HOME: join(root, "data"), HARIL_CONFIG: configPath },
    providerProbe: async () => [],
    inspectRuntime: (runtimeRoot) => ({
      status: "warn",
      root: runtimeRoot,
      manifest: join(runtimeRoot, "manifest.json"),
      detail: "not installed",
    }),
  };
}

function writeConfig(text: string): string {
  const path = join(root, "haril.json");
  writeFileSync(path, text);
  return path;
}

async function cli(args: string[], configPath: string) {
  const h = harness();
  const code = await run(args, h.io, hostFor(configPath));
  return { code, out: h.out, err: h.err };
}

const document = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("haril config get docs.path", () => {
  it("says the folder is not set when nothing is connected, like any other key outside the defaults", async () => {
    const path = writeConfig("{}");
    expect((await cli(["config", "get", "docs.path"], path)).out).toEqual(["docs.path is not set"]);
    expect(parseJson((await cli(["config", "get", "docs.path", "--json"], path)).out)).toEqual({
      path: "docs.path",
      value: null,
      source: "unset",
      configPath: path,
    });
  });

  it("shows the connected folder and its source", async () => {
    const path = writeConfig(JSON.stringify({ docs: { path: vault } }));
    expect((await cli(["config", "get", "docs.path"], path)).out).toEqual([
      `docs.path = ${JSON.stringify(vault)}  (haril.json)`,
    ]);
    expect(parseJson((await cli(["config", "get", "docs.path", "--json"], path)).out)).toEqual({
      path: "docs.path",
      value: vault,
      source: "file",
      configPath: path,
    });
  });

  it("reports the problems of the docs section instead of a value", async () => {
    const path = writeConfig(JSON.stringify({ docs: { path: "relativo" } }));
    const got = await cli(["config", "get", "docs.path"], path);
    expect(got.code).toBe(2);
    expect(got.err.join("\n")).toContain("/docs/path: must be an absolute path");
  });
});

describe("haril config set docs.path", () => {
  it("stores an existing directory, keeps every other key and says what it changed", async () => {
    const path = writeConfig(
      `${JSON.stringify({ ui: { locale: "en" }, delegation: { limits: { maxAuditRetries: 0 } } }, null, 2)}\n`,
    );
    const set = await cli(["config", "set", "docs.path", vault, "--json"], path);
    expect(set.code).toBe(0);
    expect(parseJson(set.out)).toMatchObject({
      path: "docs.path",
      previous: { value: null, source: "unset" },
      value: vault,
      source: "file",
      written: true,
      configPath: path,
    });
    expect(document(path)).toEqual({
      ui: { locale: "en" },
      delegation: { limits: { maxAuditRetries: 0 } },
      docs: { path: vault },
    });
    const text = await cli(["config", "set", "docs.path", vault], path);
    expect(text.code).toBe(0);
    expect(text.out.join("\n")).toContain(`unchanged ${path}`);
  });

  it("trims the text and takes off the quotes that 'copy as path' adds, keeping the user's separators", async () => {
    const path = writeConfig("{}");
    expect((await cli(["config", "set", "docs.path", `  "${vault}"  `], path)).code).toBe(0);
    expect(document(path)).toEqual({ docs: { path: vault } });
  });

  it("creates the file when there is none", async () => {
    const path = join(root, "config", "haril.json");
    expect((await cli(["config", "set", "docs.path", vault], path)).code).toBe(0);
    expect(document(path)).toEqual({ docs: { path: vault } });
  });

  it("--reset disconnects the folder and drops the empty section", async () => {
    const path = writeConfig(JSON.stringify({ ui: { locale: "en" }, docs: { path: vault } }));
    const reset = await cli(["config", "set", "docs.path", "--reset", "--json"], path);
    expect(reset.code).toBe(0);
    expect(parseJson(reset.out)).toMatchObject({
      path: "docs.path",
      previous: { value: vault, source: "file" },
      value: null,
      source: "unset",
      written: true,
    });
    expect(document(path)).toEqual({ ui: { locale: "en" } });
    expect((await cli(["config", "get", "docs.path"], path)).out).toEqual(["docs.path is not set"]);
  });

  it("--reset works even when the folder is gone, and without a file", async () => {
    const path = writeConfig(JSON.stringify({ docs: { path: join(root, "desaparecida") } }));
    expect((await cli(["config", "set", "docs.path", "--reset"], path)).code).toBe(0);
    expect(document(path)).toEqual({});
    const none = join(root, "otra", "haril.json");
    expect((await cli(["config", "set", "docs.path", "--reset"], none)).code).toBe(0);
  });

  it("refuses a relative path, naming the field, and leaves the file as it was", async () => {
    const original = JSON.stringify({ ui: { locale: "en" } });
    const path = writeConfig(original);
    for (const bad of ["vault", "./vault", "~/vault"]) {
      const refused = await cli(["config", "set", "docs.path", bad], path);
      expect(refused.code).toBe(2);
      expect(refused.err.join("\n")).toContain("/docs/path: must be an absolute path");
      expect(readFileSync(path, "utf8")).toBe(original);
    }
  });

  it("refuses an empty value", async () => {
    const original = "{}";
    const path = writeConfig(original);
    const refused = await cli(["config", "set", "docs.path", "   "], path);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toContain("/docs/path");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("refuses a folder that does not exist and says so, instead of storing a typo", async () => {
    const original = "{}";
    const path = writeConfig(original);
    const missing = join(root, "boveda-que-no-existe");
    const refused = await cli(["config", "set", "docs.path", missing], path);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toContain(`${missing} is not an existing directory`);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("refuses a file where a folder is expected", async () => {
    const original = "{}";
    const path = writeConfig(original);
    const file = join(vault, "nota.md");
    writeFileSync(file, "# nota\n");
    const refused = await cli(["config", "set", "docs.path", file], path);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toContain(`${file} is a file, not a directory`);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("needs exactly one value, or --reset", async () => {
    const path = writeConfig("{}");
    expect((await cli(["config", "set", "docs.path"], path)).code).toBe(2);
    expect((await cli(["config", "set", "docs.path", vault, "otro"], path)).code).toBe(2);
    expect((await cli(["config", "set", "docs.path", vault, "--reset"], path)).code).toBe(2);
  });

  it("does not open any other key for writing, and says what can be set", async () => {
    const path = writeConfig("{}");
    const refused = await cli(["config", "set", "docs.other", "x"], path);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toContain("docs.path");
    const usage = await cli(["config", "set"], path);
    expect(usage.err.join("\n")).toContain("docs.path");
  });
});

describe("a haril.json with and without the docs section", () => {
  it("loads a legacy file that has no docs section exactly as before", async () => {
    const path = writeConfig(JSON.stringify({ ui: { locale: "en" } }));
    const doctor = await cli(["doctor", "--json"], path);
    const json = parseJson<{ providers: { status: string }; docs: unknown }>(doctor.out);
    expect(json.providers.status).not.toBe("error");
    expect(json.docs).toEqual({ status: "ok", connected: false, path: null });
    expect((await cli(["config", "set", "ui.locale", "es"], path)).code).toBe(0);
  });

  it("loads a file whose folder is gone: the folder is not looked at when the file is read", async () => {
    const path = writeConfig(JSON.stringify({ docs: { path: join(root, "desconectada") } }));
    const doctor = await cli(["doctor", "--json"], path);
    const json = parseJson<{ providers: { status: string; errors?: string[] } }>(doctor.out);
    expect(json.providers.errors).toBeUndefined();
    expect((await cli(["config", "set", "ui.locale", "en"], path)).code).toBe(0);
  });

  it("refuses a docs section with an unknown key or a relative path, like any reader of the file", async () => {
    const path = writeConfig(JSON.stringify({ docs: { path: "relativa", extra: 1 } }));
    const doctor = await cli(["doctor", "--json"], path);
    const json = parseJson<{
      providers: { status: string; errors: string[] };
      docs: { status: string; errors: string[] };
    }>(doctor.out);
    expect(json.providers.status).toBe("error");
    expect(json.providers.errors).toEqual(
      expect.arrayContaining([
        "/docs/extra: unknown key",
        "/docs/path: must be an absolute path (for example D:\\Vault or /home/ana/vault)",
      ]),
    );
    expect(json.docs.status).toBe("error");
    expect(json.docs.errors).toEqual(json.providers.errors);
  });
});

describe("haril doctor and the docs folder", () => {
  it("says the folder is not connected, and that this is not a problem", async () => {
    const path = writeConfig("{}");
    const text = await cli(["doctor"], path);
    expect(text.out.join("\n")).toMatch(/\n {2}docs\s+ok\s+not connected\n/);
    const json = parseJson<{ docs: unknown }>((await cli(["doctor", "--json"], path)).out);
    expect(json.docs).toEqual({ status: "ok", connected: false, path: null });
  });

  it("is ok with the path when the folder is a directory", async () => {
    const path = writeConfig(JSON.stringify({ docs: { path: vault } }));
    const text = await cli(["doctor"], path);
    expect(text.out.join("\n")).toContain(`  docs      ok  ${vault}`);
    const json = parseJson<{ docs: unknown }>((await cli(["doctor", "--json"], path)).out);
    expect(json.docs).toEqual({ status: "ok", connected: true, path: vault });
  });

  it("warns, never fails, when the folder is missing or is not a directory", async () => {
    const missing = join(root, "desconectada");
    const path = writeConfig(JSON.stringify({ docs: { path: missing } }));
    const text = await cli(["doctor"], path);
    expect(text.out.join("\n")).toContain(`  docs      warn  ${missing}  folder not found`);
    const json = parseJson<{ status: string; docs: unknown }>(
      (await cli(["doctor", "--json"], path)).out,
    );
    expect(json.docs).toEqual({
      status: "warn",
      connected: true,
      path: missing,
      detail: "folder not found",
    });
    expect(json.status).not.toBe("error");
    expect(text.code).toBe(1);

    const file = join(vault, "nota.md");
    writeFileSync(file, "# nota\n");
    writeFileSync(path, JSON.stringify({ docs: { path: file } }));
    const second = parseJson<{ docs: unknown }>((await cli(["doctor", "--json"], path)).out);
    expect(second.docs).toEqual({
      status: "warn",
      connected: true,
      path: file,
      detail: "not a directory",
    });
  });
});
