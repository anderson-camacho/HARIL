import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeEnsureFs } from "../src/tools/fs.js";
import { acquireLock } from "../src/tools/lock.js";

const MINUTE = 60_000;

describe("the exclusive tools lock", () => {
  let root: string;
  let path: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "haril-lock-"));
    path = join(root, "state", "tools.lock");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const take = () => acquireLock(path, Date.now, nodeEnsureFs);
  const ageLock = (ms: number) => {
    const at = new Date(Date.now() - ms);
    utimesSync(path, at, at);
  };

  it("creates the file and its folder, and removes the file on release", () => {
    const lock = take();
    expect(lock.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
    if (lock.ok) lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a second holder while the first one is alive", () => {
    const first = take();
    const second = take();
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, busy: true });
    expect(existsSync(path)).toBe(true);
  });

  it("can be taken again after a release", () => {
    const first = take();
    if (first.ok) first.release();
    expect(take().ok).toBe(true);
  });

  it("is still busy at 14 minutes", () => {
    const first = take();
    expect(first.ok).toBe(true);
    ageLock(14 * MINUTE);
    expect(take()).toEqual({ ok: false, busy: true });
  });

  it("is stale after 15 minutes and is taken over", () => {
    const first = take();
    expect(first.ok).toBe(true);
    ageLock(15 * MINUTE + 1000);
    const second = take();
    expect(second.ok).toBe(true);
  });

  it("does not let the old holder release the lock of the one that took over", () => {
    const first = take();
    ageLock(16 * MINUTE);
    const second = take();
    expect(second.ok).toBe(true);
    if (first.ok) first.release();
    expect(existsSync(path)).toBe(true);
    if (second.ok) second.release();
    expect(existsSync(path)).toBe(false);
  });

  it("treats a lock whose content is garbage as a lock, not as free", () => {
    take();
    writeFileSync(path, "garbage");
    expect(take()).toEqual({ ok: false, busy: true });
  });

  it("reports an error, not busy, when the folder cannot be used", () => {
    writeFileSync(join(root, "state"), "a file where the folder should be");
    const result = take();
    expect(result).toMatchObject({ ok: false, busy: false });
    expect(!result.ok && !result.busy && result.message).toEqual(expect.any(String));
  });
});
