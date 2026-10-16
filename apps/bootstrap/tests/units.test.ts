import { describe, expect, it } from "vitest";
import {
  nodeArchive,
  parseManifest,
  parseShasums,
  resolveRuntimeRoot,
  serializeManifest,
  sha256Hex,
} from "../src/index.js";

// Pure units: archive naming, SHA-256 lists, root resolution and the manifest round-trip.
describe("nodeArchive", () => {
  it("names the official win-x64 zip and its install directory", () => {
    expect(nodeArchive("win32", "x64")).toEqual({
      fileName: "node-v24.22.0-win-x64.zip",
      url: "https://nodejs.org/dist/v24.22.0/node-v24.22.0-win-x64.zip",
      archiveDirName: "node-v24.22.0-win-x64",
      installDirName: "v24.22.0-win-x64",
      binaryRelPath: "node.exe",
    });
  });

  it("uses tar.xz on linux and tar.gz on darwin, with the binary under bin", () => {
    expect(nodeArchive("linux", "x64").fileName).toBe("node-v24.22.0-linux-x64.tar.xz");
    expect(nodeArchive("linux", "x64").binaryRelPath).toBe("bin/node");
    expect(nodeArchive("darwin", "arm64").fileName).toBe("node-v24.22.0-darwin-arm64.tar.gz");
  });

  it("rejects platforms without a pinned archive", () => {
    expect(() => nodeArchive("win32", "arm64")).toThrow(/unsupported platform win32-arm64/);
    expect(() => nodeArchive("freebsd", "x64")).toThrow(/unsupported platform freebsd-x64/);
  });
});

describe("parseShasums", () => {
  it("maps each file name to its digest and ignores blank lines", () => {
    const digest = "a".repeat(64);
    const map = parseShasums(`${digest}  node-v24.22.0-win-x64.zip\n\n`);
    expect(map.get("node-v24.22.0-win-x64.zip")).toBe(digest);
    expect(map.size).toBe(1);
  });

  it("rejects a line whose digest is not 64 hex characters", () => {
    expect(() => parseShasums("abc  node.zip\n")).toThrow(/malformed SHA-256 line/);
  });

  it("hashes bytes with SHA-256", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("resolveRuntimeRoot", () => {
  const base = { platform: "win32", homeDir: "C:\\Users\\tester" };

  it("prefers --root over HARIL_RUNTIME_DIR and LOCALAPPDATA", () => {
    expect(
      resolveRuntimeRoot({
        ...base,
        flag: "D:\\rt",
        env: { HARIL_RUNTIME_DIR: "E:\\env", LOCALAPPDATA: "C:\\L" },
      }),
    ).toEqual({ root: "D:\\rt", source: "flag" });
  });

  it("then prefers HARIL_RUNTIME_DIR", () => {
    expect(
      resolveRuntimeRoot({ ...base, env: { HARIL_RUNTIME_DIR: "E:\\env", LOCALAPPDATA: "C:\\L" } }),
    ).toEqual({ root: "E:\\env", source: "HARIL_RUNTIME_DIR" });
  });

  it("defaults on win32 to %LOCALAPPDATA%\\HARIL, falling back to the home directory", () => {
    expect(
      resolveRuntimeRoot({ ...base, env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" } }),
    ).toEqual({
      root: "C:\\Users\\tester\\AppData\\Local\\HARIL",
      source: "platform-default",
    });
    expect(resolveRuntimeRoot({ ...base, env: {} }).root).toBe(
      "C:\\Users\\tester\\AppData\\Local\\HARIL",
    );
  });

  it("defaults elsewhere to XDG_DATA_HOME/haril, else ~/.local/share/haril", () => {
    const posix = { platform: "linux", homeDir: "/home/tester" };
    expect(resolveRuntimeRoot({ ...posix, env: { XDG_DATA_HOME: "/data" } }).root).toBe(
      "/data/haril",
    );
    expect(resolveRuntimeRoot({ ...posix, env: {} }).root).toBe("/home/tester/.local/share/haril");
  });

  it("ignores empty values", () => {
    expect(resolveRuntimeRoot({ ...base, flag: "", env: { HARIL_RUNTIME_DIR: "" } }).source).toBe(
      "platform-default",
    );
  });
});

describe("manifest", () => {
  const manifest = {
    schemaVersion: 1 as const,
    node: { version: "24.22.0", path: "C:\\rt\\node.exe", sha256: "b".repeat(64) },
    pi: { version: "1.2.0", cliPath: "C:\\vendor\\cli.js" },
    installedAt: "2026-10-16T00:00:00.000Z",
  };

  it("round-trips through JSON", () => {
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
  });

  it("keeps a null node digest for an install that predates the manifest", () => {
    const text = serializeManifest({ ...manifest, node: { ...manifest.node, sha256: null } });
    expect(parseManifest(text).node.sha256).toBeNull();
  });

  it("rejects an unknown schema version and missing fields", () => {
    expect(() => parseManifest(JSON.stringify({ ...manifest, schemaVersion: 2 }))).toThrow(
      /unsupported manifest schema/,
    );
    expect(() => parseManifest(JSON.stringify({ schemaVersion: 1, node: {} }))).toThrow(
      /must be an object|must be a string/,
    );
  });
});
