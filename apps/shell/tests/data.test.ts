import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShellData, type ShellPaths } from "../src/data.js";
import { openSeedStore, SEED_TITLES, seedStore } from "./seed.js";

// Data access (TUI-D4): the shell opens the store like the CLI's openExisting (inspect first, never create it) and
// reads through the Store facets only. Nothing here starts the runtime or writes task rows.

let root: string;
let dataDir: string;
let runtimeRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-data-"));
  dataDir = join(root, "data");
  runtimeRoot = join(root, "runtime");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(runtimeRoot, "config", "themes"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function paths(overrides: Partial<ShellPaths> = {}): ShellPaths {
  return {
    dataDir,
    runtimeRoot,
    configPath: join(runtimeRoot, "config", "haril.json"),
    ...overrides,
  };
}

describe("openShellData with a seeded store", () => {
  it("loads projects, tasks, events, runtime and metrics from the store", () => {
    seedStore(dataDir);
    const data = openShellData({ paths: paths(), env: {} });
    try {
      const snapshot = data.load(undefined);
      expect(snapshot.initialized).toBe(true);
      expect(snapshot.storeError).toBeUndefined();
      expect(snapshot.projects.map((project) => project.slug).sort()).toEqual(["demo", "other"]);
      expect(snapshot.tasks.map((task) => task.goal).sort()).toEqual(
        [
          SEED_TITLES.completed,
          SEED_TITLES.pending,
          SEED_TITLES.running,
          SEED_TITLES.unrelated,
        ].sort(),
      );
      expect(snapshot.runtime.status).toBe("active");
      expect(snapshot.events.some((event) => event.type === "task.created")).toBe(true);
      const demo = snapshot.metrics.find((entry) => entry.slug === "demo");
      expect(demo?.snapshot.tasksByState.completed).toBe(1);
      expect(demo?.usage?.inputTokens).toBe(40);
    } finally {
      data.close();
    }
  });

  it("filters the events and metrics to the scope project", () => {
    const seeded = seedStore(dataDir);
    const data = openShellData({ paths: paths(), env: {} });
    try {
      const scoped = data.load(seeded.otherId);
      expect(scoped.events.length).toBeGreaterThan(0);
      expect(scoped.events.every((event) => event.projectId === seeded.otherId)).toBe(true);
    } finally {
      data.close();
    }
  });

  it("reads one task with its result, verification, denials and settled tokens", () => {
    const seeded = seedStore(dataDir);
    const data = openShellData({ paths: paths(), env: {} });
    try {
      const view = data.taskDetail(seeded.completedTaskId);
      expect(view?.detail.result).toMatchObject({ text: "Logs summarized" });
      expect(view?.tokens).toEqual({ input: 40, output: 12, unreconciled: 0 });
      expect(view?.permissionDenials).toBe(1);
      expect(data.taskDetail("no-such-task")).toBeUndefined();
    } finally {
      data.close();
    }
  });
});

describe("openShellData without a store", () => {
  it("reports an uninitialized store and never creates the database", () => {
    const data = openShellData({ paths: paths(), env: {} });
    try {
      const snapshot = data.load(undefined);
      expect(snapshot.initialized).toBe(false);
      expect(snapshot.projects).toEqual([]);
      expect(snapshot.tasks).toEqual([]);
      expect(existsSync(join(dataDir, "haril.db"))).toBe(false);
    } finally {
      data.close();
    }
  });

  it("reports a store it cannot open as a store error instead of throwing", () => {
    writeFileSync(join(dataDir, "haril.db"), "this is not a sqlite database");
    const data = openShellData({ paths: paths(), env: {} });
    try {
      const snapshot = data.load(undefined);
      expect(snapshot.initialized).toBe(true);
      expect(snapshot.storeError).toBeTypeOf("string");
      expect(snapshot.projects).toEqual([]);
    } finally {
      data.close();
    }
  });
});

describe("providers and themes", () => {
  it("lists configured providers with set or not set for their key variable, never the value", () => {
    const secret = "fake-key-test-secret-value-9876";
    writeFileSync(
      join(runtimeRoot, "config", "haril.json"),
      JSON.stringify({
        providers: [
          { id: "gateway", baseUrl: "http://127.0.0.1:8317/v1", keyEnv: "SHELL_TEST_KEY" },
          { id: "local", baseUrl: "http://localhost:11434/v1", keyEnv: "SHELL_TEST_MISSING" },
        ],
      }),
    );
    const data = openShellData({ paths: paths(), env: { SHELL_TEST_KEY: secret } });
    try {
      const snapshot = data.load(undefined);
      expect(snapshot.providers.error).toBeUndefined();
      expect(snapshot.providers.rows).toEqual([
        {
          id: "gateway",
          baseUrl: "http://127.0.0.1:8317/v1",
          keyEnv: "SHELL_TEST_KEY",
          keySet: true,
        },
        {
          id: "local",
          baseUrl: "http://localhost:11434/v1",
          keyEnv: "SHELL_TEST_MISSING",
          keySet: false,
        },
      ]);
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    } finally {
      data.close();
    }
  });

  it("falls back to the default gateway provider when there is no config file", () => {
    const data = openShellData({ paths: paths(), env: {} });
    try {
      const snapshot = data.load(undefined);
      expect(snapshot.providers.source).toBe("defaults");
      expect(snapshot.providers.rows.map((row) => row.id)).toEqual(["cliproxy"]);
      expect(snapshot.providers.rows[0]?.keySet).toBe(false);
    } finally {
      data.close();
    }
  });

  it("reads a haril.json with only ui.theme as the defaults, the same as the CLI (TUI-D14)", () => {
    mkdirSync(join(runtimeRoot, "config"), { recursive: true });
    writeFileSync(
      join(runtimeRoot, "config", "haril.json"),
      JSON.stringify({ ui: { theme: "haril-light" } }),
    );
    const data = openShellData({ paths: paths(), env: {} });
    try {
      const snapshot = data.load(undefined);
      expect(snapshot.providers.error).toBeUndefined();
      expect(snapshot.providers.source).toBe("defaults");
      expect(snapshot.providers.rows.map((row) => row.id)).toEqual(["cliproxy"]);
    } finally {
      data.close();
    }
  });

  it("names an unknown top-level key as a config error", () => {
    mkdirSync(join(runtimeRoot, "config"), { recursive: true });
    writeFileSync(join(runtimeRoot, "config", "haril.json"), JSON.stringify({ bogus: 1 }));
    const data = openShellData({ paths: paths(), env: {} });
    try {
      expect(data.load(undefined).providers.error).toContain("/bogus: unknown key");
    } finally {
      data.close();
    }
  });

  it("lists user theme names from config/themes", () => {
    writeFileSync(join(runtimeRoot, "config", "themes", "ocean.json"), "{}");
    writeFileSync(join(runtimeRoot, "config", "themes", "notes.txt"), "not a theme");
    const data = openShellData({ paths: paths(), env: {} });
    try {
      expect(data.load(undefined).themes.user).toEqual(["ocean"]);
    } finally {
      data.close();
    }
  });
});

describe("pending approvals (LD-T3)", () => {
  it("counts the approvals waiting for a decision, for the banner", () => {
    const seeded = seedStore(dataDir);
    const example = fileURLToPath(new URL("../../../examples/plan.valid.json", import.meta.url));
    const store = openSeedStore(dataDir);
    try {
      store.approvals.proposePlan({
        projectId: seeded.demoId,
        plan: JSON.parse(readFileSync(example, "utf8")) as unknown,
        requestedBy: "cli",
      });
    } finally {
      store.close();
    }
    const data = openShellData({ paths: paths(), env: {} });
    try {
      expect(data.load(undefined).pendingApprovals).toBe(1);
    } finally {
      data.close();
    }
  });
});
