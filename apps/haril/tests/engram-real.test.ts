import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configuredRuntimeMemory } from "../src/runtime/memory.js";

// Explicit opt-in. Never accesses the user's memory or relies on an installed daemon.
describe.skipIf(!process.env.HARIL_TEST_ENGRAM_BINARY)("real pinned Engram", () => {
  it("authenticates, persists, searches, recalls, and stops its owned process", async () => {
    const root = mkdtempSync(join(tmpdir(), "haril-real-engram-"));
    const config = join(root, "haril.json");
    writeFileSync(
      config,
      JSON.stringify({
        memory: {
          provider: "engram",
          binary: process.env.HARIL_TEST_ENGRAM_BINARY,
          version: "3.6.0",
        },
      }),
    );
    const memory = configuredRuntimeMemory(
      {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        homeDir: homedir(),
        env: { ...process.env, HARIL_CONFIG: config },
      },
      join(root, "data"),
      {
        now: () => Date.now(),
        schedule: (ms, fn) => {
          const timer = setTimeout(fn, ms);
          return () => clearTimeout(timer);
        },
      },
    );
    try {
      const health = await memory.provider.health();
      expect(health, JSON.stringify(health)).toMatchObject({ state: "active" });
      const content = "Verified durable quartz memory for HARIL";
      const scope = {
        workspaceId: "fixture",
        projectKey: "project",
        visibility: "project" as const,
        sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      };
      const saved = await memory.provider.store({
        schemaVersion: 1,
        operationId: "real-test-write",
        scope: { ...scope, kind: "discovery" },
        title: "Quartz integration",
        content,
        contentSha256: createHash("sha256").update(content).digest("hex"),
        topicKey: "integration/quartz",
        origin: "haril",
      });
      expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true });
      const found = await memory.provider.search({
        schemaVersion: 1,
        scope,
        text: "quartz",
        matchMode: "all",
        limit: 5,
      });
      expect(found, JSON.stringify(found)).toMatchObject({ ok: true });
      expect(found.ok && found.value.items.length).toBe(1);
      const recalled = await memory.provider.recall({
        schemaVersion: 1,
        scope,
        query: "quartz",
        budgetTokens: 500,
        maxItems: 5,
        includePinned: true,
      });
      expect(recalled, JSON.stringify(recalled)).toMatchObject({ ok: true });
      expect(recalled.ok && recalled.value.items[0]?.content).toBe(content);
      const replay = await memory.provider.store({
        schemaVersion: 1,
        operationId: "real-test-write",
        scope: { ...scope, kind: "discovery" },
        title: "Quartz integration",
        content,
        contentSha256: createHash("sha256").update(content).digest("hex"),
        topicKey: "integration/quartz",
        origin: "haril",
      });
      expect(replay).toMatchObject({ ok: true });
      const after = await memory.provider.search({
        schemaVersion: 1,
        scope,
        text: "quartz",
        matchMode: "all",
        limit: 5,
      });
      expect(after.ok && after.value.items.length).toBe(1);
    } finally {
      await memory.close?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 45000);
});
