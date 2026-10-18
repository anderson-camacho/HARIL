import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPathGuard, type GuardFs } from "../src/path-guard.js";

const ROOT = resolve("fixture-project-root");
const guard = createPathGuard(ROOT);

describe("PathGuard (lexical)", () => {
  it.each([
    "notes.txt",
    "src/a.ts",
    "./src/../src/b.ts",
    "..secret.txt",
    "console.ts",
    join(ROOT, "x.txt"),
  ])("allows %s inside the project root", (requested) => {
    const result = guard(requested);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absolutePath.startsWith(ROOT)).toBe(true);
  });

  it.each([
    ["../secret.txt", "outside_root"],
    ["src/../../secret.txt", "outside_root"],
    [join(dirname(ROOT), "outside.txt"), "outside_root"],
    ["\\\\server\\share\\a.txt", "unc_or_device_path"],
    ["//server/share/a.txt", "unc_or_device_path"],
    ["\\\\?\\C:\\a.txt", "unc_or_device_path"],
    ["\\\\.\\pipe\\haril-x", "unc_or_device_path"],
    ["C:secret.txt", "drive_or_stream"],
    ["notes.txt:stream", "drive_or_stream"],
    ["", "empty_path"],
    ["a\u0000b", "nul_byte"],
    [".", "outside_root"],
  ])("denies %j with %s", (requested, reason) => {
    expect(guard(requested)).toEqual({ ok: false, reason });
  });

  it.each([
    "CON",
    "con.txt",
    "src/aux.md",
    "docs/NUL.d.ts",
    "COM1.log",
    "lpt9",
    "src/Com5.txt",
    "prn",
  ])("denies the reserved device name %j", (requested) => {
    expect(guard(requested)).toEqual({ ok: false, reason: "reserved_name" });
  });

  it.each(["notes.txt.", "src./a.ts", "src /a.ts", "x/y "])(
    "denies a segment with a trailing dot or space %j",
    (requested) => {
      expect(guard(requested)).toEqual({ ok: false, reason: "trailing_dot_or_space" });
    },
  );

  it.each([
    ".git/config",
    "src/.git/HEAD",
    ".GIT/config",
    "a/../.git/x",
    ".env",
    "app/.env.local",
    "config/.env.production",
    ".haril/state.db",
    "x/.pi/settings.json",
  ])("denies the read deny-list entry %j", (requested) => {
    expect(guard(requested)).toEqual({ ok: false, reason: "denied_path" });
  });

  it.each(["GIT~1/config", "src/HARIL~1/state.db", "ENV~1", "x/PI~1/settings.json"])(
    "denies the Windows short name %j",
    (requested) => {
      expect(guard(requested)).toEqual({ ok: false, reason: "short_name" });
    },
  );

  it.each(["notes.env", "src/env.ts", ".gitignore", ".github/workflows/ci.yml", ".pitch/notes.md"])(
    "allows the near-miss name %j",
    (requested) => {
      expect(guard(requested).ok).toBe(true);
    },
  );
});

// A fake filesystem port: entries are the existing paths ("dir", "link" or "file"); realpaths maps a path to
// its canonical form. Missing paths throw ENOENT, as node:fs does.
function fakeFs(
  entries: Record<string, "dir" | "link" | "file">,
  realpaths: Record<string, string> = {},
): GuardFs & { readonly lstatCalls: string[] } {
  const lstatCalls: string[] = [];
  const enoent = (path: string) => Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
  return {
    lstatCalls,
    lstat(path) {
      lstatCalls.push(path);
      const kind = entries[path];
      if (kind === undefined) throw enoent(path);
      return {
        isSymbolicLink: () => kind === "link",
        isDirectory: () => kind === "dir",
      };
    },
    realpath(path) {
      if (realpaths[path] !== undefined) return realpaths[path];
      if (entries[path] === undefined) throw enoent(path);
      return path;
    },
  };
}

describe("PathGuard (links, fake fs port)", () => {
  it("denies a directory link on the way to the file", () => {
    const fs = fakeFs({ [ROOT]: "dir", [join(ROOT, "alias")]: "link" });
    expect(createPathGuard(ROOT, fs)("alias/secret.txt")).toEqual({ ok: false, reason: "link" });
  });

  it("denies a file that is itself a link", () => {
    const fs = fakeFs({ [ROOT]: "dir", [join(ROOT, "f.txt")]: "link" });
    expect(createPathGuard(ROOT, fs)("f.txt")).toEqual({ ok: false, reason: "link" });
  });

  it("walks every existing component from the root down and stops at the first missing one", () => {
    const fs = fakeFs({ [ROOT]: "dir", [join(ROOT, "src")]: "dir" });
    const result = createPathGuard(ROOT, fs)("src/new/deep/a.ts");
    expect(result.ok).toBe(true);
    expect(fs.lstatCalls).toEqual([join(ROOT, "src"), join(ROOT, "src", "new")]);
  });

  it("denies a component whose real name is not the name asked for (a short-name alias)", () => {
    const fs = fakeFs(
      { [ROOT]: "dir", [join(ROOT, "GITALIAS")]: "dir" },
      { [join(ROOT, "GITALIAS")]: join(ROOT, ".git") },
    );
    expect(createPathGuard(ROOT, fs)("GITALIAS/config")).toEqual({ ok: false, reason: "alias" });
  });

  it("denies a real directory whose canonical path leaves the root", () => {
    const outside = resolve("elsewhere", "alias");
    const fs = fakeFs(
      { [ROOT]: "dir", [join(ROOT, "alias")]: "dir" },
      { [join(ROOT, "alias")]: outside },
    );
    expect(createPathGuard(ROOT, fs)("alias/x.txt")).toEqual({ ok: false, reason: "outside_root" });
  });

  it("compares the canonical root case-insensitively on win32 only", () => {
    // The canonical root is spelled in upper case; the directory resolves to the requested spelling.
    const upper = ROOT.toUpperCase();
    const fs = fakeFs(
      { [ROOT]: "dir", [join(ROOT, "dir")]: "dir" },
      { [ROOT]: upper, [join(ROOT, "dir")]: join(ROOT, "dir") },
    );
    const expected =
      process.platform === "win32" ? { ok: true } : { ok: false, reason: "outside_root" };
    expect(createPathGuard(ROOT, fs)("dir/x.txt")).toMatchObject(expected);
  });
});

describe("PathGuard (links, real filesystem)", () => {
  let base: string;
  let root: string;
  let outside: string;
  let fileLinksOk = true;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "haril-pathguard-"));
    root = join(base, "project");
    outside = join(base, "outside");
    mkdirSync(join(root, "inside"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export {};\n", "utf8");
    writeFileSync(join(outside, "secret.txt"), "secret outside\n", "utf8");
    symlinkSync(outside, join(root, "jout"), "junction");
    symlinkSync(join(root, "inside"), join(root, "jin"), "junction");
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "fout.txt"));
    } catch (error) {
      fileLinksOk = false;
      console.warn(`skipped file symlink case: ${(error as NodeJS.ErrnoException).code}`);
    }
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("allows an existing regular nested file", () => {
    expect(createPathGuard(root)("src/a.ts").ok).toBe(true);
  });

  it("denies a directory junction inside the root that points outside", () => {
    expect(createPathGuard(root)("jout/secret.txt")).toEqual({ ok: false, reason: "link" });
  });

  it("denies a directory junction inside the root that points inside too (links are refused)", () => {
    expect(createPathGuard(root)("jin/anything.txt")).toEqual({ ok: false, reason: "link" });
  });

  it("denies a file symlink that points outside the root", () => {
    if (!fileLinksOk) return;
    expect(createPathGuard(root)("fout.txt")).toEqual({ ok: false, reason: "link" });
  });
});
