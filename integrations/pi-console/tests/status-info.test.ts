import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryText } from "../src/dashboard-data.js";
import {
  contextFiles,
  declaredPackages,
  extensionInventory,
  extensionRows,
  packageUpdates,
  statusLines,
} from "../src/status-info.js";

describe("what Pi lists at startup, kept for the panel and /haril-status", () => {
  it("proves extensions from registered sources and labels what is only declared", () => {
    const entries = extensionInventory(
      [
        { sourceInfo: { path: "C:\\app\\console.mjs", source: "cli" } },
        { sourceInfo: { path: "x", source: "npm:pi-claude-bridge@0.9.3" } },
        { sourceInfo: { path: "builtin:read", source: "builtin" } },
        {},
      ],
      ["npm:pi-claude-bridge@0.9.3", "npm:pi-context-view", "git:github.com/owner/pi-player"],
    );
    expect(entries).toEqual([
      { name: "console.mjs", state: "registered" },
      { name: "pi-claude-bridge", state: "registered" },
      { name: "pi-context-view", state: "declared" },
      { name: "pi-player", state: "declared" },
    ]);
    expect(extensionRows(entries, "es")).toContain("pi-context-view (declarada)");
    expect(extensionRows([], "es")).toEqual(["Ninguna conocida"]);
  });

  it("reads packages defensively", () => {
    expect(declaredPackages('{"packages":["npm:a",{"source":"npm:b"},3]}')).toEqual([
      "npm:a",
      "npm:b",
    ]);
    expect(declaredPackages("{ broken")).toEqual([]);
    expect(declaredPackages(undefined)).toEqual([]);
  });

  it("prefers Pi's list of context files and otherwise walks like Pi", () => {
    expect(contextFiles([{ path: "/p/AGENTS.md" }], "/p", undefined)).toEqual(["/p/AGENTS.md"]);
    const found = join("/agent", "AGENTS.md");
    const local = join("/p", "q", "CLAUDE.md");
    expect(
      contextFiles(undefined, join("/p", "q"), "/agent", (path) => [found, local].includes(path)),
    ).toEqual([found, local]);
  });

  it("reports npm updates, skips pinned and offline, and survives a failed lookup", async () => {
    const base = {
      agentDir: "/a",
      installed: () => "1.0.0",
      latest: async (name: string) => {
        if (name === "broken") throw new Error("network");
        return name === "same" ? "1.0.0" : "2.0.0";
      },
    };
    const packages = ["npm:new", "npm:same", "npm:pin@1.0.0", "npm:broken", "git:x/y"];
    expect(await packageUpdates({ ...base, packages, offline: false })).toEqual(["new"]);
    expect(await packageUpdates({ ...base, packages, offline: true })).toEqual([]);
  });

  it("gives /haril-status every section with real data", () => {
    const text = statusLines({
      locale: "es",
      version: "0.0.1",
      cwd: "fake-cwd",
      project: "fake",
      mode: "ACTION",
      modelLevel: "m · low",
      context: "12%",
      cost: "$0.000",
      runtime: "idle",
      memory: "sin comprobar",
      warnings: ["Actualizaciones de paquetes: a"],
      extensions: [{ name: "pi-context-view", state: "declared" }],
      contextFiles: ["AGENTS.md"],
      shortcuts: [{ key: "alt+x", description: "Stop" }],
    }).join("\n");
    for (const part of [
      "AVISOS · 1",
      "Actualizaciones de paquetes: a",
      "EXTENSIONES · 1",
      "pi-context-view (declarada)",
      "CONTEXTO · 1",
      "AGENTS.md",
      "SESIÓN",
      "HARIL 0.0.1",
      "ATAJOS",
      "alt+x · Stop",
    ]) {
      expect(text).toContain(part);
    }
  });
});

describe("the memory line of the panel", () => {
  it("never prints a null provider or not_checked", () => {
    const unchecked = { provider: "null", health: "not_checked", degraded: false };
    expect(memoryText(unchecked, { depth: 0 })).toBe("no provider · not checked yet");
    expect(memoryText({ ...unchecked, configured: "engram" }, undefined)).toBe(
      "engram (configured) · not checked yet",
    );
    expect(memoryText({ ...unchecked, configured: "null" }, undefined)).toContain("no provider");
  });

  it("names the provider in use, and says degraded and the queue only when they matter", () => {
    const active = { provider: "engram", health: "active", degraded: true };
    expect(memoryText(active, { depth: 2 })).toBe("engram · active · degraded · outbox 2");
  });
});
