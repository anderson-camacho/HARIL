import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type IdentityStats,
  type ReadFsPort,
  type ReadHandle,
  readGuardedFile,
  readGuardedFileSync,
} from "../src/read-guarded.js";

// A fake port: lstat answers with the link-level stats, the opened handle with the handle-level stats.
function fakePort(options: {
  lstat: Partial<IdentityStats>;
  handle: Partial<IdentityStats>;
  content?: Buffer;
}): ReadFsPort & { readonly state: { closed: boolean; readCount: number } } {
  const state = { closed: false, readCount: 0 };
  const base = (over: Partial<IdentityStats>): IdentityStats => ({
    dev: 1n,
    ino: 1n,
    size: 4n,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...over,
  });
  const handle: ReadHandle = {
    stat: async () => base(options.handle),
    readFile: async () => {
      state.readCount++;
      return options.content ?? Buffer.from("data");
    },
    close: async () => {
      state.closed = true;
    },
  };
  return {
    state,
    lstat: async () => base(options.lstat),
    open: async () => handle,
  };
}

describe("readGuardedFile (identity check)", () => {
  it("reads the content from the opened handle when the identity matches", async () => {
    const port = fakePort({
      lstat: { dev: 7n, ino: 9n },
      handle: { dev: 7n, ino: 9n },
      content: Buffer.from("hi"),
    });
    const result = await readGuardedFile("/root/a.txt", { fs: port });
    expect(result).toEqual({ ok: true, content: Buffer.from("hi") });
    expect(port.state.closed).toBe(true);
  });

  it("denies with identity_changed when the opened file is not the one lstat saw, and never reads it", async () => {
    const port = fakePort({ lstat: { dev: 7n, ino: 9n }, handle: { dev: 7n, ino: 10n } });
    expect(await readGuardedFile("/root/a.txt", { fs: port })).toEqual({
      ok: false,
      reason: "identity_changed",
    });
    expect(port.state.readCount).toBe(0);
    expect(port.state.closed).toBe(true);
  });

  it("denies a volume change with identity_changed", async () => {
    const port = fakePort({ lstat: { dev: 7n, ino: 9n }, handle: { dev: 8n, ino: 9n } });
    expect(await readGuardedFile("/root/a.txt", { fs: port })).toEqual({
      ok: false,
      reason: "identity_changed",
    });
  });

  it("denies a link seen at lstat time without opening the file", async () => {
    const port = fakePort({ lstat: { isSymbolicLink: () => true }, handle: {} });
    expect(await readGuardedFile("/root/a.txt", { fs: port })).toEqual({
      ok: false,
      reason: "link",
    });
    expect(port.state.closed).toBe(false);
  });

  it("denies a path that is not a regular file", async () => {
    const port = fakePort({ lstat: { isFile: () => false }, handle: {} });
    expect(await readGuardedFile("/root/a.txt", { fs: port })).toEqual({
      ok: false,
      reason: "not_a_file",
    });
  });

  it("refuses a file larger than the limit before reading it", async () => {
    const port = fakePort({ lstat: {}, handle: { size: 100n } });
    expect(await readGuardedFile("/root/a.txt", { fs: port, maxBytes: 10 })).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(port.state.readCount).toBe(0);
  });
});

describe("readGuardedFileSync (real filesystem)", () => {
  let base: string;
  let outside: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "haril-read-guarded-"));
    outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(base, "plain.txt"), "plain", "utf8");
    writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
    symlinkSync(outside, join(base, "jout"), "junction");
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("reads a regular file", () => {
    expect(readGuardedFileSync(join(base, "plain.txt"))).toEqual({
      ok: true,
      content: Buffer.from("plain"),
    });
  });

  it("reports a missing file", () => {
    expect(readGuardedFileSync(join(base, "missing.txt"))).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("refuses a final component that is a junction (intermediate links are the guard's job)", () => {
    expect(readGuardedFileSync(join(base, "jout"))).toEqual({ ok: false, reason: "link" });
  });

  it("refuses a directory", () => {
    expect(readGuardedFileSync(outside)).toEqual({ ok: false, reason: "not_a_file" });
  });
});
