import { describe, expect, it } from "vitest";
import { parseStrictJson } from "../src/index.js";

// Frontmatter subset (ADR-0014 D4, D6): a single JSON document, no duplicate keys, no __proto__.
describe("parseStrictJson", () => {
  it("parses objects, arrays, strings, numbers, booleans and null", () => {
    const result = parseStrictJson('{"a":[1,-2.5,true,false,null],"b":"x\\n\\u0041"}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { a: unknown[]; b: string };
    expect(value.a).toEqual([1, -2.5, true, false, null]);
    expect(value.b).toBe("x\nA");
  });

  it("builds objects without a prototype", () => {
    const result = parseStrictJson('{"a":{"b":1}}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outer = result.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(outer)).toBeNull();
    expect(Object.getPrototypeOf(outer.a)).toBeNull();
  });

  it("rejects a duplicate key", () => {
    const result = parseStrictJson('{"id":"a","id":"b"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/duplicate key "id"/);
  });

  it("rejects a __proto__ key", () => {
    const result = parseStrictJson('{"__proto__":{"polluted":true}}');
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown token such as an unquoted key", () => {
    expect(parseStrictJson("{id: 1}").ok).toBe(false);
  });

  it("rejects trailing content after the document", () => {
    expect(parseStrictJson('{"a":1} {"b":2}').ok).toBe(false);
  });

  it("rejects a tab used as whitespace", () => {
    const result = parseStrictJson('{\t"a":1}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/tab/);
  });

  it("rejects nesting deeper than the limit", () => {
    const deep = `${"[".repeat(40)}${"]".repeat(40)}`;
    expect(parseStrictJson(deep).ok).toBe(false);
  });

  it("rejects an unescaped control character inside a string", () => {
    expect(parseStrictJson('{"a":"x\u0001"}').ok).toBe(false);
  });

  it("rejects an empty document", () => {
    expect(parseStrictJson("   ").ok).toBe(false);
  });
});
