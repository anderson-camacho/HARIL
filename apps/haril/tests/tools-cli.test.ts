import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { type ToolsServices, tools } from "../src/commands/tools.js";
import type { HostInfo } from "../src/context.js";
import { defaultEngramBinary } from "../src/memory-config.js";
import { emptyToolsState, type ToolsState } from "../src/tools/state.js";
import type { ToolStatus, ToolsReport } from "../src/tools/types.js";
import { VERSION } from "../src/version.js";
import { harness, parseJson } from "./helpers.js";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");

function hostWith(env: Record<string, string> = {}): HostInfo {
  return {
    nodeVersion: "v24.21.0",
    platform: "linux",
    arch: "x64",
    homeDir: "/home/ana",
    env: { HARIL_RUNTIME_DIR: "/data/haril", PATH: "/usr/local/bin", ...env },
  };
}

const HOST = hostWith();
const COPY = defaultEngramBinary(HOST);

interface Calls {
  urls: string[];
  saved: ToolsState[];
}

// Fakes for the filesystem, the processes, the network and the clock; `versions` maps an existing file to its version.
function services(
  versions: Record<string, string>,
  options: { state?: ToolsState; tags?: Record<string, string> } = {},
): ToolsServices & { calls: Calls } {
  const calls: Calls = { urls: [], saved: [] };
  const tags = options.tags ?? { engram: "v3.6.0", "gentle-ai": "v4.3.1" };
  let state = options.state ?? emptyToolsState();
  return {
    calls,
    detect: {
      isFile: (path) => path in versions,
      realPath: (path) => path,
      readVersion: async (path) => {
        const version = versions[path];
        return version === undefined ? { error: "no version" } : { version };
      },
    },
    fetch: async (url) => {
      calls.urls.push(url);
      const tool = url.includes("/engram/") ? "engram" : "gentle-ai";
      return {
        status: 302,
        headers: new Headers({
          location: `https://github.com/x/${tool}/releases/tag/${tags[tool]}`,
        }),
        body: null,
      };
    },
    now: () => NOW,
    readState: () => state,
    writeState: (next) => {
      calls.saved.push(next);
      state = next;
    },
  };
}

// What the expected machine looks like: no HARIL copy of Engram, Engram 3.3.2 and gentle-ai 4.0.0 in the Go bin dir.
const THIS_MACHINE = {
  "/home/ana/go/bin/engram": "3.3.2",
  "/home/ana/go/bin/gentle-ai": "4.0.0",
};

async function cli(args: string[], svc: ToolsServices, host: HostInfo = HOST) {
  const h = harness();
  const code = await tools(args, h.io, host, svc);
  return { code, out: h.out, err: h.err };
}

describe("haril tools status", () => {
  it("prints one block per tool from local detection and never touches the network by default", async () => {
    const svc = services({ [COPY]: "3.6.0", ...THIS_MACHINE });
    const { code, out, err } = await cli(["status"], svc);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(svc.calls.urls).toEqual([]);
    const text = out.join("\n");
    expect(out[0]).toBe(`haril ${VERSION} tools status`);
    expect(text).toContain("engram: ok");
    expect(text).toContain(`${COPY}  3.6.0  (haril)`);
    expect(text).toContain("qualified   3.6.0");
    expect(text).toContain("/home/ana/go/bin/engram  3.3.2  (go-bin; not used by HARIL)");
    expect(text).toContain("installed in 2 places with different versions: 3.6.0, 3.3.2");
    expect(text).toContain("gentle-ai: unknown");
    expect(text).toContain("/home/ana/go/bin/gentle-ai  4.0.0  (go-bin)");
    expect(text).toContain("tools status --refresh");
  });

  it("reports Engram as missing, with the Go-bin copy listed as unused", async () => {
    const svc = services(THIS_MACHINE);
    const text = (await cli(["status"], svc)).out.join("\n");
    expect(text).toContain("engram: missing");
    expect(text).toContain("active      none");
    expect(text).toContain("/home/ana/go/bin/engram  3.3.2  (go-bin; not used by HARIL)");
    expect(text).toContain("npm run memory:install");
  });

  it("looks the latest versions up with --refresh and saves them", async () => {
    const svc = services({ [COPY]: "3.6.0", ...THIS_MACHINE });
    const { code, out } = await cli(["status", "--refresh"], svc);
    expect(code).toBe(0);
    expect(svc.calls.urls).toHaveLength(2);
    expect(svc.calls.saved).toHaveLength(1);
    const text = out.join("\n");
    expect(text).toContain("gentle-ai: outdated");
    expect(text).toContain("latest      4.3.1  (checked 2026-10-30T12:00:00.000Z)");
  });

  it("prints a single JSON object with stable keys and ISO timestamps with --json", async () => {
    const svc = services({ [COPY]: "3.6.0", ...THIS_MACHINE });
    const { code, out } = await cli(["status", "--json", "--refresh"], svc);
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const report = parseJson<ToolsReport>(out);
    expect(report.schema).toBe("haril.tools.status/1");
    expect(report.generatedAt).toBe("2026-10-30T12:00:00.000Z");
    expect(report.tools.map((tool) => tool.id)).toEqual(["engram", "gentle-ai"]);
    const keys = [
      "active",
      "id",
      "installs",
      "latest",
      "latestCheckedAt",
      "newerUpstream",
      "notes",
      "qualified",
      "state",
    ];
    for (const tool of report.tools) expect(Object.keys(tool).sort()).toEqual(keys);
    const gentle = report.tools[1] as ToolStatus;
    expect(gentle).toMatchObject({
      state: "outdated",
      latest: "4.3.1",
      latestCheckedAt: "2026-10-30T12:00:00.000Z",
      qualified: null,
      newerUpstream: false,
    });
    expect(gentle.active).toMatchObject({
      path: "/home/ana/go/bin/gentle-ai",
      version: "4.0.0",
      origin: "go-bin",
      active: true,
    });
    expect(Object.keys(gentle.active ?? {}).sort()).toEqual([
      "active",
      "origin",
      "origins",
      "path",
      "version",
      "versionError",
    ]);
  });

  it("serves the cached latest version offline in --json", async () => {
    const state: ToolsState = {
      version: 1,
      tools: { "gentle-ai": { latest: "4.3.1", latestCheckedAt: "2026-10-30T09:00:00.000Z" } },
    };
    const svc = services({ [COPY]: "3.6.0", ...THIS_MACHINE }, { state });
    const report = parseJson<ToolsReport>((await cli(["status", "--json"], svc)).out);
    expect(svc.calls.urls).toEqual([]);
    expect(report.tools[1]).toMatchObject({ state: "outdated", latest: "4.3.1" });
  });

  it("answers --json for an unreadable haril.json with a note and the default Engram path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "haril-tools-cli-"));
    try {
      const config = join(dir, "haril.json");
      writeFileSync(config, "{ nope");
      const host = hostWith({ HARIL_CONFIG: config });
      const svc = services({ [defaultEngramBinary(host)]: "3.6.0" });
      const { code, out } = await cli(["status", "--json"], svc, host);
      expect(code).toBe(0);
      const engram = parseJson<ToolsReport>(out).tools[0] as ToolStatus;
      expect(engram.state).toBe("ok");
      expect(engram.notes.join("\n")).toContain("haril.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats memory.binary as the install that runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "haril-tools-cli-"));
    try {
      const binary = join(dir, "engram-custom");
      const config = join(dir, "haril.json");
      writeFileSync(config, JSON.stringify({ memory: { provider: "null", binary } }));
      const host = hostWith({ HARIL_CONFIG: config });
      const svc = services({ [binary]: "3.6.0" });
      const engram = parseJson<ToolsReport>((await cli(["status", "--json"], svc, host)).out)
        .tools[0] as ToolStatus;
      expect(engram.state).toBe("ok");
      expect(engram.active).toMatchObject({ path: binary, origin: "config" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("haril tools usage errors", () => {
  const USAGE = "usage: haril tools status [--json] [--refresh]";

  it("needs a subcommand", async () => {
    const { code, out, err } = await cli([], services({}));
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err).toEqual(["haril: tools needs a subcommand", USAGE]);
  });

  it("refuses an unknown subcommand", async () => {
    const { code, err } = await cli(["ensure"], services({}));
    expect(code).toBe(2);
    expect(err).toEqual(['haril: unknown tools subcommand "ensure"', USAGE]);
  });

  it("refuses extra arguments", async () => {
    const { code, err } = await cli(["status", "extra"], services({}));
    expect(code).toBe(2);
    expect(err).toEqual([USAGE]);
  });

  it("refuses an unknown option", async () => {
    const { code, err } = await cli(["status", "--now"], services({}));
    expect(code).toBe(2);
    expect(err).toEqual(['haril: unknown option "--now"']);
  });
});

describe("haril tools through the CLI dispatcher", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "haril-tools-run-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is registered, and on a machine with neither tool reports both missing offline", async () => {
    const host: HostInfo = {
      nodeVersion: "v24.21.0",
      platform: process.platform,
      arch: process.arch,
      homeDir: root,
      // No PATH and an empty home: nothing can be found, and nothing is fetched without --refresh.
      env: { HARIL_RUNTIME_DIR: join(root, "runtime") },
    };
    const h = harness();
    const code = await run(["tools", "status", "--json"], h.io, host);
    expect(code).toBe(0);
    const report = parseJson<ToolsReport>(h.out);
    expect(report.tools.map((tool) => [tool.id, tool.state])).toEqual([
      ["engram", "missing"],
      ["gentle-ai", "missing"],
    ]);
  });

  it("returns the usage exit code for an unknown subcommand", async () => {
    const h = harness();
    const code = await run(["tools", "bogus"], h.io, hostWith());
    expect(code).toBe(2);
    expect(h.err[0]).toBe('haril: unknown tools subcommand "bogus"');
  });
});
