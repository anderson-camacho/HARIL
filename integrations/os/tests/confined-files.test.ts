import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { EOL, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readConfinedFile, writeConfinedFile } from "../src/index.js";

// The filesystem half of the workspace PathGuard (docs/modos-y-delegacion.md 3.10.5, section 8; phase F8): a write the
// lexical check accepted still lands only inside the worktree. A symbolic link or a junction anywhere on the way is
// refused, never followed, a missing folder is created one level at a time, and an existing file is replaced only after
// the opened handle proves it is the file that was checked.

let base: string;
let root: string;
let outside: string;
let fileLinksOk = true;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "haril-confined-"));
  root = join(base, "worktree");
  outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "inside"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(outside, "target.txt"), "outside\n", "utf8");
  symlinkSync(outside, join(root, "jout"), "junction");
  symlinkSync(join(root, "inside"), join(root, "jin"), "junction");
  try {
    symlinkSync(join(outside, "target.txt"), join(root, "src", "link.txt"));
  } catch (error) {
    fileLinksOk = false;
    console.warn(`skipped file symlink case: ${(error as NodeJS.ErrnoException).code}`);
  }
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("writeConfinedFile", () => {
  it("replaces an existing plain file inside the root", async () => {
    expect(await writeConfinedFile(root, "src/a.ts", "export const a = 2;\n")).toEqual({
      ok: true,
      created: false,
      bytes: 20,
    });
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  it("creates a new file and its missing folders", async () => {
    expect(await writeConfinedFile(root, "src/deep/er/b.ts", "b\n")).toEqual({
      ok: true,
      created: true,
      bytes: 2,
    });
    expect(readFileSync(join(root, "src", "deep", "er", "b.ts"), "utf8")).toBe("b\n");
  });

  it("refuses a junction on the way, whether it points outside or inside, and writes nothing", async () => {
    expect(await writeConfinedFile(root, "jout/new.txt", "x")).toEqual({
      ok: false,
      reason: "link",
    });
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    expect(await writeConfinedFile(root, "jin/new.txt", "x")).toEqual({
      ok: false,
      reason: "link",
    });
    expect(existsSync(join(root, "inside", "new.txt"))).toBe(false);
  });

  it("refuses to write through a file symlink and leaves its target untouched", async () => {
    if (!fileLinksOk) return;
    expect(await writeConfinedFile(root, "src/link.txt", "x")).toEqual({
      ok: false,
      reason: "link",
    });
    expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("outside\n");
  });

  it("refuses a path that leaves the root or names a folder", async () => {
    expect(await writeConfinedFile(root, "../outside/target.txt", "x")).toEqual({
      ok: false,
      reason: "outside_root",
    });
    expect(await writeConfinedFile(root, "src", "x")).toEqual({ ok: false, reason: "not_a_file" });
    expect(await writeConfinedFile(root, "src/a.ts/child", "x")).toEqual({
      ok: false,
      reason: "not_a_directory",
    });
  });

  it("refuses a root that does not exist", async () => {
    expect(await writeConfinedFile(join(base, "missing"), "a.txt", "x")).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });
});

// Whether this volume gives 8.3 short names: .git then answers to GIT~1 (NTFS with short names on).
function shortNameOf(folder: string, long: string): string | undefined {
  const alias = join(folder, "GIT~1");
  return long === ".git" && existsSync(alias) ? "GIT~1" : undefined;
}

describe("a short-name alias", () => {
  const original = `gitdir: elsewhere${EOL}`;
  it("is refused for writing and reading when the volume has one, and the real file stays as it was", async () => {
    const tree = join(base, "alias-tree");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, ".git"), original, "utf8");
    const alias = shortNameOf(tree, ".git");
    if (alias === undefined) {
      console.warn("skipped the short-name probe: this volume gives no 8.3 alias");
      return;
    }
    expect(await writeConfinedFile(tree, alias, "gitdir: hijacked")).toEqual({
      ok: false,
      reason: "alias",
    });
    expect(await readConfinedFile(tree, alias, 1_000)).toEqual({ ok: false, reason: "alias" });
    expect(readFileSync(join(tree, ".git"), "utf8")).toBe(original);
    mkdirSync(join(tree, "sub", ".git"), { recursive: true });
    expect(await writeConfinedFile(tree, "sub/GIT~1/config", "x")).toEqual({
      ok: false,
      reason: "alias",
    });
  });

  it("refuses to write a file that has another hard link", async () => {
    const tree = join(base, "hardlink-tree");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(outside, "linked.txt"), "outside", "utf8");
    linkSync(join(outside, "linked.txt"), join(tree, "linked.txt"));
    expect(await writeConfinedFile(tree, "linked.txt", "changed")).toEqual({
      ok: false,
      reason: "hard_link",
    });
    expect(readFileSync(join(outside, "linked.txt"), "utf8")).toBe("outside");
  });
});

describe("readConfinedFile", () => {
  it("reads a plain file inside the root", async () => {
    writeFileSync(join(root, "src", "c.ts"), "c\n", "utf8");
    expect(await readConfinedFile(root, "src/c.ts", 1024)).toEqual({ ok: true, content: "c\n" });
  });

  it("refuses links, missing files and files over the size limit", async () => {
    expect(await readConfinedFile(root, "jout/target.txt", 1024)).toEqual({
      ok: false,
      reason: "link",
    });
    expect(await readConfinedFile(root, "src/none.ts", 1024)).toEqual({
      ok: false,
      reason: "missing",
    });
    writeFileSync(join(root, "src", "big.ts"), "x".repeat(100), "utf8");
    expect(await readConfinedFile(root, "src/big.ts", 10)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});
