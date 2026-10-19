import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  difficultyFileErrors,
  matchesPattern,
  resolveDifficulty,
  tableFor,
} from "../src/difficulty.js";
import { storeAccess } from "../src/host.js";
import {
  harness,
  makeSandbox,
  parseJson,
  projectRoot,
  type Sandbox,
  workflowIntake,
} from "./helpers.js";

// The difficulty table (docs/modos-y-delegacion.md 3.11; phase F6): built-in provisional defaults, a config file that
// overrides them value by value, patterns that follow a model across account prefixes, `haril difficulty show` with the
// source of each value, and `haril difficulty calibrate`, the manual trigger, which recomputes the success rates from the
// model_stats view (real runs only), shows the change and writes the file only with --yes.

const CATALOG = [
  "cliproxy/gemini-3-flash",
  "cliproxy/Gemini1/gemini-3-flash",
  "cliproxy/Gemini1/gemini-3.1-flash-lite",
  "cliproxy/Gemini1/gemini-3.1-flash-image",
  "cliproxy/Gemini1/gemini-3.8-flash-high",
  "cliproxy/Gemini1/claude-sonnet-4-6",
  "cliproxy/Gemini1/claude-opus-4-6-thinking",
];

let sb: Sandbox;
const stores: Store[] = [];

beforeEach(() => {
  sb = makeSandbox();
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  sb.cleanup();
});

function configDir(): string {
  // makeSandbox's host resolves haril.json under its runtime root; the table sits next to it.
  const dir = join(sb.root, "config");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function hostWithConfig() {
  const dir = configDir();
  const config = join(dir, "haril.json");
  writeFileSync(config, JSON.stringify({}));
  return { host: { ...sb.host, env: { ...sb.host.env, HARIL_CONFIG: config } }, dir };
}

describe("the table in effect", () => {
  it("starts from provisional defaults and expands their patterns against the catalog", () => {
    const policy = resolveDifficulty(undefined);
    expect(policy.classes.easy.source).toEqual({ minSuccessRate: "default", order: "default" });
    const table = tableFor(policy, CATALOG);
    expect(table.classes.trivial.order).toEqual([
      "cliproxy/Gemini1/gemini-3.1-flash-lite",
      "cliproxy/gemini-3-flash",
      "cliproxy/Gemini1/gemini-3-flash",
    ]);
    expect(table.classes.expert.order[0]).toBe("cliproxy/Gemini1/claude-opus-4-6-thinking");
    // An image model never matches "*flash".
    expect(Object.values(table.classes).flatMap((rule) => rule.order)).not.toContain(
      "cliproxy/Gemini1/gemini-3.1-flash-image",
    );
    expect(table.models["cliproxy/Gemini1/gemini-3.8-flash-high"]).toEqual({ costTier: 2 });
    expect(table.models["cliproxy/Gemini1/claude-sonnet-4-6"]).toEqual({ costTier: 3 });
  });

  it("takes each value the file gives over the default, and reports where each one came from", () => {
    const policy = resolveDifficulty({
      schemaVersion: 1,
      classes: { easy: { order: ["cliproxy/gemini-3-flash"] } },
      models: { "cliproxy/gemini-3-flash": { costTier: 1 } },
    });
    expect(policy.classes.easy).toMatchObject({
      minSuccessRate: 0.75,
      order: ["cliproxy/gemini-3-flash"],
      source: { minSuccessRate: "default", order: "file" },
    });
    expect(policy.models).toEqual([
      { pattern: "cliproxy/gemini-3-flash", costTier: 1, source: "file" },
    ]);
  });

  it("matches * as any text and nothing else as a pattern", () => {
    expect(matchesPattern("*flash", "cliproxy/Gemini1/gemini-3-flash")).toBe(true);
    expect(matchesPattern("*flash", "cliproxy/Gemini1/gemini-3.1-flash-lite")).toBe(false);
    expect(matchesPattern("cliproxy/a.b", "cliproxy/aXb")).toBe(false);
    expect(matchesPattern("*sonnet*", "x/claude-sonnet-4-6")).toBe(true);
  });

  it("refuses a malformed file with the JSON path of each problem", () => {
    expect(
      difficultyFileErrors({
        schemaVersion: 2,
        classes: { impossible: {}, easy: { minSuccessRate: 3, order: "x" } },
        models: { m: { costTier: 12 } },
        stats: { m: { easy: { successRate: 2, samples: 1 } } },
        extra: true,
      }),
    ).toEqual([
      "/extra: unknown key",
      "/schemaVersion: must be 1",
      "/classes/impossible: unknown class (trivial, easy, medium, hard or expert)",
      "/classes/easy/minSuccessRate: must be a number from 0 to 1",
      "/classes/easy/order: must be a list of up to 64 model references",
      '/models/m: must be {"costTier": a whole number from 0 to 9}',
      '/stats/m/easy: must be {"successRate": 0 to 1, "samples": a whole number} under a class',
    ]);
  });
});

interface ShowJson {
  readonly path: string;
  readonly file: boolean;
  readonly classes: Record<
    string,
    { minSuccessRate: number; order: string[]; source: Record<string, string> }
  >;
  readonly calibratedAt: string | null;
}

describe("haril difficulty show", () => {
  it("prints each class's recommended models and cost levels, with the source of each value", async () => {
    const { host, dir } = hostWithConfig();
    const text = harness();
    expect(await run(["difficulty", "show"], text.io, host)).toBe(0);
    const out = text.out.join("\n");
    expect(out).toContain("default (provisional)");
    expect(out).toMatch(/easy +0\.75/);
    expect(out).toContain("*flash (cost 1)");
    expect(out).toContain("calibrated  never");

    writeFileSync(
      join(dir, "difficulty.json"),
      JSON.stringify({
        schemaVersion: 1,
        classes: { easy: { order: ["cliproxy/gemini-3-flash"] } },
      }),
    );
    const json = harness();
    expect(await run(["difficulty", "show", "--json"], json.io, host)).toBe(0);
    const report = parseJson<ShowJson>(json.out);
    expect(report.file).toBe(true);
    expect(report.classes.easy).toMatchObject({
      order: ["cliproxy/gemini-3-flash"],
      source: { order: "file", minSuccessRate: "default" },
    });

    writeFileSync(join(dir, "difficulty.json"), "{ not json");
    const broken = harness();
    expect(await run(["difficulty", "show"], broken.io, host)).toBe(2);
    expect(broken.err.join("\n")).toContain("not valid JSON");
  });
});

// One executor run of `model` at `difficulty`, judged `verdict`, in a workflow of the store.
function judgedRun(
  store: Store,
  epoch: number,
  workflowId: string,
  rootTaskId: string,
  key: string,
  model: string,
  verdict: "approved" | "rejected",
  simulated: boolean,
): void {
  const turn = (role: "executor" | "auditor", turnKey: string, parent: string) => ({
    key: turnKey,
    threadId: null,
    role,
    layer: 3 as const,
    kind: role === "executor" ? ("work" as const) : ("verify" as const),
    parentTaskId: parent,
    localId: role === "executor" ? turnKey : null,
    goal: `goal ${turnKey}`,
    description: "",
    agentRef: role,
    model,
    modelPinned: false,
    difficulty: "easy" as const,
    difficultyReason: "one file",
    priority: 5,
    budgetTokens: 10_000,
    timeoutMs: 60_000,
    surfaceWrite: [],
    surfaceRead: [],
    dependsOn: role === "auditor" ? [{ on: key, kind: "completed" as const }] : [],
  });
  const applied = store.workflows.applyTurns(epoch, {
    workflowId,
    turns: [turn("executor", key, rootTaskId), turn("auditor", `audit:${key}`, key)],
  });
  const executor = applied.taskIds[key] as string;
  store.workflows.recordAudit(epoch, {
    workflowId,
    subjectTaskId: executor,
    auditorTaskId: applied.taskIds[`audit:${key}`] as string,
    scope: "task",
    verdict,
    reasons: [{ criterion: "done", ok: verdict === "approved", evidence: "test" }],
    reworkAction: verdict === "approved" ? "accept" : "fail",
  });
  store.usageLog.appendUsage({
    kind: "agent_run",
    workflowId,
    taskId: executor,
    role: "executor",
    layer: 3,
    modelRequested: model,
    modelServed: model,
    tokensIn: 1000,
    tokensOut: 100,
    difficultyEst: "easy",
    outcome: "completed",
    simulated,
  });
}

function seedRuns(host: typeof sb.host): void {
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    harness().io,
    host,
  );
  const store = storeAccess(host).open(sb.dataDir);
  stores.push(store);
  const grant = store.runtime.acquire({
    pid: process.pid,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  const epoch = grant.value.epoch;
  store.commands.enqueue({
    type: "workflow.start",
    projectId: store.projects.list()[0]?.projectId,
    args: {
      intake: workflowIntake(store.projects.list()[0]?.rootPath as string),
      goal: "Seed model stats",
      model: "cliproxy/high",
      agent: "orchestrator",
      autonomy: { mode: "autonomous", stops: [] },
      budgetTokens: 500_000,
      timeoutMs: 60_000,
    },
    idempotencyKey: "seed",
    requestHash: "seed",
  });
  store.commands.applyNext(epoch);
  const workflow = store.workflows.list()[0];
  const root = workflow === undefined ? undefined : store.workflows.tasks(workflow.workflowId)[0];
  if (workflow === undefined || root === undefined) throw new Error("no workflow");
  const verdicts = ["approved", "approved", "approved", "rejected"] as const;
  verdicts.forEach((verdict, index) => {
    judgedRun(
      store,
      epoch,
      workflow.workflowId,
      root.taskId,
      `real-${index}`,
      "cliproxy/fast",
      verdict,
      false,
    );
  });
  // A simulated run never counts.
  judgedRun(
    store,
    epoch,
    workflow.workflowId,
    root.taskId,
    "sim-0",
    "cliproxy/demo",
    "approved",
    true,
  );
  store.runtime.release(epoch, true);
}

interface CalibrateJson {
  readonly path: string;
  readonly written: boolean;
  readonly changes: {
    readonly model: string;
    readonly difficulty: string;
    readonly before: { successRate: number; samples: number } | null;
    readonly after: { successRate: number; samples: number } | null;
  }[];
}

describe("haril difficulty calibrate", () => {
  it("shows the recomputed success rates, writes them only with --yes, and leaves simulated runs out", async () => {
    const { host, dir } = hostWithConfig();
    seedRuns(host);
    const path = join(dir, "difficulty.json");

    const dry = harness();
    expect(await run(["difficulty", "calibrate", "--json"], dry.io, host)).toBe(0);
    const proposal = parseJson<CalibrateJson>(dry.out);
    expect(proposal.written).toBe(false);
    expect(proposal.changes).toEqual([
      {
        model: "cliproxy/fast",
        difficulty: "easy",
        before: null,
        after: { successRate: 0.75, samples: 4 },
      },
    ]);
    expect(existsSync(path)).toBe(false);

    const text = harness();
    expect(await run(["difficulty", "calibrate"], text.io, host)).toBe(0);
    expect(text.out.join("\n")).toContain("cliproxy/fast  easy  none -> 0.75 (4 judged runs)");
    expect(text.out.join("\n")).toContain("--yes");

    const applied = harness();
    expect(await run(["difficulty", "calibrate", "--yes"], applied.io, host)).toBe(0);
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(written.stats).toEqual({ "cliproxy/fast": { easy: { successRate: 0.75, samples: 4 } } });
    expect(typeof written.calibratedAt).toBe("string");
    // Only the stats were written: the classes and models still come from the defaults.
    expect(written.classes).toBeUndefined();

    const again = harness();
    expect(await run(["difficulty", "calibrate", "--json"], again.io, host)).toBe(0);
    expect(parseJson<CalibrateJson>(again.out).changes).toEqual([]);
  });
});
