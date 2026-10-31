import { describe, expect, it } from "vitest";
import type { DetectDeps } from "../src/tools/detect.js";
import type { LatestFetch } from "../src/tools/latest.js";
import { emptyToolsState, type ToolsState } from "../src/tools/state.js";
import {
  buildToolStatus,
  collectToolsReport,
  type LatestView,
  type ToolsDeps,
  type ToolsInput,
} from "../src/tools/status.js";
import type {
  Install,
  InstallOrigin,
  ToolId,
  ToolStatus,
  ToolsReport,
} from "../src/tools/types.js";

const PIN = "3.6.0";
const HARIL_COPY = "/data/haril/vendor/engram/3.6.0/engram";
const NO_LATEST: LatestView = { latest: null, checkedAt: null, notes: [] };
const latest = (version: string): LatestView => ({
  latest: version,
  checkedAt: "2026-10-30T10:00:00.000Z",
  notes: [],
});

function install(
  path: string,
  version: string | null,
  active: boolean,
  origins: InstallOrigin[] = ["path"],
  versionError: string | null = version === null ? "timed out" : null,
): Install {
  return { path, origin: origins[0] ?? "path", origins, version, versionError, active };
}

const context = { pin: PIN, runtimeBinary: HARIL_COPY };

describe("classifying engram", () => {
  const cases: [string, Install[], LatestView, string, boolean][] = [
    ["the HARIL copy is missing", [], NO_LATEST, "missing", false],
    [
      "only other installs exist, none is the HARIL copy",
      [install("/home/ana/go/bin/engram", "3.3.2", false, ["go-bin"])],
      NO_LATEST,
      "missing",
      false,
    ],
    [
      "the HARIL copy is older than the pin",
      [install(HARIL_COPY, "3.5.0", true, ["haril"])],
      NO_LATEST,
      "outdated",
      false,
    ],
    [
      "the HARIL copy is the pin",
      [install(HARIL_COPY, "3.6.0", true, ["haril"])],
      latest("3.6.0"),
      "ok",
      false,
    ],
    [
      "the HARIL copy is newer than the pin",
      [install(HARIL_COPY, "3.7.0", true, ["haril"])],
      NO_LATEST,
      "ok",
      false,
    ],
    [
      "the HARIL copy's version cannot be read",
      [install(HARIL_COPY, null, true, ["haril"])],
      NO_LATEST,
      "unknown",
      false,
    ],
    [
      "a newer version is published upstream",
      [install(HARIL_COPY, "3.6.0", true, ["haril"])],
      latest("3.7.0"),
      "ok",
      true,
    ],
    [
      "upstream is newer and the copy is also behind the pin",
      [install(HARIL_COPY, "3.4.0", true, ["haril"])],
      latest("3.7.0"),
      "outdated",
      true,
    ],
    [
      "the latest version is unavailable",
      [install(HARIL_COPY, "3.6.0", true, ["haril"])],
      NO_LATEST,
      "ok",
      false,
    ],
  ];

  it.each(cases)("%s", (_name, installs, view, state, newerUpstream) => {
    const status = buildToolStatus("engram", installs, view, context);
    expect(status.id).toBe("engram");
    expect(status.state).toBe(state);
    expect(status.newerUpstream).toBe(newerUpstream);
    expect(status.qualified).toBe(PIN);
    expect(status.installs).toEqual(installs);
  });

  it("exposes the active install, and none when missing", () => {
    const copy = install(HARIL_COPY, "3.6.0", true, ["haril"]);
    expect(buildToolStatus("engram", [copy], NO_LATEST, context).active).toBe(copy);
    expect(buildToolStatus("engram", [], NO_LATEST, context).active).toBeNull();
  });

  it("tells how to install it when it is missing, naming where HARIL expects it", () => {
    const { notes } = buildToolStatus("engram", [], NO_LATEST, context);
    expect(notes.join("\n")).toContain(HARIL_COPY);
    expect(notes.join("\n")).toContain("haril tools ensure");
  });

  it("only notifies about a newer upstream version: the qualified version stays the pin", () => {
    const status = buildToolStatus(
      "engram",
      [install(HARIL_COPY, "3.6.0", true, ["haril"])],
      latest("3.7.0"),
      context,
    );
    expect(status.qualified).toBe(PIN);
    expect(status.latest).toBe("3.7.0");
    expect(status.notes.join("\n")).toMatch(/3\.7\.0 is published.*qualified for 3\.6\.0/);
  });

  it("flags the same tool installed in several places with different versions", () => {
    const status = buildToolStatus(
      "engram",
      [
        install(HARIL_COPY, "3.6.0", true, ["haril"]),
        install("/home/ana/go/bin/engram", "3.3.2", false, ["go-bin"]),
      ],
      NO_LATEST,
      context,
    );
    expect(status.state).toBe("ok");
    expect(status.notes).toContain("installed in 2 places with different versions: 3.6.0, 3.3.2");
  });

  it("does not flag several installs that agree", () => {
    const status = buildToolStatus(
      "engram",
      [
        install(HARIL_COPY, "3.6.0", true, ["haril"]),
        install("/home/ana/go/bin/engram", "3.6.0", false, ["go-bin"]),
      ],
      NO_LATEST,
      context,
    );
    expect(status.notes.join("\n")).not.toContain("different versions");
  });

  it("explains an unreadable version", () => {
    const status = buildToolStatus(
      "engram",
      [install(HARIL_COPY, null, true, ["haril"], "exit 2")],
      NO_LATEST,
      context,
    );
    expect(status.notes.join("\n")).toContain("could not read the version of");
    expect(status.notes.join("\n")).toContain("exit 2");
  });

  it("notes that a memory.binary override is what runs", () => {
    const custom = "/custom/engram";
    const status = buildToolStatus(
      "engram",
      [install(custom, "3.6.0", true, ["config"]), install(HARIL_COPY, "3.6.0", false, ["haril"])],
      NO_LATEST,
      { pin: PIN, runtimeBinary: custom },
    );
    expect(status.notes.join("\n")).toContain("memory.binary");
  });
});

describe("classifying gentle-ai", () => {
  const ctx = { pin: PIN, runtimeBinary: HARIL_COPY };
  const cases: [string, Install[], LatestView, string][] = [
    ["it is not installed", [], latest("4.3.1"), "missing"],
    [
      "the active version is older than the latest",
      [install("/usr/bin/gentle-ai", "4.0.0", true)],
      latest("4.3.1"),
      "outdated",
    ],
    [
      "the active version is the latest",
      [install("/usr/bin/gentle-ai", "4.3.1", true)],
      latest("4.3.1"),
      "ok",
    ],
    [
      "the active version is newer than the latest (a stale lookup)",
      [install("/usr/bin/gentle-ai", "4.5.0", true)],
      latest("4.3.1"),
      "ok",
    ],
    [
      "the active version cannot be read",
      [install("/usr/bin/gentle-ai", null, true)],
      latest("4.3.1"),
      "unknown",
    ],
    [
      "the latest version is unavailable",
      [install("/usr/bin/gentle-ai", "4.0.0", true)],
      NO_LATEST,
      "unknown",
    ],
    [
      "the version cannot be read and the latest is unavailable",
      [install("/usr/bin/gentle-ai", null, true)],
      NO_LATEST,
      "unknown",
    ],
  ];

  it.each(cases)("%s", (_name, installs, view, state) => {
    const status = buildToolStatus("gentle-ai", installs, view, ctx);
    expect(status.id).toBe("gentle-ai");
    expect(status.state).toBe(state);
    expect(status.qualified).toBeNull();
    expect(status.newerUpstream).toBe(false);
  });

  it("judges the active install, not the others", () => {
    const status = buildToolStatus(
      "gentle-ai",
      [
        install("/usr/bin/gentle-ai", "4.3.1", true),
        install("/home/ana/go/bin/gentle-ai", "4.0.0", false, ["go-bin"]),
      ],
      latest("4.3.1"),
      ctx,
    );
    expect(status.state).toBe("ok");
    expect(status.notes).toContain("installed in 2 places with different versions: 4.3.1, 4.0.0");
  });

  it("says how to install it, with the Go requirement", () => {
    const { notes } = buildToolStatus("gentle-ai", [], latest("4.3.1"), ctx);
    const text = notes.join("\n");
    expect(text).toContain(
      "go install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@latest",
    );
    expect(text).toContain("Go");
  });

  it("warns when it is only in a Go bin dir that is not on PATH", () => {
    const status = buildToolStatus(
      "gentle-ai",
      [install("/home/ana/go/bin/gentle-ai", "4.3.1", true, ["go-bin"])],
      latest("4.3.1"),
      ctx,
    );
    expect(status.state).toBe("ok");
    expect(status.notes.join("\n")).toContain("not on PATH");
  });

  it("carries the notes of the latest lookup", () => {
    const view: LatestView = {
      latest: null,
      checkedAt: null,
      notes: ["the lookup failed: HTTP 503"],
    };
    const status = buildToolStatus(
      "gentle-ai",
      [install("/usr/bin/gentle-ai", "4.0.0", true)],
      view,
      ctx,
    );
    expect(status.notes).toContain("the lookup failed: HTTP 503");
  });
});

// A whole report, with the filesystem, the processes, the network and the clock faked.
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const INPUT: ToolsInput = {
  platform: "linux",
  env: { PATH: "/usr/local/bin" },
  homeDir: "/home/ana",
  harilCopy: HARIL_COPY,
  runtimeBinary: HARIL_COPY,
  pin: PIN,
};

interface Rig {
  readonly deps: ToolsDeps;
  readonly urls: string[];
  readonly saved: ToolsState[];
}

function rig(
  options: {
    state?: ToolsState;
    versions?: Record<string, string>;
    tags?: Record<string, string>;
    failWith?: string;
    writeFails?: boolean;
  } = {},
): Rig {
  const urls: string[] = [];
  const saved: ToolsState[] = [];
  const versions = options.versions ?? {
    [HARIL_COPY]: "3.6.0",
    "/usr/local/bin/gentle-ai": "4.0.0",
  };
  const tags = options.tags ?? { engram: "v3.6.0", "gentle-ai": "v4.3.1" };
  const detect: DetectDeps = {
    isFile: (path) => path in versions,
    realPath: (path) => path,
    readVersion: async (path: string, _tool: ToolId) => {
      const version = versions[path];
      return version === undefined ? { error: "no version" } : { version };
    },
  };
  const fetcher: LatestFetch = async (url) => {
    urls.push(url);
    if (options.failWith !== undefined) throw new TypeError(options.failWith);
    const tool = url.includes("/engram/") ? "engram" : "gentle-ai";
    return {
      status: 302,
      headers: new Headers({ location: `https://github.com/x/${tool}/releases/tag/${tags[tool]}` }),
      body: null,
    };
  };
  let current = options.state ?? emptyToolsState();
  const deps: ToolsDeps = {
    detect,
    fetch: fetcher,
    now: () => NOW,
    readState: () => current,
    writeState: (next) => {
      if (options.writeFails) throw new Error("EACCES");
      saved.push(next);
      current = next;
    },
  };
  return { deps, urls, saved };
}

const byId = (report: ToolsReport, id: ToolId): ToolStatus | undefined =>
  report.tools.find((tool) => tool.id === id);

describe("a whole tools report", () => {
  it("has the stable envelope and one entry per tool", async () => {
    const report = await collectToolsReport(INPUT, rig().deps, "never");
    expect(report.schema).toBe("haril.tools.status/1");
    expect(report.generatedAt).toBe(iso(NOW));
    expect(report.tools.map((tool) => tool.id)).toEqual(["engram", "gentle-ai"]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("never touches the network or the state file in `never` mode", async () => {
    const r = rig();
    const report = await collectToolsReport(INPUT, r.deps, "never");
    expect(r.urls).toEqual([]);
    expect(r.saved).toEqual([]);
    const gentle = byId(report, "gentle-ai");
    expect(gentle).toMatchObject({ state: "unknown", latest: null });
    expect(gentle?.notes.join("\n")).toContain("tools status --refresh");
  });

  it("uses the cached latest in `never` mode and says when it is old", async () => {
    const state: ToolsState = {
      version: 1,
      tools: {
        "gentle-ai": { latest: "4.3.1", latestCheckedAt: iso(NOW - 3 * 24 * 3_600_000) },
      },
    };
    const r = rig({ state });
    const report = await collectToolsReport(INPUT, r.deps, "never");
    expect(r.urls).toEqual([]);
    expect(byId(report, "gentle-ai")).toMatchObject({
      state: "outdated",
      latest: "4.3.1",
      latestCheckedAt: iso(NOW - 3 * 24 * 3_600_000),
    });
    expect(byId(report, "gentle-ai")?.notes.join("\n")).toContain("older than 24 h");
  });

  it("looks both tools up with `always` and records the result", async () => {
    const r = rig();
    const report = await collectToolsReport(INPUT, r.deps, "always");
    expect(r.urls.sort()).toEqual([
      "https://github.com/Gentleman-Programming/engram/releases/latest",
      "https://github.com/Gentleman-Programming/gentle-ai/releases/latest",
    ]);
    expect(byId(report, "gentle-ai")).toMatchObject({ state: "outdated", latest: "4.3.1" });
    expect(byId(report, "engram")).toMatchObject({ state: "ok", latest: "3.6.0" });
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0]).toEqual({
      version: 1,
      tools: {
        engram: { latest: "3.6.0", latestCheckedAt: iso(NOW) },
        "gentle-ai": { latest: "4.3.1", latestCheckedAt: iso(NOW) },
      },
    });
  });

  it("notifies, without changing the state, when upstream engram is newer than the pin", async () => {
    const r = rig({ tags: { engram: "v3.9.0", "gentle-ai": "v4.3.1" } });
    const engram = byId(await collectToolsReport(INPUT, r.deps, "always"), "engram");
    expect(engram).toMatchObject({
      state: "ok",
      newerUpstream: true,
      qualified: PIN,
      latest: "3.9.0",
    });
  });

  it("skips a lookup inside the TTL with `if-due`", async () => {
    const fresh = { latest: "4.3.1", latestCheckedAt: iso(NOW - 3_600_000) };
    const r = rig({
      state: { version: 1, tools: { engram: { ...fresh, latest: "3.6.0" }, "gentle-ai": fresh } },
    });
    const report = await collectToolsReport(INPUT, r.deps, "if-due");
    expect(r.urls).toEqual([]);
    expect(r.saved).toEqual([]);
    expect(byId(report, "gentle-ai")?.latest).toBe("4.3.1");
  });

  it("looks up only the tool whose cache is stale with `if-due`", async () => {
    const r = rig({
      state: {
        version: 1,
        tools: {
          engram: { latest: "3.6.0", latestCheckedAt: iso(NOW - 3_600_000) },
          "gentle-ai": { latest: "4.0.0", latestCheckedAt: iso(NOW - 25 * 3_600_000) },
        },
      },
    });
    const report = await collectToolsReport(INPUT, r.deps, "if-due");
    expect(r.urls).toEqual(["https://github.com/Gentleman-Programming/gentle-ai/releases/latest"]);
    expect(byId(report, "gentle-ai")?.latest).toBe("4.3.1");
    expect(r.saved[0]?.tools.engram?.latestCheckedAt).toBe(iso(NOW - 3_600_000));
  });

  it("records a failure, keeps the old value and reports why", async () => {
    const old = { latest: "4.0.0", latestCheckedAt: iso(NOW - 48 * 3_600_000) };
    const r = rig({ failWith: "fetch failed", state: { version: 1, tools: { "gentle-ai": old } } });
    const report = await collectToolsReport(INPUT, r.deps, "always");
    const gentle = byId(report, "gentle-ai");
    expect(gentle?.latest).toBe("4.0.0");
    expect(gentle?.notes.join("\n")).toContain("network error: fetch failed");
    expect(r.saved[0]?.tools["gentle-ai"]).toEqual({
      ...old,
      lastFailureAt: iso(NOW),
      lastFailure: "network error: fetch failed",
    });
  });

  it("does not retry inside the 1 h cooldown unless asked to refresh", async () => {
    const failed = { lastFailureAt: iso(NOW - 600_000), lastFailure: "HTTP 503" };
    const state: ToolsState = { version: 1, tools: { engram: failed, "gentle-ai": failed } };
    const quiet = rig({ state });
    await collectToolsReport(INPUT, quiet.deps, "if-due");
    expect(quiet.urls).toEqual([]);
    const forced = rig({ state });
    await collectToolsReport(INPUT, forced.deps, "always");
    expect(forced.urls).toHaveLength(2);
  });

  it("clears an earlier failure after a successful lookup", async () => {
    const failed = { lastFailureAt: iso(NOW - 7_200_000), lastFailure: "HTTP 503" };
    const r = rig({ state: { version: 1, tools: { "gentle-ai": failed } } });
    await collectToolsReport(INPUT, r.deps, "if-due");
    expect(r.saved[0]?.tools["gentle-ai"]).toEqual({
      latest: "4.3.1",
      latestCheckedAt: iso(NOW),
    });
  });

  it("still reports when the state file cannot be written", async () => {
    const r = rig({ writeFails: true });
    const report = await collectToolsReport(INPUT, r.deps, "always");
    expect(byId(report, "gentle-ai")?.latest).toBe("4.3.1");
    expect(byId(report, "gentle-ai")?.notes.join("\n")).toContain("could not save the tools state");
  });

  it("detects locally on every call, so a fresh install shows without a refresh", async () => {
    const r = rig({ versions: { [HARIL_COPY]: "3.6.0" } });
    const before = await collectToolsReport(INPUT, r.deps, "never");
    expect(byId(before, "gentle-ai")?.state).toBe("missing");
    const r2 = rig({ versions: { [HARIL_COPY]: "3.6.0", "/usr/local/bin/gentle-ai": "4.3.1" } });
    const after = await collectToolsReport(INPUT, r2.deps, "never");
    expect(byId(after, "gentle-ai")?.active?.version).toBe("4.3.1");
  });

  it("carries input notes on engram, such as an unreadable haril.json", async () => {
    const report = await collectToolsReport(
      { ...INPUT, notes: ["haril.json is not valid JSON; using the default Engram path"] },
      rig().deps,
      "never",
    );
    expect(byId(report, "engram")?.notes).toContain(
      "haril.json is not valid JSON; using the default Engram path",
    );
    expect(byId(report, "gentle-ai")?.notes.join("\n")).not.toContain("haril.json");
  });

  it("keeps the fields next to the tools when a refresh rewrites the state", async () => {
    const failure = { failedAt: iso(NOW - 3_600_000), message: "network error: fetch failed" };
    const r = rig({ state: { version: 1, tools: {}, engramInstall: failure } });
    await collectToolsReport(INPUT, r.deps, "always");
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0]?.engramInstall).toEqual(failure);
    expect(r.saved[0]?.tools["gentle-ai"]?.latest).toBe("4.3.1");
  });
});
