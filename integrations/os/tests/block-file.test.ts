import { describe, expect, it } from "vitest";
import { checkSectionMarkers, parseBlockFile } from "../src/index.js";

const FRONT = '{\n  "id": "haril.methodology.tdd"\n}';

describe("parseBlockFile", () => {
  it("splits a valid file into frontmatter JSON and body", () => {
    const text = `---\n${FRONT}\n---\n<!-- haril:section:a -->\nText.\n<!-- /haril:section:a -->\n`;
    const result = parseBlockFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frontmatter).toMatchObject({ id: "haril.methodology.tdd" });
      expect(result.body).toContain("<!-- haril:section:a -->");
    }
  });

  it("accepts CRLF line endings", () => {
    const text = `---\r\n${FRONT}\r\n---\r\nBody\r\n`;
    expect(parseBlockFile(text).ok).toBe(true);
  });

  it("rejects a file without the opening --- line", () => {
    expect(parseBlockFile(`${FRONT}\n---\nBody\n`).ok).toBe(false);
  });

  it("rejects a file without the closing --- line", () => {
    expect(parseBlockFile(`---\n${FRONT}\nBody\n`).ok).toBe(false);
  });

  it("rejects a tab anywhere in the frontmatter", () => {
    const result = parseBlockFile(`---\n{\n\t"id": "x"\n}\n---\nBody\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/tab/);
  });

  it("rejects a byte order mark", () => {
    expect(parseBlockFile(`﻿---\n${FRONT}\n---\nBody\n`).ok).toBe(false);
  });

  it("rejects an invalid frontmatter document with the JSON reason", () => {
    const result = parseBlockFile(`---\n{"id":"a","id":"b"}\n---\nBody\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/duplicate key/);
  });
});

describe("checkSectionMarkers", () => {
  it("returns the section ids of a balanced body", () => {
    const body =
      "<!-- haril:section:a -->\nx\n<!-- /haril:section:a -->\n<!-- haril:section:b -->\ny\n<!-- /haril:section:b -->\n";
    const result = checkSectionMarkers(body);
    expect(result).toEqual({ ok: true, sectionIds: ["a", "b"] });
  });

  it("accepts a body without sections", () => {
    expect(checkSectionMarkers("plain text\n")).toEqual({ ok: true, sectionIds: [] });
  });

  it("rejects a section that is never closed", () => {
    const result = checkSectionMarkers("<!-- haril:section:a -->\nx\n");
    expect(result.ok).toBe(false);
  });

  it("rejects a close marker without an open one", () => {
    expect(checkSectionMarkers("<!-- /haril:section:a -->\n").ok).toBe(false);
  });

  it("rejects a close marker whose id does not match the open one", () => {
    const result = checkSectionMarkers("<!-- haril:section:a -->\n<!-- /haril:section:b -->\n");
    expect(result.ok).toBe(false);
  });

  it("rejects a nested section", () => {
    const body =
      "<!-- haril:section:a -->\n<!-- haril:section:b -->\n<!-- /haril:section:b -->\n<!-- /haril:section:a -->\n";
    expect(checkSectionMarkers(body).ok).toBe(false);
  });

  it("rejects a duplicate section id", () => {
    const body =
      "<!-- haril:section:a -->\n<!-- /haril:section:a -->\n<!-- haril:section:a -->\n<!-- /haril:section:a -->\n";
    const result = checkSectionMarkers(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(/duplicate/);
  });

  it("rejects a malformed haril marker", () => {
    expect(
      checkSectionMarkers("<!-- haril:section:A_B -->\n<!-- /haril:section:A_B -->\n").ok,
    ).toBe(false);
  });
});
