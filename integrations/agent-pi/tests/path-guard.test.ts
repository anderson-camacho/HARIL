import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createPathGuard } from "../src/path-guard.js";

const ROOT = resolve("fixture-project-root");
const guard = createPathGuard(ROOT);

describe("PathGuard (lexical)", () => {
  it.each(["notes.txt", "src/a.ts", "./src/../src/b.ts", "..secret.txt", join(ROOT, "x.txt")])(
    "allows %s inside the project root",
    (requested) => {
      const result = guard(requested);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.absolutePath.startsWith(ROOT)).toBe(true);
    },
  );

  it.each([
    "../secret.txt",
    "src/../../secret.txt",
    join(dirname(ROOT), "outside.txt"),
    "\\\\server\\share\\a.txt",
    "//server/share/a.txt",
    "\\\\?\\C:\\a.txt",
    "\\\\.\\pipe\\haril-x",
    "C:secret.txt",
    "notes.txt:stream",
    "",
    "a\u0000b",
  ])("denies %j", (requested) => {
    expect(guard(requested)).toMatchObject({ ok: false });
  });

  it("denies the project root itself", () => {
    expect(guard(".")).toMatchObject({ ok: false });
  });
});
