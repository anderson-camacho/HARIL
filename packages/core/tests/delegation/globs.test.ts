import { describe, expect, it } from "vitest";
import { globsMayOverlap, surfacesMayOverlap } from "../../src/delegation/index.js";

// Surface overlap (docs/modos-y-delegacion.md 3.10, spike S5 in ADR-0021). Conservative: false only when the two
// patterns provably match no common path. Every case is checked in both argument orders.

const S5_CASES: readonly [string, string, boolean][] = [
  ["src/a.ts", "src/a.ts", true],
  ["src/a.ts", "src/b.ts", false],
  ["src/*.ts", "src/a.ts", true],
  ["src/*.ts", "src/lib/a.ts", false],
  ["src/**", "src/lib/deep/a.ts", true],
  ["src/**/*.ts", "src/*.md", false],
  ["src/**/*.ts", "**/test/*.ts", true],
  ["docs/**", "src/**", false],
  ["src/a?.ts", "src/ab.ts", true],
  ["src/a?.ts", "src/a.ts", false],
  ["*.json", "package.json", true],
  ["packages/*/src/**", "packages/core/tests/x.ts", false],
  ["src/", "src/x/y.ts", true],
  ["src/{a,b}.ts", "lib/c.ts", true],
  ["SRC/A.ts", "src/a.ts", true],
  ["a*b", "*c*", true],
  ["a*b", "c*", false],
];

const EXTRA_CASES: readonly [string, string, boolean][] = [
  // Unsupported syntax, parent segments and "**" inside a segment cannot be proved disjoint.
  ["src/[ab].ts", "lib/c.ts", true],
  ["!src/a.ts", "lib/c.ts", true],
  ["src\\a.ts", "lib/c.ts", true],
  ["../outside.ts", "lib/c.ts", true],
  ["src/a**b.ts", "lib/c.ts", true],
  // The root folder, written as "./" or ".", names the whole tree.
  ["./", "anything/at/all.ts", true],
  [".", "anything/at/all.ts", true],
  // Leading "./", repeated slashes and repeated "**" do not change the answer.
  ["./src//a.ts", "src/a.ts", true],
  ["src/**/**/a.ts", "src/x/a.ts", true],
  ["src/**/a.ts", "src/a.ts", true],
  // A literal path may be an existing folder: "src/x/b.ts" could hold "src/x/b.ts/a.ts".
  ["src/**/a.ts", "src/x/b.ts", true],
  ["src/**/a.ts", "src/x/b.*", false],
  ["**", "x", true],
  ["*/a.ts", "x/y/a.ts", false],
  // A literal path that is a leading-segment prefix of the other names a folder that holds it.
  ["src", "src/a.ts", true],
  ["src/lib", "src/lib/deep/x.ts", true],
  ["src/lib", "src/library/x.ts", false],
  ["src/lib", "src/*/x.ts", true],
  ["src/a.ts", "src/b.ts", false],
  // Both sides are compared in NFC: a precomposed and a decomposed accent are the same name.
  ["src/café.ts", "src/café.ts", true],
  ["src/café/", "src/café/x.ts", true],
];

describe("globsMayOverlap with oversized input", () => {
  it("answers overlap, without throwing, for a pattern longer than the limit", () => {
    const long = `src/${"a".repeat(6_000)}.ts`;
    expect(globsMayOverlap(long, "lib/x.ts")).toBe(true);
    expect(globsMayOverlap("lib/x.ts", long)).toBe(true);
  });

  it("answers overlap for a long run of wildcards, quickly", () => {
    const stars = `src/${"*a".repeat(3_000)}`;
    const started = Date.now();
    expect(globsMayOverlap(stars, `src/${"*b".repeat(3_000)}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("answers overlap for very many segments", () => {
    const deep = Array.from({ length: 2_000 }, (_, index) => `d${index}`).join("/");
    expect(globsMayOverlap(deep, "other/x.ts")).toBe(true);
    expect(globsMayOverlap(`${deep}/**`, "elsewhere/**")).toBe(true);
  });

  it("still decides patterns at the limit exactly, within a few milliseconds", () => {
    const left = `src/${"*a".repeat(250)}`;
    const right = `lib/${"*b".repeat(250)}`;
    const started = Date.now();
    expect(globsMayOverlap(left, right)).toBe(false);
    expect(globsMayOverlap(left, `src/${"a*".repeat(250)}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("globsMayOverlap", () => {
  it.each(S5_CASES)("S5: %s ~ %s is %s", (left, right, expected) => {
    expect(globsMayOverlap(left, right)).toBe(expected);
    expect(globsMayOverlap(right, left)).toBe(expected);
  });

  it.each(EXTRA_CASES)("%s ~ %s is %s", (left, right, expected) => {
    expect(globsMayOverlap(left, right)).toBe(expected);
    expect(globsMayOverlap(right, left)).toBe(expected);
  });
});

describe("surfacesMayOverlap", () => {
  it("is true when any pattern of one surface may overlap any pattern of the other", () => {
    expect(surfacesMayOverlap(["docs/**", "src/a.ts"], ["lib/**", "src/*.ts"])).toBe(true);
  });

  it("is false when every pair is disjoint", () => {
    expect(surfacesMayOverlap(["docs/**"], ["src/**", "tests/**"])).toBe(false);
  });

  it("is false when either surface is empty: a read-only task locks nothing", () => {
    expect(surfacesMayOverlap([], ["src/**"])).toBe(false);
    expect(surfacesMayOverlap(["src/**"], [])).toBe(false);
  });
});
