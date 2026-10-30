import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyToolsState,
  parseToolsState,
  readToolsState,
  type ToolsState,
  writeToolsState,
} from "../src/tools/state.js";

describe("parsing the tools state", () => {
  const good: ToolsState = {
    version: 1,
    tools: {
      engram: {
        latest: "3.6.0",
        latestCheckedAt: "2026-10-30T10:00:00.000Z",
      },
      "gentle-ai": {
        latest: "4.3.1",
        latestCheckedAt: "2026-10-30T10:00:00.000Z",
        lastFailureAt: "2026-10-30T11:00:00.000Z",
        lastFailure: "HTTP 503",
      },
    },
  };

  it("reads a valid file back unchanged", () => {
    expect(parseToolsState(JSON.stringify(good))).toEqual(good);
  });

  it.each([
    ["no file", undefined],
    ["an empty file", ""],
    ["truncated JSON", '{"version":1,"tools":{'],
    ["a JSON array", "[]"],
    ["null", "null"],
    ["a number", "7"],
    ["an unsupported version", '{"version":2,"tools":{}}'],
    ["a missing version", '{"tools":{}}'],
    ["tools that are not an object", '{"version":1,"tools":"x"}'],
    ["binary garbage", "\u0000\u0001\u0002"],
  ])("treats %s as an empty state without throwing", (_name, text) => {
    expect(parseToolsState(text)).toEqual(emptyToolsState());
  });

  it("drops invalid fields and unknown tools but keeps the valid ones", () => {
    const text = JSON.stringify({
      version: 1,
      extra: true,
      tools: {
        engram: {
          latest: "latest",
          latestCheckedAt: "yesterday",
          lastFailureAt: "2026-10-30T11:00:00.000Z",
          lastFailure: 42,
          unknown: "x",
        },
        "gentle-ai": { latest: "4.3.1", latestCheckedAt: "2026-10-30T10:00:00.000Z" },
        other: { latest: "1.0.0" },
      },
    });
    expect(parseToolsState(text)).toEqual({
      version: 1,
      tools: {
        engram: { lastFailureAt: "2026-10-30T11:00:00.000Z" },
        "gentle-ai": { latest: "4.3.1", latestCheckedAt: "2026-10-30T10:00:00.000Z" },
      },
    });
  });

  it("bounds the stored failure text", () => {
    const text = JSON.stringify({
      version: 1,
      tools: {
        engram: { lastFailureAt: "2026-10-30T11:00:00.000Z", lastFailure: "x".repeat(5000) },
      },
    });
    expect(parseToolsState(text).tools.engram?.lastFailure?.length).toBeLessThanOrEqual(200);
  });
});

describe("reading and writing the state file", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "haril-tools-state-"));
    path = join(dir, "state", "tools.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads an empty state when the file or its folder does not exist", () => {
    expect(readToolsState(path)).toEqual(emptyToolsState());
  });

  it("reads an empty state when the file is corrupt", () => {
    mkdirSync(join(dir, "state"));
    writeFileSync(path, "{ not json");
    expect(readToolsState(path)).toEqual(emptyToolsState());
  });

  it("creates the folder and round-trips the state", () => {
    const state: ToolsState = {
      version: 1,
      tools: { "gentle-ai": { latest: "4.3.1", latestCheckedAt: "2026-10-30T10:00:00.000Z" } },
    };
    writeToolsState(path, state);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(state);
    expect(readToolsState(path)).toEqual(state);
  });

  it("leaves no temporary file behind after a write", () => {
    writeToolsState(path, emptyToolsState());
    writeToolsState(path, emptyToolsState());
    expect(readdirSync(join(dir, "state"))).toEqual(["tools.json"]);
  });

  it("keeps the previous content and cleans up when the write cannot complete", () => {
    writeToolsState(path, { version: 1, tools: { engram: { latest: "3.6.0" } } });
    const before = readFileSync(path, "utf8");
    // A directory squatting on the target name makes the rename fail on every platform.
    const blocked = join(dir, "blocked", "tools.json");
    mkdirSync(blocked, { recursive: true });
    expect(() => writeToolsState(blocked, emptyToolsState())).toThrow();
    expect(readdirSync(join(dir, "blocked"))).toEqual(["tools.json"]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it.skipIf(process.platform === "win32")("writes the file readable only by its owner", () => {
    writeToolsState(path, emptyToolsState());
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
