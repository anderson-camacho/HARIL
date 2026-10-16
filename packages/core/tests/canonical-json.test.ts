import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/domain/index.js";

// Canonical JSON (M1-T5): object keys sorted at every depth, arrays kept in order. It keys plan imports.
describe("canonicalJson", () => {
  it("sorts object keys at every depth, so key order does not matter", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: { c: null, d: [{ y: 2, z: 1 }] }, b: 1 })).toBe(
      canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }),
    );
  });

  it("keeps array order", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });
});
