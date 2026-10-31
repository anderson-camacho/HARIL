import { describe, expect, it } from "vitest";
import { type DetectContext, type DetectDeps, detectInstalls } from "../src/tools/detect.js";
import type { ToolId } from "../src/tools/types.js";

// Every filesystem and process access is injected: `files` maps a path to its real path and version output.
interface FakeFile {
  readonly real?: string;
  readonly version?: string;
  readonly error?: string;
}

function fakeDeps(files: Record<string, FakeFile>): DetectDeps & { versionCalls: string[] } {
  const versionCalls: string[] = [];
  return {
    versionCalls,
    isFile: (path) => path in files,
    realPath: (path) => files[path]?.real ?? path,
    readVersion: async (path: string, _tool: ToolId) => {
      versionCalls.push(path);
      const file = files[path];
      if (file?.version !== undefined) return { version: file.version };
      return { error: file?.error ?? "no version in the output" };
    },
  };
}

const HARIL_COPY = "/data/haril/vendor/engram/3.6.0/engram";

function posix(extra: Partial<DetectContext> = {}): DetectContext {
  return {
    platform: "linux",
    env: { PATH: "/usr/local/bin:/opt/tools", HOME: "/home/ana" },
    homeDir: "/home/ana",
    ...extra,
  };
}

describe("engram detection", () => {
  const ctx = (extra: Partial<DetectContext> = {}) =>
    posix({ harilCopy: HARIL_COPY, runtimeBinary: HARIL_COPY, ...extra });

  it("finds the HARIL copy, every PATH entry and the Go bin dirs, each with its origin", async () => {
    const deps = fakeDeps({
      [HARIL_COPY]: { version: "3.6.0" },
      "/usr/local/bin/engram": { version: "3.5.0" },
      "/opt/tools/engram": { version: "3.4.0" },
      "/gobin/engram": { version: "3.3.0" },
      "/gopath-a/bin/engram": { version: "3.2.0" },
      "/home/ana/go/bin/engram": { version: "3.3.2" },
    });
    const installs = await detectInstalls(
      "engram",
      ctx({
        env: {
          PATH: "/usr/local/bin:/opt/tools",
          GOBIN: "/gobin",
          GOPATH: "/gopath-a:/gopath-b",
        },
      }),
      deps,
    );
    expect(installs.map((i) => [i.path, i.origin, i.version])).toEqual([
      [HARIL_COPY, "haril", "3.6.0"],
      ["/usr/local/bin/engram", "path", "3.5.0"],
      ["/opt/tools/engram", "path", "3.4.0"],
      ["/gobin/engram", "go-bin", "3.3.0"],
      ["/gopath-a/bin/engram", "go-bin", "3.2.0"],
      ["/home/ana/go/bin/engram", "go-bin", "3.3.2"],
    ]);
  });

  it("makes the HARIL copy the active install and never a go-bin one", async () => {
    const deps = fakeDeps({
      [HARIL_COPY]: { version: "3.6.0" },
      "/home/ana/go/bin/engram": { version: "3.3.2" },
    });
    const installs = await detectInstalls("engram", ctx(), deps);
    expect(installs.filter((i) => i.active).map((i) => i.path)).toEqual([HARIL_COPY]);
  });

  it("has no active install when the HARIL copy is missing, even with others present", async () => {
    const deps = fakeDeps({
      "/home/ana/go/bin/engram": { version: "3.3.2" },
      "/usr/local/bin/engram": { version: "3.3.2" },
    });
    const installs = await detectInstalls("engram", ctx(), deps);
    expect(installs).toHaveLength(2);
    expect(installs.some((i) => i.active)).toBe(false);
  });

  it("treats a configured memory.binary as what runs, labelled config", async () => {
    const custom = "/custom/engram";
    const deps = fakeDeps({
      [HARIL_COPY]: { version: "3.6.0" },
      [custom]: { version: "3.6.0" },
    });
    const installs = await detectInstalls("engram", ctx({ runtimeBinary: custom }), deps);
    expect(installs.map((i) => [i.path, i.origin, i.active])).toEqual([
      [custom, "config", true],
      [HARIL_COPY, "haril", false],
    ]);
  });

  it("lists the active install first and keeps discovery order for the rest", async () => {
    const deps = fakeDeps({
      "/usr/local/bin/engram": { version: "3.3.2" },
      [HARIL_COPY]: { version: "3.6.0" },
    });
    const installs = await detectInstalls("engram", ctx(), deps);
    expect(installs.map((i) => i.path)).toEqual([HARIL_COPY, "/usr/local/bin/engram"]);
  });
});

describe("gentle-ai detection", () => {
  it("looks only on PATH and in the Go bin dirs", async () => {
    const deps = fakeDeps({
      "/usr/local/bin/gentle-ai": { version: "4.0.0" },
      "/home/ana/go/bin/gentle-ai": { version: "4.3.1" },
      // Not a place HARIL looks at, so it must be ignored.
      "/home/ana/.local/bin/gentle-ai": { version: "9.9.9" },
      "/data/haril/vendor/gentle-ai/gentle-ai": { version: "9.9.9" },
    });
    const installs = await detectInstalls("gentle-ai", posix(), deps);
    expect(installs.map((i) => i.path)).toEqual([
      "/usr/local/bin/gentle-ai",
      "/home/ana/go/bin/gentle-ai",
    ]);
  });

  it("makes the first one on PATH active", async () => {
    const deps = fakeDeps({
      "/opt/tools/gentle-ai": { version: "4.0.0" },
      "/usr/local/bin/gentle-ai": { version: "4.3.1" },
      "/home/ana/go/bin/gentle-ai": { version: "4.3.1" },
    });
    const installs = await detectInstalls("gentle-ai", posix(), deps);
    expect(installs.find((i) => i.active)?.path).toBe("/usr/local/bin/gentle-ai");
    expect(installs.filter((i) => i.active)).toHaveLength(1);
  });

  it("falls back to a go-bin install that is not on PATH, which stays flagged by its origins", async () => {
    const deps = fakeDeps({ "/home/ana/go/bin/gentle-ai": { version: "4.0.0" } });
    const installs = await detectInstalls("gentle-ai", posix(), deps);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ active: true, origin: "go-bin", origins: ["go-bin"] });
  });

  it("returns nothing when it is installed nowhere", async () => {
    expect(await detectInstalls("gentle-ai", posix(), fakeDeps({}))).toEqual([]);
  });
});

describe("candidate handling", () => {
  it("deduplicates by real path and merges the origins", async () => {
    const deps = fakeDeps({
      "/usr/local/bin/gentle-ai": { real: "/home/ana/go/bin/gentle-ai", version: "4.0.0" },
      "/home/ana/go/bin/gentle-ai": { version: "4.0.0" },
    });
    const installs = await detectInstalls("gentle-ai", posix(), deps);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({
      path: "/usr/local/bin/gentle-ai",
      origin: "path",
      origins: ["path", "go-bin"],
    });
    // One file, one execution.
    expect(deps.versionCalls).toHaveLength(1);
  });

  it("names a PATH directory that is also the Go bin dir once, as path and go-bin", async () => {
    const deps = fakeDeps({ "/home/ana/go/bin/engram": { version: "3.3.2" } });
    const installs = await detectInstalls(
      "engram",
      posix({
        env: { PATH: "/home/ana/go/bin" },
        harilCopy: HARIL_COPY,
        runtimeBinary: HARIL_COPY,
      }),
      deps,
    );
    expect(installs).toHaveLength(1);
    expect(installs[0]?.origins).toEqual(["path", "go-bin"]);
  });

  it("ignores empty and relative PATH entries so a file in the working directory never runs", async () => {
    const deps = fakeDeps({
      "bin/gentle-ai": { version: "9.9.9" },
      "./gentle-ai": { version: "9.9.9" },
      "/usr/local/bin/gentle-ai": { version: "4.0.0" },
    });
    const installs = await detectInstalls(
      "gentle-ai",
      posix({ env: { PATH: ":bin:.:/usr/local/bin:" } }),
      deps,
    );
    expect(installs.map((i) => i.path)).toEqual(["/usr/local/bin/gentle-ai"]);
  });

  it("keeps an install whose version cannot be read, with the reason", async () => {
    const deps = fakeDeps({ "/usr/local/bin/gentle-ai": { error: "timed out" } });
    const installs = await detectInstalls("gentle-ai", posix(), deps);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ version: null, versionError: "timed out", active: true });
  });

  it("tolerates a missing PATH and home", async () => {
    const installs = await detectInstalls(
      "gentle-ai",
      { platform: "linux", env: {}, homeDir: "" },
      fakeDeps({}),
    );
    expect(installs).toEqual([]);
  });
});

describe("Windows paths", () => {
  const win = (extra: Partial<DetectContext> = {}): DetectContext => ({
    platform: "win32",
    // The variable is spelled Path on Windows, and entries may be quoted.
    env: {
      Path: 'C:\\Windows;"C:\\Users\\Ana\\go\\bin";C:\\tools',
      GOBIN: "c:\\users\\ana\\GO\\bin",
    },
    homeDir: "C:\\Users\\Ana",
    ...extra,
  });

  it("looks for the .exe, reads Path case-insensitively and removes quotes", async () => {
    const deps = fakeDeps({
      "C:\\Users\\Ana\\go\\bin\\gentle-ai.exe": { version: "4.0.0" },
      "C:\\tools\\gentle-ai.exe": { version: "4.3.1" },
    });
    const installs = await detectInstalls("gentle-ai", win(), deps);
    expect(installs.map((i) => i.path)).toEqual([
      "C:\\Users\\Ana\\go\\bin\\gentle-ai.exe",
      "C:\\tools\\gentle-ai.exe",
    ]);
    expect(installs[0]?.active).toBe(true);
  });

  it("deduplicates paths that differ only in case", async () => {
    const deps = fakeDeps({
      "C:\\Users\\Ana\\go\\bin\\engram.exe": { version: "3.3.2" },
      "c:\\users\\ana\\GO\\bin\\engram.exe": { version: "3.3.2" },
    });
    const installs = await detectInstalls(
      "engram",
      win({
        harilCopy: "C:\\HARIL\\vendor\\engram\\3.6.0\\engram.exe",
        runtimeBinary: "C:\\HARIL\\vendor\\engram\\3.6.0\\engram.exe",
      }),
      deps,
    );
    expect(installs).toHaveLength(1);
    expect(installs[0]?.origins).toEqual(["path", "go-bin"]);
  });

  it("splits GOPATH on semicolons", async () => {
    const deps = fakeDeps({
      "D:\\gopath\\bin\\gentle-ai.exe": { version: "4.0.0" },
      "E:\\more\\bin\\gentle-ai.exe": { version: "4.0.0" },
    });
    const installs = await detectInstalls(
      "gentle-ai",
      win({ env: { Path: "", GOPATH: "D:\\gopath;E:\\more" } }),
      deps,
    );
    expect(installs.map((i) => i.path)).toEqual([
      "D:\\gopath\\bin\\gentle-ai.exe",
      "E:\\more\\bin\\gentle-ai.exe",
    ]);
  });
});
