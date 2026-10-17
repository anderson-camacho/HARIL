import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShellData, type ShellSnapshot } from "../src/data.js";
import {
  buildPanelView,
  buildPlanDetailView,
  buildTaskDetailView,
  type PanelContext,
} from "../src/panels/index.js";
import { proposeExamplePlan, SEED_TITLES, seedStore } from "./seed.js";

// Pure panel builders (TUI-D6): data in, lines out. No terminal is involved.

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-panels-"));
  dataDir = join(root, "data");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const settings = {
  dataDir: "/data",
  runtimeRoot: "/runtime",
  configPath: "/runtime/config/haril.json",
  themeName: "haril-dark",
  themeLabel: "haril-dark",
};

function loadSnapshot(scope: string | undefined): ShellSnapshot {
  const data = openShellData({
    paths: { dataDir, runtimeRoot: undefined, configPath: undefined },
    env: {},
  });
  try {
    return data.load(scope);
  } finally {
    data.close();
  }
}

function contextFor(snapshot: ShellSnapshot, scope: string | undefined): PanelContext {
  return { snapshot, settings, scope };
}

function texts(view: { items: readonly { text: string }[] }): string[] {
  return view.items.map((item) => item.text);
}

describe("panel builders with a seeded store", () => {
  it("projects: the all-projects row comes first, then each project with its slug", () => {
    seedStore(dataDir);
    const snapshot = loadSnapshot(undefined);
    const view = buildPanelView("projects", contextFor(snapshot, undefined));
    expect(view.items[0]?.text).toContain("all projects");
    expect(texts(view).some((text) => text.includes("demo") && text.includes("/work/demo"))).toBe(
      true,
    );
    expect(texts(view).some((text) => text.includes("other"))).toBe(true);
  });

  it("tasks: scoped to the chosen project, with state, agent, model and dependency status", () => {
    const seeded = seedStore(dataDir);
    const snapshot = loadSnapshot(seeded.demoId);
    const view = buildPanelView("tasks", contextFor(snapshot, seeded.demoId));
    const lines = texts(view);
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes(SEED_TITLES.unrelated))).toBe(false);
    const completed = lines.find((line) => line.includes(SEED_TITLES.completed));
    expect(completed).toContain("completed");
    expect(completed).toContain("fake-agent");
    const pending = lines.find((line) => line.includes(SEED_TITLES.pending));
    expect(pending).toContain(seeded.runningTaskId.slice(0, 8));
    expect(pending).not.toContain("waiting");
    expect(view.items.map((item) => item.value)).toContain(seeded.pendingTaskId);
  });

  it("task detail: the dependency ids in short form, or none", () => {
    const seeded = seedStore(dataDir);
    const data = openShellData({
      paths: { dataDir, runtimeRoot: undefined, configPath: undefined },
      env: {},
    });
    try {
      const pending = data.taskDetail(seeded.pendingTaskId);
      if (pending === undefined) throw new Error("pending task not found");
      expect(buildTaskDetailView(pending)).toContain(
        `depends on: ${seeded.runningTaskId.slice(0, 8)}`,
      );
      const completed = data.taskDetail(seeded.completedTaskId);
      if (completed === undefined) throw new Error("completed task not found");
      expect(buildTaskDetailView(completed)).toContain("depends on: none");
    } finally {
      data.close();
    }
  });

  it("tasks: without a scope the tasks of every project are listed", () => {
    seedStore(dataDir);
    const snapshot = loadSnapshot(undefined);
    expect(texts(buildPanelView("tasks", contextFor(snapshot, undefined)))).toHaveLength(4);
  });

  it("task detail mirrors task show: result, verification checks, settled tokens and denials", () => {
    const seeded = seedStore(dataDir);
    const data = openShellData({
      paths: { dataDir, runtimeRoot: undefined, configPath: undefined },
      env: {},
    });
    try {
      const view = data.taskDetail(seeded.completedTaskId);
      if (view === undefined) throw new Error("completed task not found");
      const lines = buildTaskDetailView(view);
      expect(lines).toContain("result: Logs summarized");
      expect(lines).toContain("verification: verified");
      expect(lines).toContain("  ok file_exists: summary.md");
      expect(lines).toContain("tokens: input 40, output 12, unreconciled 0");
      expect(lines).toContain("permission denials: 1");
    } finally {
      data.close();
    }
  });

  it("agents: the runtime lease summary and the tasks running now", () => {
    seedStore(dataDir);
    const snapshot = loadSnapshot(undefined);
    const view = buildPanelView("agents", contextFor(snapshot, undefined));
    expect(view.header.some((line) => line.startsWith("runtime active"))).toBe(true);
    expect(texts(view)).toEqual([expect.stringContaining(SEED_TITLES.running)]);
  });

  it("events: one line per event, each with its type", () => {
    seedStore(dataDir);
    const snapshot = loadSnapshot(undefined);
    const lines = texts(buildPanelView("events", contextFor(snapshot, undefined)));
    expect(lines.some((line) => line.includes("task.created"))).toBe(true);
    expect(lines.some((line) => line.includes("security.pathguard.denied"))).toBe(true);
  });

  it("tokens: a block per project with runs, success rate and ledger tokens", () => {
    seedStore(dataDir);
    const snapshot = loadSnapshot(undefined);
    const lines = buildPanelView("tokens", contextFor(snapshot, undefined)).header;
    expect(
      lines.some(
        (line) => line.includes("demo") && line.includes("in 40") && line.includes("out 12"),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes("success 100.0%"))).toBe(true);
  });
});

describe("panel builders without a store or with unusual inputs", () => {
  it("data panels show the empty state when no store exists", () => {
    const snapshot = loadSnapshot(undefined);
    const message =
      "No HARIL data yet. Create a project with: haril project init <path> --name <name>";
    for (const id of ["projects", "tasks", "agents", "tokens", "events"] as const) {
      const view = buildPanelView(id, contextFor(snapshot, undefined));
      expect([...view.header, view.empty ?? ""].join("\n")).toContain(message);
    }
  });

  it("models: set or not set for each key variable, with the hint to query live catalogs", () => {
    const snapshot = loadSnapshot(undefined);
    const withKeys: ShellSnapshot = {
      ...snapshot,
      providers: {
        source: "file",
        error: undefined,
        rows: [
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
        ],
      },
    };
    const view = buildPanelView("models", contextFor(withKeys, undefined));
    const lines = texts(view);
    expect(lines[0]).toContain("gateway");
    expect(lines[0]).toContain("SHELL_TEST_KEY: set");
    expect(lines[1]).toContain("SHELL_TEST_MISSING: not set");
    expect(view.header.join("\n")).toContain("Run haril models to query live catalogs");
  });

  it("config and themes work without a store", () => {
    const snapshot = loadSnapshot(undefined);
    const config = texts(buildPanelView("config", contextFor(snapshot, undefined))).join("\n");
    expect(config).toContain("/data");
    expect(config).toContain("/runtime/config/haril.json");
    expect(config).toContain("haril-dark");
    const themes = texts(buildPanelView("themes", contextFor(snapshot, undefined)));
    expect(themes.some((line) => line.includes("haril-dark") && line.includes("current"))).toBe(
      true,
    );
    expect(themes.some((line) => line.includes("haril-light"))).toBe(true);
  });

  it("memory, services and terminals say the feature is not available in this version", () => {
    const snapshot = loadSnapshot(undefined);
    for (const id of ["memory", "services", "terminals"] as const) {
      const view = buildPanelView(id, contextFor(snapshot, undefined));
      expect(view.header).toEqual(["Not available in this version."]);
      expect(view.items).toEqual([]);
    }
  });
});

describe("plans and live (LD-T5)", () => {
  it("plans: one row per requested approval with its short id, project, task count and age", () => {
    const seeded = seedStore(dataDir);
    const approvalId = proposeExamplePlan(dataDir, seeded.demoId);
    // The approvals are global, like the banner count: a project filter does not hide them.
    const snapshot = loadSnapshot(seeded.otherId);
    const view = buildPanelView("plans", contextFor(snapshot, seeded.otherId));
    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.value).toBe(approvalId);
    const text = view.items[0]?.text ?? "";
    expect(text).toContain(approvalId.slice(0, 8));
    expect(text).toContain("demo");
    expect(text).toContain("4 tasks");
    expect(text).toMatch(/\d+s$/);
    expect(view.keys).toEqual(["Enter open plan", "y approve", "n deny"]);
  });

  it("plans: says so when nothing waits for a decision", () => {
    seedStore(dataDir);
    const view = buildPanelView("plans", contextFor(loadSnapshot(undefined), undefined));
    expect(view.items).toEqual([]);
    expect(view.empty).toBe("No plans waiting for approval.");
  });

  it("plan detail: each task with its local id, goal, agent and dependencies", () => {
    const seeded = seedStore(dataDir);
    const approvalId = proposeExamplePlan(dataDir, seeded.demoId);
    const snapshot = loadSnapshot(undefined);
    const approval = snapshot.approvals[0];
    if (approval === undefined) throw new Error("approval not loaded");
    const lines = buildPlanDetailView(approval, contextFor(snapshot, undefined));
    expect(lines[0]).toBe(`plan ${approvalId}`);
    expect(lines[1]).toMatch(/^project demo, 4 tasks, requested \d+s ago by cli$/);
    expect(lines).toContain("1. survey-readme: Survey the README structure");
    expect(lines).toContain("   agent developer-block, depends on: none");
    expect(lines).toContain("2. draft-section: Draft the new README section");
    expect(lines).toContain("   agent developer-block, depends on: survey-readme");
  });

  it("live: state, kind, agent, attempt, tokens and the first line of the result or error", () => {
    const seeded = seedStore(dataDir);
    const snapshot = loadSnapshot(seeded.demoId);
    const [completed, running] = snapshot.live;
    if (completed === undefined || running === undefined) throw new Error("live rows missing");
    // A plan task and a failed task, as the runtime leaves them; the seed has neither.
    const planTask = {
      detail: { ...running.detail, agentRef: "fake:plan", goal: "Plan the docs" },
      tokens: null,
    };
    const failed = {
      detail: {
        ...completed.detail,
        state: "failed" as const,
        goal: "Broken task",
        result: null,
        error: { code: "agent_failed", message: "exit 3\nstack trace" },
      },
      tokens: { input: 5, output: 1, unreconciled: 0 },
    };
    const view = buildPanelView(
      "live",
      contextFor({ ...snapshot, live: [completed, running, planTask, failed] }, seeded.demoId),
    );
    const lines = texts(view);
    expect(lines[0]).toMatch(
      /^completed\s+work\s+fake-agent\s+\d+\/1\s+40\/12\s+Summarize the logs · Logs summarized$/,
    );
    expect(lines[1]).toMatch(/^running\s+work\s+fake-agent\s+\d+\/1\s+-\s+Write the parser$/);
    expect(lines[2]).toMatch(/^running\s+plan\s+fake:plan\s/);
    expect(lines[3]).toMatch(/^failed\s+work\s.*5\/1\s+Broken task · agent_failed: exit 3$/);
    expect(view.items[0]?.value).toBe(seeded.completedTaskId);
    expect(view.keys).toEqual(["Enter open task"]);
  });

  it("live: large token counts show in a compact form and are never cut", () => {
    const seeded = seedStore(dataDir);
    const snapshot = loadSnapshot(seeded.demoId);
    const [completed] = snapshot.live;
    if (completed === undefined) throw new Error("live rows missing");
    const counts = [
      { input: 120000, output: 3000, shown: "120k/3k" },
      { input: 18342, output: 1523, shown: "18.3k/1.5k" },
      { input: 999, output: 0, shown: "999/0" },
      { input: 2_460_000, output: 99_960, shown: "2.5M/100k" },
    ];
    const live = counts.map(({ input, output }) => ({
      detail: completed.detail,
      tokens: { input, output, unreconciled: 0 },
    }));
    const lines = texts(buildPanelView("live", contextFor({ ...snapshot, live }, seeded.demoId)));
    counts.forEach(({ shown }, index) => {
      expect(lines[index]).toMatch(new RegExp(`\\s${shown.replaceAll(".", "\\.")}\\s+Summarize`));
    });
  });

  it("plans: a subject that is not a plan lists as an invalid plan", () => {
    const seeded = seedStore(dataDir);
    const snapshot = loadSnapshot(undefined);
    const invalid = {
      approvalId: "badplan0-0000-4000-8000-000000000000",
      projectId: seeded.demoId,
      requestedAt: snapshot.loadedAt,
      requestedBy: "cli",
      tasks: [],
      error: "/tasks/0/goal: Expected string",
    };
    const context = contextFor({ ...snapshot, approvals: [invalid] }, undefined);
    const text = texts(buildPanelView("plans", context))[0] ?? "";
    expect(text).toContain("invalid plan");
    expect(text).not.toContain("0 tasks");
    const lines = buildPlanDetailView(invalid, context);
    expect(lines[1]).toMatch(/^project demo, invalid plan, requested/);
    expect(lines).toContain("the plan could not be read: /tasks/0/goal: Expected string");
  });
});
