import { describe, expect, it } from "vitest";
import { checkWorkspacePath, globMatches, pathMatchesSurface } from "../../src/delegation/index.js";

// The lexical half of the workspace PathGuard (docs/modos-y-delegacion.md 3.10.5, section 8): a path an agent asks to
// write is relative to its worktree, never absolute, never climbs out, never names .git, .haril, .pi or a secret, and
// must fall inside the task's declared write surface. The filesystem half (links, junctions, the real location) runs in
// the host before the write.

describe("globMatches", () => {
  const cases: readonly [string, string, boolean][] = [
    ["src/a.ts", "src/a.ts", true],
    ["src/a.ts", "src/b.ts", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/lib/a.ts", false],
    ["src/**", "src/lib/deep/a.ts", true],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/x/y/a.ts", true],
    ["src/**/*.ts", "src/x/a.md", false],
    ["src/a?.ts", "src/ab.ts", true],
    ["src/a?.ts", "src/a.ts", false],
    ["*.json", "package.json", true],
    ["*.json", "sub/package.json", false],
    // A folder ending in "/" and a literal path name their subtree (S5's folder rule).
    ["src/", "src/x/y.ts", true],
    ["src", "src/x/y.ts", true],
    ["src", "srcx/y.ts", false],
    // ASCII letters compare without case (Windows paths are case-insensitive).
    ["SRC/A.ts", "src/a.ts", true],
    // Unsupported syntax never matches: a write it cannot prove inside the surface is refused.
    ["src/{a,b}.ts", "src/a.ts", false],
    ["src/[ab].ts", "src/a.ts", false],
    ["!src/a.ts", "src/b.ts", false],
    ["../x.ts", "x.ts", false],
    ["src/a**b.ts", "src/ab.ts", false],
    // "." and "./" name the whole tree.
    [".", "deep/a.ts", true],
    ["./", "deep/a.ts", true],
  ];
  for (const [glob, path, expected] of cases) {
    it(`${glob} ${expected ? "matches" : "does not match"} ${path}`, () => {
      expect(globMatches(glob, path)).toBe(expected);
    });
  }

  it("answers false for a pattern longer than the contract allows", () => {
    expect(globMatches(`${"a".repeat(600)}*`, "a")).toBe(false);
  });

  it("matches a path against any glob of a surface, and nothing against an empty surface", () => {
    expect(pathMatchesSurface("docs/guide.md", ["src/**", "docs/*.md"])).toBe(true);
    expect(pathMatchesSurface("tests/a.test.ts", ["src/**", "docs/*.md"])).toBe(false);
    expect(pathMatchesSurface("src/a.ts", [])).toBe(false);
  });

  it("compares letter case only when asked, as a case-sensitive file system does", () => {
    expect(globMatches("src/Button.ts", "src/button.ts")).toBe(true);
    expect(globMatches("src/Button.ts", "src/button.ts", { caseSensitive: true })).toBe(false);
    expect(globMatches("src/*.ts", "SRC/a.ts", { caseSensitive: true })).toBe(false);
    expect(globMatches("src/**", "src/A.ts", { caseSensitive: true })).toBe(true);
    expect(pathMatchesSurface("SRC/a.ts", ["src/**"], { caseSensitive: true })).toBe(false);
    expect(checkWorkspacePath("SRC/a.ts", ["src/**"], { caseSensitive: true })).toEqual({
      ok: false,
      reason: "outside_surface",
    });
    expect(checkWorkspacePath("SRC/a.ts", ["src/**"])).toEqual({ ok: true, path: "SRC/a.ts" });
  });
});

describe("checkWorkspacePath", () => {
  const surface = ["src/**", "tests/a.test.ts"];

  it("accepts a relative path inside the surface and returns it normalized", () => {
    expect(checkWorkspacePath("src/lib/a.ts", surface)).toEqual({ ok: true, path: "src/lib/a.ts" });
    expect(checkWorkspacePath("./src//lib/a.ts", surface)).toEqual({
      ok: true,
      path: "src/lib/a.ts",
    });
    expect(checkWorkspacePath("src\\lib\\a.ts", surface)).toEqual({
      ok: true,
      path: "src/lib/a.ts",
    });
    expect(checkWorkspacePath("tests/a.test.ts", surface)).toEqual({
      ok: true,
      path: "tests/a.test.ts",
    });
  });

  it("refuses a path outside the surface", () => {
    expect(checkWorkspacePath("tests/b.test.ts", surface)).toEqual({
      ok: false,
      reason: "outside_surface",
    });
    expect(checkWorkspacePath("README.md", surface)).toEqual({
      ok: false,
      reason: "outside_surface",
    });
    expect(checkWorkspacePath("src/a.ts", [])).toEqual({ ok: false, reason: "outside_surface" });
  });

  it("refuses absolute paths, drives, UNC shares and alternate streams", () => {
    for (const path of [
      "/etc/passwd",
      "\\Windows\\x",
      "C:\\x\\a.ts",
      "c:/x.ts",
      "\\\\server\\share\\a",
    ]) {
      expect(checkWorkspacePath(path, ["**"]).ok, path).toBe(false);
    }
    expect(checkWorkspacePath("src/a.ts:stream", ["**"])).toEqual({
      ok: false,
      reason: "drive_or_stream",
    });
  });

  it("refuses traversal anywhere in the path", () => {
    for (const path of ["../a.ts", "src/../../a.ts", "src/..", "..\\a.ts", "src/..\\..\\x"]) {
      expect(checkWorkspacePath(path, ["**"]), path).toEqual({ ok: false, reason: "traversal" });
    }
  });

  it("refuses .git, .haril and .pi in any segment and in any case", () => {
    for (const path of [
      ".git/config",
      "src/.git",
      ".GIT/hooks/pre-commit",
      ".haril/x",
      "a/.pi/x",
    ]) {
      expect(checkWorkspacePath(path, ["**"]), path).toEqual({ ok: false, reason: "denied_path" });
    }
  });

  it("refuses a Windows short name (a tilde and a digit) in any segment, on every platform", () => {
    // NTFS gives .git the alias GIT~1: a write to GIT~1 would replace the worktree's .git pointer.
    for (const path of [
      "GIT~1",
      "GIT~1/config",
      "src/HARIL~1/x.ts",
      "ENV~1",
      "a/PI~2/b",
      "x~9.ts",
    ]) {
      expect(checkWorkspacePath(path, ["**"]), path).toEqual({ ok: false, reason: "short_name" });
    }
    expect(checkWorkspacePath("src/a~b.ts", ["**"])).toEqual({ ok: true, path: "src/a~b.ts" });
    expect(checkWorkspacePath("src/backup~", ["**"])).toEqual({ ok: true, path: "src/backup~" });
  });

  it("refuses files that look like secrets", () => {
    for (const path of [
      ".env",
      "app/.env.local",
      ".npmrc",
      ".netrc",
      "_netrc",
      ".git-credentials",
      ".aws/credentials",
      "home/.ssh/config",
      "certs/server.pem",
      "certs/server.key",
      "store.p12",
      "id_rsa",
      "keys/id_ed25519",
      ".pypirc",
    ]) {
      expect(checkWorkspacePath(path, ["**"]), path).toEqual({ ok: false, reason: "secret_path" });
    }
    // A public key and an example file are not secrets.
    expect(checkWorkspacePath("keys/id_ed25519.pub", ["**"]).ok).toBe(true);
    expect(checkWorkspacePath("docs/keys.md", ["**"]).ok).toBe(true);
  });

  it("refuses empty paths, control characters, reserved device names and trailing dots or spaces", () => {
    expect(checkWorkspacePath("", ["**"])).toEqual({ ok: false, reason: "empty_path" });
    expect(checkWorkspacePath("./", ["**"])).toEqual({ ok: false, reason: "empty_path" });
    expect(checkWorkspacePath("src/a\u0000.ts", ["**"])).toEqual({
      ok: false,
      reason: "control_character",
    });
    expect(checkWorkspacePath("src/con.ts", ["**"])).toEqual({
      ok: false,
      reason: "reserved_name",
    });
    expect(checkWorkspacePath("NUL", ["**"])).toEqual({ ok: false, reason: "reserved_name" });
    expect(checkWorkspacePath("src/a.ts.", ["**"])).toEqual({
      ok: false,
      reason: "trailing_dot_or_space",
    });
    expect(checkWorkspacePath("src /a.ts", ["**"])).toEqual({
      ok: false,
      reason: "trailing_dot_or_space",
    });
  });

  it("refuses a path longer than 1024 characters", () => {
    expect(checkWorkspacePath(`src/${"a".repeat(1100)}.ts`, ["**"])).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("checks a non-string as an empty path, never throwing", () => {
    expect(checkWorkspacePath(42 as unknown as string, ["**"])).toEqual({
      ok: false,
      reason: "empty_path",
    });
  });
});
