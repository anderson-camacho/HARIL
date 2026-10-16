import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBlockRegistry } from "../src/index.js";

// The native blocks shipped in the repository root (blocks/, ADR-0014 D8).
const HERE = dirname(fileURLToPath(import.meta.url));
const NATIVE = resolve(HERE, "../../../blocks");

const ODD_TEXT = readFileSync(join(NATIVE, "methodologies", "odd", "block.md"), "utf8");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "haril-blocks-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeBlock(relative: string, text: string): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("loadBlockRegistry over the native blocks", () => {
  it("loads the three native methodologies sorted by id", () => {
    const result = loadBlockRegistry(NATIVE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.list().map((entry) => entry.id)).toEqual([
      "haril.methodology.custom",
      "haril.methodology.odd",
      "haril.methodology.tdd",
    ]);
  });

  it("hashes the exact bytes of each block file", () => {
    const result = loadBlockRegistry(NATIVE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const odd = result.registry.get("haril.methodology.odd");
    expect(odd?.sha256).toBe(sha256(ODD_TEXT));
    expect(odd?.version).toBe("0.1.0");
    expect(odd?.summary.length).toBeGreaterThan(0);
  });

  it("returns undefined for an unknown id", () => {
    const result = loadBlockRegistry(NATIVE);
    expect(result.ok && result.registry.get("haril.methodology.scrum")).toBeUndefined();
  });
});

describe("loadBlockRegistry fails closed", () => {
  it("rejects the whole registry when one block lacks a required field", () => {
    writeBlock("methodologies/odd/block.md", ODD_TEXT);
    writeBlock(
      "methodologies/broken/block.md",
      "---\n" +
        JSON.stringify({
          id: "haril.methodology.broken",
          version: "0.1.0",
          category: "methodology",
        }) +
        "\n---\n",
    );
    const result = loadBlockRegistry(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.path).toBe("methodologies/broken/block.md");
    expect(result.rejected[0]?.reasons.join("\n")).toMatch(/capabilities|dependencies|config/);
  });

  it("rejects a block whose body has unbalanced section markers", () => {
    const text = ODD_TEXT.replace("<!-- /haril:section:odd-protocol -->", "");
    writeBlock("methodologies/odd/block.md", text);
    const result = loadBlockRegistry(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejected[0]?.reasons.join("\n")).toMatch(/section/);
  });

  it("rejects an id outside the reserved haril namespace", () => {
    const text = ODD_TEXT.replace('"id": "haril.methodology.odd"', '"id": "acme.methodology.odd"');
    writeBlock("methodologies/odd/block.md", text);
    const result = loadBlockRegistry(dir);
    expect(result.ok).toBe(false);
  });

  it("rejects a methodology role whose agent is not declared in dependencies", () => {
    const text = ODD_TEXT.replace('"id": "haril.agent.developer"', '"id": "haril.agent.other"');
    expect(text).not.toBe(ODD_TEXT);
    writeBlock("methodologies/odd/block.md", text);
    const result = loadBlockRegistry(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejected[0]?.reasons.join("\n")).toMatch(/haril.agent.developer/);
  });

  it("rejects a payload section whose id has no marker in the body", () => {
    const text = ODD_TEXT.replace(
      "<!-- haril:section:odd-protocol -->",
      "<!-- haril:section:other -->",
    ).replace("<!-- /haril:section:odd-protocol -->", "<!-- /haril:section:other -->");
    writeBlock("methodologies/odd/block.md", text);
    const result = loadBlockRegistry(dir);
    expect(result.ok).toBe(false);
  });

  it("fails when the blocks directory does not exist", () => {
    const result = loadBlockRegistry(join(dir, "missing"));
    expect(result.ok).toBe(false);
  });
});
