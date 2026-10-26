import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostInfo, run } from "../src/cli.js";
import { harness, parseJson } from "./helpers.js";

let root: string;
let privateSettings: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-real-extensions-"));
  privateSettings = join(root, "runtime", "agent", "settings.json");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function host(): HostInfo {
  return {
    nodeVersion: "v24.21.0",
    platform: "linux",
    arch: "x64",
    homeDir: root,
    cwd: root,
    env: { HARIL_RUNTIME_DIR: join(root, "runtime") },
  };
}

function setSettings(text: string): void {
  mkdirSync(join(root, "runtime", "agent"), { recursive: true });
  writeFileSync(privateSettings, text);
}

async function cli(...args: string[]) {
  const h = harness();
  const code = await run(["extensions", ...args], h.io, host());
  return { code, ...h };
}

describe("HARIL's private Pi package extension configuration", () => {
  it("reports no configured packages without creating settings or claiming installation", async () => {
    const result = await cli("list", "--json");
    expect(result.code).toBe(0);
    expect(parseJson(result.out)).toMatchObject({
      scope: "haril-private-pi-agent",
      installedOrLoaded: "unknown",
      packages: [],
    });
    expect(existsSync(privateSettings)).toBe(false);
  });

  it("disables and re-enables one source while preserving unrelated Pi settings and CRLF", async () => {
    setSettings(
      '{\r\n  "theme": "dark",\r\n  "packages": ["git:github.com/CinloDev/pi-youtube-player", {"source":"npm:other", "themes": []}]\r\n}\r\n',
    );
    const source = "git:github.com/CinloDev/pi-youtube-player";
    expect((await cli("disable", source)).code).toBe(2);
    expect((await cli("disable", source, "--yes")).code).toBe(0);
    let doc = JSON.parse(readFileSync(privateSettings, "utf8"));
    expect(doc).toMatchObject({
      theme: "dark",
      packages: [
        { source, extensions: [] },
        { source: "npm:other", themes: [] },
      ],
    });
    expect(readFileSync(privateSettings, "utf8")).toContain("\r\n");
    expect((await cli("enable", source, "--yes")).code).toBe(0);
    doc = JSON.parse(readFileSync(privateSettings, "utf8"));
    expect(doc.packages[0]).toBe(source);
    expect(doc.packages[1].themes).toEqual([]);
  });

  it("does not erase a custom filter or permit duplicate sources", async () => {
    const raw = JSON.stringify({
      packages: [
        { source: "npm:filtered", extensions: ["src/*.ts"] },
        "npm:duplicate",
        { source: "npm:duplicate", extensions: [] },
      ],
    });
    setSettings(raw);
    expect((await cli("disable", "npm:filtered", "--yes")).code).toBe(2);
    expect((await cli("enable", "npm:duplicate", "--yes")).code).toBe(2);
    expect(readFileSync(privateSettings, "utf8")).toBe(raw);
  });

  it("rejects malformed JSON, invalid packages, unknown sources and unexpected arguments", async () => {
    setSettings("invalid json");
    expect((await cli("list")).code).toBe(2);
    setSettings('{"packages":[{"source":"npm:foo","extensions":"all"}]}');
    expect((await cli("disable", "npm:foo", "--yes")).code).toBe(2);
    setSettings('{"packages":["npm:foo"]}');
    expect((await cli("disable", "npm:bar", "--yes")).code).toBe(2);
    expect((await cli("list", "extra")).code).toBe(2);
    expect(readFileSync(privateSettings, "utf8")).toBe('{"packages":["npm:foo"]}');
  });

  it("never reads or edits project-local Pi settings", async () => {
    const project = join(root, ".pi", "settings.json");
    mkdirSync(join(root, ".pi"));
    writeFileSync(project, '{"packages":["npm:project-only"]}');
    expect((await cli("list", "--json")).code).toBe(0);
    expect((await cli("disable", "npm:project-only", "--yes")).code).toBe(2);
    expect(readFileSync(project, "utf8")).toContain("npm:project-only");
    expect(existsSync(privateSettings)).toBe(false);
  });
});
