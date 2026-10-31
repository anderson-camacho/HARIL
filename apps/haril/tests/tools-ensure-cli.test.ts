import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ToolsServices, tools } from "../src/commands/tools.js";
import type { HostInfo } from "../src/context.js";
import { ENGRAM_VERSION } from "../src/memory-config.js";
import type { EnsureOutcome } from "../src/tools/ensure.js";
import { engramAsset } from "../src/tools/release.js";
import type { ToolsReport } from "../src/tools/types.js";
import { VERSION } from "../src/version.js";
import { harness, parseJson } from "./helpers.js";

const PIN = ENGRAM_VERSION;
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const BINARY = process.platform === "win32" ? "engram.exe" : "engram";
const ASSET = engramAsset(PIN, process.platform, process.arch);

interface EnsureJson {
  schema: string;
  engram?: EnsureOutcome["engram"];
  gentleAi?: { action: string; message?: string };
  status: ToolsReport;
}

describe("haril tools ensure", () => {
  let root: string;
  let host: HostInfo;
  let urls: string[];
  let latestUrls: string[];
  let checksum: "ok" | "bad";
  let shared: ToolsServices;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "haril-ensure-cli-")));
    mkdirSync(join(root, "home"));
    host = {
      nodeVersion: "v24.21.0",
      platform: process.platform,
      arch: process.arch,
      homeDir: join(root, "home"),
      env: { HARIL_RUNTIME_DIR: join(root, "runtime"), HARIL_HOME: join(root, "data") },
    };
    urls = [];
    latestUrls = [];
    checksum = "ok";
    shared = services();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const copyPath = () => join(root, "runtime", "vendor", "engram", PIN, BINARY);

  function services(): ToolsServices {
    const archive = Buffer.from(`archive-of engram ${PIN}`);
    const digest = createHash("sha256").update(archive).digest("hex");
    let state = { version: 1 as const, tools: {} };
    return {
      detect: {
        isFile: (path) => {
          try {
            return statSync(path).isFile();
          } catch {
            return false;
          }
        },
        realPath: (path) => path,
        readVersion: async (path) => {
          const version = /^engram (\d+\.\d+\.\d+)$/.exec(readFileSync(path, "utf8").trim())?.[1];
          return version === undefined ? { error: "exit 1" } : { version };
        },
      },
      fetch: async (url) => {
        latestUrls.push(url);
        const tool = url.includes("/engram/") ? "engram" : "gentle-ai";
        const tag = tool === "engram" ? `v${PIN}` : "v4.3.1";
        return {
          status: 302,
          headers: new Headers({ location: `https://github.com/x/${tool}/releases/tag/${tag}` }),
          body: null,
        };
      },
      now: () => NOW,
      readState: () => state,
      writeState: (next) => {
        state = next as typeof state;
      },
      ensure: {
        download: async (url) => {
          urls.push(url);
          if (url.endsWith("checksums.txt")) {
            const sum = checksum === "ok" ? digest : "0".repeat(64);
            return new Response(`${sum}  ${ASSET?.name}\n`, { status: 200 });
          }
          return new Response(archive, { status: 200 });
        },
        exec: async (file) => ({
          code: 0,
          output: `${readFileSync(file, "utf8")}\n`,
          timedOut: false,
        }),
        extract: async ({ archive: path, destDir, binary }) => {
          mkdirSync(destDir, { recursive: true });
          const target = join(destDir, binary);
          writeFileSync(target, readFileSync(path, "utf8").replace(/^archive-of /, ""));
          return { ok: true, path: target };
        },
        smoke: async () => ({ ok: true }),
      },
    };
  }

  async function cli(args: string[], svc: ToolsServices = shared) {
    const h = harness();
    const code = await tools(args, h.io, host, svc);
    return { code, out: h.out, err: h.err };
  }

  it("installs a missing Engram and prints the action, then the status blocks", async () => {
    const { code, out, err } = await cli(["ensure"]);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe(`haril ${VERSION} tools ensure`);
    const text = out.join("\n");
    expect(text).toContain(`engram: installed ${PIN}`);
    expect(text).toContain(copyPath());
    expect(text).toContain("engram: ok");
    expect(text).toContain("gentle-ai: missing");
    expect(existsSync(copyPath())).toBe(true);
  });

  it("does nothing the second time", async () => {
    await cli(["ensure"]);
    urls.length = 0;
    const { code, out } = await cli(["ensure"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`engram: up to date (${PIN})`);
    expect(urls).toEqual([]);
  });

  it("prints one JSON document with the ensure schema, the action and the status", async () => {
    const { code, out } = await cli(["ensure", "--json"]);
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const json = parseJson<EnsureJson>(out);
    expect(json.schema).toBe("haril.tools.ensure/1");
    expect(json.engram).toMatchObject({ action: "installed", to: PIN, path: copyPath() });
    expect(json.status.schema).toBe("haril.tools.status/1");
    expect(json.status.tools[0]).toMatchObject({ id: "engram", state: "ok" });
    expect(Object.keys(json).sort()).toEqual(["engram", "schema", "status"]);
  });

  it("treats `ensure engram` like `ensure`", async () => {
    const { code, out } = await cli(["ensure", "engram", "--json"]);
    expect(code).toBe(0);
    expect(parseJson<EnsureJson>(out).engram?.action).toBe("installed");
  });

  it("exits 1 and still prints the JSON when the install fails", async () => {
    checksum = "bad";
    const { code, out } = await cli(["ensure", "--json"]);
    expect(code).toBe(1);
    const json = parseJson<EnsureJson>(out);
    expect(json.engram?.action).toBe("failed");
    expect(json.engram?.message).toContain("checksum");
    expect(existsSync(copyPath())).toBe(false);
  });

  it("prints the reason in the human output when it fails", async () => {
    checksum = "bad";
    const { code, out } = await cli(["ensure"]);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("engram: failed");
    expect(out.join("\n")).toContain("checksum");
  });

  it("does not retry inside the cooldown, and --force does", async () => {
    checksum = "bad";
    await cli(["ensure"]);
    checksum = "ok";
    urls.length = 0;
    const blocked = await cli(["ensure", "--json"]);
    expect(blocked.code).toBe(1);
    expect(parseJson<EnsureJson>(blocked.out).engram?.message).toContain("--force");
    expect(urls).toEqual([]);
    const forced = await cli(["ensure", "--force", "--json"]);
    expect(forced.code).toBe(0);
    expect(parseJson<EnsureJson>(forced.out).engram?.action).toBe("installed");
  });

  it("exits 0 when another ensure holds the lock and says busy", async () => {
    const lock = join(root, "runtime", "state", "tools.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "{}");
    const { code, out } = await cli(["ensure", "--json"]);
    expect(code).toBe(0);
    expect(parseJson<EnsureJson>(out).engram?.action).toBe("busy");
  });

  it("for gentle-ai only detects and refreshes the latest version", async () => {
    const { code, out } = await cli(["ensure", "gentle-ai", "--json"]);
    expect(code).toBe(0);
    const json = parseJson<EnsureJson>(out);
    expect(json.engram).toBeUndefined();
    expect(json.gentleAi).toMatchObject({ action: "none" });
    expect(urls).toEqual([]);
    expect(existsSync(copyPath())).toBe(false);
    expect(latestUrls.some((url) => url.includes("/gentle-ai/"))).toBe(true);
    expect(json.status.tools[1]).toMatchObject({ id: "gentle-ai", latest: "4.3.1" });
  });

  it("refuses an unknown tool, extra arguments and unknown options with exit 2", async () => {
    const ensureUsage = "usage: haril tools ensure [engram|gentle-ai] [--json] [--force]";
    const unknownTool = await cli(["ensure", "bogus"]);
    expect(unknownTool.code).toBe(2);
    expect(unknownTool.err).toEqual([ensureUsage]);
    const extra = await cli(["ensure", "engram", "gentle-ai"]);
    expect(extra.code).toBe(2);
    expect(extra.err).toEqual([ensureUsage]);
    const option = await cli(["ensure", "--now"]);
    expect(option.code).toBe(2);
    expect(option.err).toEqual(['haril: unknown option "--now"']);
    expect(urls).toEqual([]);
    expect(existsSync(copyPath())).toBe(false);
  });
});
