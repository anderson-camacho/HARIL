import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMemorySettings, memorySectionErrors } from "../src/memory-config.js";
import { configDocumentErrors } from "../src/providers.js";

const roots: string[] = [];
function fixture(value?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "haril-memory-config-"));
  roots.push(root);
  const path = join(root, "haril.json");
  if (value !== undefined) writeFileSync(path, JSON.stringify(value));
  return {
    path,
    root,
    host: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      homeDir: root,
      env: { HARIL_CONFIG: path },
    },
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("memory configuration", () => {
  it("keeps null unless explicitly enabled", () => {
    const { host } = fixture({});
    expect(loadMemorySettings(host).provider).toBe("null");
  });
  it("accepts the pinned executable and preserves normal provider validation", () => {
    const binary = join(tmpdir(), "engram.exe");
    const document = { memory: { provider: "engram", binary, version: "3.6.0" } };
    const { host } = fixture(document);
    expect(loadMemorySettings(host)).toEqual(document.memory);
    expect(configDocumentErrors(document)).toEqual([]);
  });
  it.each([
    null,
    { provider: "other" },
    { provider: "engram", binary: "engram" },
    { provider: "engram", version: "latest" },
    { provider: "engram", token: "not-allowed" },
  ])("rejects invalid memory settings %j", (value) => {
    expect(memorySectionErrors(value).length).toBeGreaterThan(0);
    const { host } = fixture({ memory: value });
    expect(() => loadMemorySettings(host)).toThrow();
    expect(configDocumentErrors({ memory: value }).length).toBeGreaterThan(0);
  });
  it("does not silently fall back when an explicit config is missing or malformed", () => {
    const { host, path } = fixture();
    expect(() => loadMemorySettings(host)).toThrow("does not exist");
    writeFileSync(path, "{");
    expect(() => loadMemorySettings(host)).toThrow();
  });
});
