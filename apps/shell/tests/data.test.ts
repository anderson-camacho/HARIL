import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShellData, type ShellPaths } from "../src/data.js";
import {
  createTask,
  openSeedStore,
  proposeExamplePlan,
  queueTask,
  SEED_TITLES,
  seedStore,
} from "./seed.js";

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

  it("counts the work that waits for a runtime and tells a live lease from a dead one (LD-T6)", () => {
    const seeded = seedStore(dataDir);
    const writer = openSeedStore(dataDir);
    try {
      // One queued command and one decided plan the runtime has not applied, beside the seeded ready task.
      queueTask(writer, seeded.demoId, "Queued for later");
      const approvalId = proposeExamplePlan(dataDir, seeded.demoId);
      writer.approvals.decide({ approvalId, outcome: "granted", decidedBy: "tester" });
    } finally {
      writer.close();
    }
    const live = openShellData({ paths: paths(), env: {} });
    const dead = openShellData({ paths: paths(), env: {}, isPidAlive: () => false });
    try {
      const snapshot = live.load(undefined);
      expect(snapshot.waitingWork).toBe(3);
      // The seeded lease belongs to this process: active, unexpired and alive.
      expect(snapshot.runtimeAlive).toBe(true);
      expect(dead.load(undefined).runtimeAlive).toBe(false);
    } finally {
      live.close();
      dead.close();
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

describe("plans waiting for approval (LD-T5)", () => {
  it("keeps each requested approval with the tasks of its plan, read from the subject", () => {
    const seeded = seedStore(dataDir);
    const approvalId = proposeExamplePlan(dataDir, seeded.demoId);
    const data = openShellData({ paths: paths(), env: {} });
    try {
      const snapshot = data.load(undefined);
      expect(snapshot.pendingApprovals).toBe(1);
      expect(snapshot.approvals).toHaveLength(1);
      const [approval] = snapshot.approvals;
      expect(approval).toMatchObject({
        approvalId,
        projectId: seeded.demoId,
        requestedBy: "cli",
        model: null,
        error: undefined,
      });
      expect(approval?.tasks.map((task) => task.localId)).toEqual([
        "survey-readme",
        "draft-section",
        "insert-section",
        "verify-readme",
      ]);
      // Every field of the task, as the runtime will apply it: the plan detail shows them all (LD-T6c).
      expect(approval?.tasks[1]).toEqual({
        localId: "draft-section",
        dependsOn: ["survey-readme"],
        goal: "Draft the new README section",
        description: "Write a short section that explains how to run the CLI smoke test.",
        priority: 1,
        kind: "work",
        agent: "developer-block",
        requires: [],
        context: [],
        surface: { write: [], read: ["README.md"] },
        budget: { maxCostMicros: 0, maxTokens: 20000, maxWallMs: 120000 },
        timeoutMs: 120000,
        maxAttempts: 2,
        acceptance: [],
      });
    } finally {
      data.close();
    }
  });
});

describe("live tasks (LD-T5)", () => {
  it("keeps the scope's newest tasks with their settled tokens", () => {
    const seeded = seedStore(dataDir);
    const data = openShellData({ paths: paths(), env: {} });
    try {
      const live = data.load(seeded.demoId).live;
      expect(live.map((entry) => entry.detail.goal)).toEqual([
        SEED_TITLES.completed,
        SEED_TITLES.running,
        SEED_TITLES.pending,
      ]);
      expect(live[0]?.tokens).toEqual({ input: 40, output: 12, unreconciled: 0 });
      expect(live[1]?.tokens).toBeNull();
    } finally {
      data.close();
    }
  });

  it("is bounded to the 20 newest tasks, oldest first", () => {
    const seeded = seedStore(dataDir);
    const writer = openSeedStore(dataDir);
    try {
      for (let index = 1; index <= 25; index++) {
        createTask(writer, seeded.demoId, seeded.epoch, `Bulk task ${index}`);
      }
    } finally {
      writer.close();
    }
    const data = openShellData({ paths: paths(), env: {} });
    try {
      const goals = data.load(seeded.demoId).live.map((entry) => entry.detail.goal);
      expect(goals).toHaveLength(20);
      expect(goals[0]).toBe("Bulk task 6");
      expect(goals.at(-1)).toBe("Bulk task 25");
    } finally {
      data.close();
    }
  });
});

describe("the model of a plan waiting for approval (LD-T7a)", () => {
  it("keeps the model of the task that proposed the plan", () => {
    const seeded = seedStore(dataDir);
    proposeExamplePlan(dataDir, seeded.demoId, "e2e-model");
    const data = openShellData({ paths: paths(), env: {} });
    try {
      expect(data.load(undefined).approvals).toEqual([
        expect.objectContaining({ requestedBy: "run-planner", model: "e2e-model" }),
      ]);
    } finally {
      data.close();
    }
  });
});
