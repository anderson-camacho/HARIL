import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostInfo, run } from "../src/cli.js";
import {
  extensions,
  type PiPackageProcess,
  validPiPackageSource,
} from "../src/commands/extensions.js";
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

function fakeRuntime(): void {
  const dir = join(root, "runtime", "runtime");
  mkdirSync(dir, { recursive: true });
  const cli = join(dir, "pi-cli.mjs");
  writeFileSync(cli, "// no network or package code is executed in tests\n");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      node: { version: process.version, path: process.execPath },
      pi: { version: "test", cliPath: cli },
    }),
  );
}

async function cli(...args: string[]) {
  const h = harness();
  const code = await run(["extensions", ...args], h.io, host());
  return { code, ...h };
}

describe("HARIL's private Pi package extension configuration", () => {
  it("accepts only strict npm/GitHub package sources", () => {
    expect(validPiPackageSource("npm:@scope/hello@1.0.0")).toBe(true);
    expect(validPiPackageSource("git:github.com/CinloDev/pi-cinlodev-cute")).toBe(true);
    for (const source of [
      "https://malware.example/test",
      "./local-script",
      "git:evil.example/payload",
      "git:github.com/owner/repo --local",
      "--local",
      "npm:some-package;whoami",
    ]) {
      expect(validPiPackageSource(source)).toBe(false);
    }
  });

  it("delegates explicitly confirmed installs to HARIL's own Pi runtime and private agent", async () => {
    fakeRuntime();
    const seen: PiPackageProcess[] = [];
    const h = harness();
    const source = "git:github.com/CinloDev/pi-youtube-player";
    const command = (args: string[]) =>
      extensions(args, h.io, host(), async (input) => {
        seen.push(input);
        return { code: 0, stdout: "Installed", stderr: "" };
      });
    expect(await command(["install", source])).toBe(2);
    expect(await command(["install", "./evil", "--yes"])).toBe(2);
    expect(seen).toHaveLength(0);
    expect(await command(["install", source, "--yes", "--json"])).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      cwd: join(root, "runtime"),
      args: ["install", source],
      env: { PI_CODING_AGENT_DIR: join(root, "runtime", "agent") },
    });
    expect(seen[0]?.node).toBe(process.execPath);
    expect(JSON.parse(h.out.at(-1) ?? "{}")).toMatchObject({
      operation: "install",
      source,
      completed: true,
    });
    expect(existsSync(join(root, ".pi", "settings.json"))).toBe(false);
  });

  it("allows removal only of one exactly configured source and rejects failed commands", async () => {
    fakeRuntime();
    const source = "npm:@scope/installed";
    setSettings(JSON.stringify({ theme: "dark", packages: [source] }));
    const before = readFileSync(privateSettings, "utf8");
    const h = harness();
    let called = 0;
    const runRemove = (args: string[]) =>
      extensions(args, h.io, host(), async () => {
        called += 1;
        return { code: 1, stderr: "offline", stdout: "" };
      });
    expect(await runRemove(["remove", source])).toBe(2);
    expect(await runRemove(["remove", "npm:unlisted", "--yes"])).toBe(2);
    expect(await runRemove(["install", source, "--yes"])).toBe(2);
    expect(called).toBe(0);
    expect(await runRemove(["remove", source, "--yes"])).toBe(2);
    expect(called).toBe(1);
    expect(h.err.join("\n")).toContain("offline");
    expect(readFileSync(privateSettings, "utf8")).toBe(before);
  });

  it("refuses package installation when the bundled Pi runtime is absent", async () => {
    const h = harness();
    let called = 0;
    const code = await extensions(["install", "npm:good", "--yes"], h.io, host(), async () => {
      called += 1;
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(code).toBe(2);
    expect(called).toBe(0);
    expect(h.err.join("\n")).toContain("runtime unavailable");
  });
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
