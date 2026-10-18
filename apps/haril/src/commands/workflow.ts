import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isStop, type Stop, type WorkflowSnapshot } from "@haril/contracts";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  DEFAULT_DELEGATION_LIMITS,
  DEFAULT_QUOTA_POLICY,
  DEFAULT_WATCHDOG_POLICY,
  type ModelSelectionContext,
  type QuotaSample,
} from "@haril/core";
import type { Clock, Ids, Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_INVALID, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { clockFor, storeAccess } from "../host.js";
import { parseInstant } from "./usage-format.js";
import { type DemoResult, runDemoWorkflow } from "./workflow-demo-run.js";
import { buildWorkflowSnapshot, headerLines, treeLines } from "./workflow-snapshot.js";

// `haril workflow demo` (docs/modos-y-delegacion.md 9, the F1 stop: "a demo command runs a simulated three-layer
// tree and you see the result"). Section 6 names no demo command; it lives under `haril workflow`, where phase F2 adds
// start, list and show. It runs the simulated agents through the Core rules and the real SQLite store, on a temporary
// data directory that is removed at the end, unless --data-dir names one to keep the rows in. It never touches the
// default HARIL data directory on its own, and it calls no model. With the default start time and a temporary store
// the output depends only on the flags, so the same seed always prints the same tree.

const USAGE = [
  "usage: haril workflow demo [--goal <text>] [--seed <n>] [--delegators <n>] [--executors <n>] [--stop-at <stops>]",
  "                           [--start <time>] [--data-dir <path>] [--json]",
  "  runs a simulated three-layer workflow (orchestrator, delegators, executors and auditors) with the fake agents",
  "  on a temporary store, removed at the end; --data-dir <path> keeps the rows there (never the default data dir).",
  "  --stop-at takes stops such as after_plan or after_node:part-1, comma separated; without it the run is autonomous.",
].join("\n");

const DEFAULT_GOAL = "Change the primary button color and test it";
// The demo's fixed start: with a temporary store, ids and times are then the same on every run.
const DEMO_START = Date.UTC(2026, 0, 5, 9, 0, 0);
const HOUR = 3_600_000;
const ORCHESTRATOR_MODEL = "demo-a/high-model";

const STORE_RULES = {
  canTransition,
  checkPlan: checkPlanSubmission,
  checkAcceptance,
  checkTaskKind,
  canonicalJson,
};

interface DemoAccount {
  readonly key: string;
  readonly credential: string;
  readonly window5hPct: number | null;
  readonly weeklyPct: number | null;
  readonly note: string;
}

// Simulated accounts, as the orchestration view's demo data shows them (ADR-0021): one in use, one over 80% of its
// 5-hour window (avoided), one over 80% of its week (not used) and one that exposes no quota ("sin dato").
const ACCOUNTS: readonly DemoAccount[] = [
  { key: "demo-a", credential: "account 1", window5hPct: 38, weeklyPct: 52, note: "in use" },
  {
    key: "demo-b",
    credential: "account 2",
    window5hPct: 83,
    weeklyPct: 41,
    note: "over 80% of its 5-hour window: avoided",
  },
  {
    key: "demo-c",
    credential: "account 3",
    window5hPct: 20,
    weeklyPct: 88,
    note: "over 80% of its week: not used",
  },
  { key: "demo-d", credential: "account 4", window5hPct: null, weeklyPct: null, note: "sin dato" },
];

function demoModels(start: number): Omit<ModelSelectionContext, "now"> {
  const quota: Record<string, QuotaSample> = {};
  for (const account of ACCOUNTS) {
    quota[account.key] =
      account.window5hPct === null
        ? { available: false, reason: "the provider exposes no quota" }
        : {
            available: true,
            window5hUsedPct: account.window5hPct,
            window5hResetsAt: start + 2 * HOUR,
            weeklyUsedPct: account.weeklyPct,
            weeklyResetsAt: start + 120 * HOUR,
          };
  }
  const entry = (ref: string) => ({
    ref,
    quotaKey: ref.split("/")[0] ?? ref,
    hasKey: true,
    coolingUntil: null,
  });
  const fast = ["demo-c/fast-model", "demo-a/fast-model", "demo-d/audit-model"];
  return {
    catalog: [
      "demo-a/high-model",
      "demo-a/mid-model",
      "demo-a/fast-model",
      "demo-b/mid-model",
      "demo-c/fast-model",
      "demo-d/audit-model",
    ].map(entry),
    allow: { auditor: ["demo-a/fast-model", "demo-d/audit-model"] },
    pinned: {},
    quota,
    table: {
      classes: {
        trivial: { minSuccessRate: 0.7, order: fast },
        easy: { minSuccessRate: 0.7, order: fast },
        medium: {
          minSuccessRate: 0.8,
          order: [
            "demo-b/mid-model",
            "demo-a/mid-model",
            "demo-a/fast-model",
            "demo-d/audit-model",
          ],
        },
        hard: {
          minSuccessRate: 0.8,
          order: ["demo-b/mid-model", "demo-a/mid-model", "demo-d/audit-model"],
        },
        expert: { minSuccessRate: 0.9, order: ["demo-a/high-model", "demo-d/audit-model"] },
      },
      models: {
        "demo-a/high-model": { costTier: 3 },
        "demo-a/mid-model": { costTier: 2 },
        "demo-b/mid-model": { costTier: 2 },
        "demo-a/fast-model": { costTier: 1 },
        "demo-c/fast-model": { costTier: 1 },
        "demo-d/audit-model": { costTier: 1 },
      },
    },
    stats: {},
    policy: DEFAULT_QUOTA_POLICY,
    largeTaskTokens: DEFAULT_DELEGATION_LIMITS.largeTaskTokens,
  };
}

function quotaRows(start: number): WorkflowSnapshot["quota"] {
  return ACCOUNTS.map((account) => ({
    provider: account.key,
    credential: account.credential,
    window5hPct: account.window5hPct,
    weeklyPct: account.weeklyPct,
    resetAt: account.window5hPct === null ? null : start + 2 * HOUR,
    note: account.note,
  }));
}

function quotaOf(model: string): { window5hPct: number | null; weeklyPct: number | null } | null {
  const account = ACCOUNTS.find((item) => model.startsWith(`${item.key}/`));
  if (account === undefined || account.window5hPct === null) return null;
  return { window5hPct: account.window5hPct, weeklyPct: account.weeklyPct };
}

function wholeNumber(
  text: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (text === undefined) return fallback;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function kilo(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

function sequentialIds(): Ids {
  let counter = 0;
  return { next: () => `demo-${String(++counter).padStart(6, "0")}` };
}

interface DemoOutcome {
  readonly snapshot: WorkflowSnapshot;
  readonly result: DemoResult;
  readonly chain: ReturnType<Store["usageLog"]["verify"]>;
  readonly rows: { readonly orders: number; readonly usage: number };
}

function demo(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: [
      "--goal",
      "--seed",
      "--delegators",
      "--executors",
      "--stop-at",
      "--start",
      "--data-dir",
    ],
    flags: ["--json"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const fail = (message: string) => {
    io.err(`haril: ${message}`);
    return EXIT_USAGE;
  };
  const goal = lastValue(parsed, "--goal") ?? DEFAULT_GOAL;
  if (goal.trim() === "") return fail("--goal must not be empty");
  const seed = wholeNumber(lastValue(parsed, "--seed"), 1, 0, 2 ** 31 - 1);
  if (seed === null) return fail("--seed must be a whole number from 0");
  const delegators = wholeNumber(lastValue(parsed, "--delegators"), 3, 1, 10);
  if (delegators === null) return fail("--delegators must be a whole number from 1 to 10");
  const executors = wholeNumber(lastValue(parsed, "--executors"), 4, 1, 10);
  if (executors === null) return fail("--executors must be a whole number from 1 to 10");
  const stopText = lastValue(parsed, "--stop-at");
  const stops = stopText === undefined ? [] : stopText.split(",").map((stop) => stop.trim());
  const badStop = stops.find((stop) => !isStop(stop));
  if (badStop !== undefined) {
    return fail(
      `--stop-at has an unknown stop "${badStop}" (after_plan, after_node:<id>, on_audit_failure, on_budget_pct:<n>, at_end)`,
    );
  }
  const dataDirFlag = lastValue(parsed, "--data-dir");
  const startText = lastValue(parsed, "--start");
  const start =
    startText === undefined
      ? dataDirFlag === undefined
        ? DEMO_START
        : clockFor(host).now()
      : parseInstant(startText);
  if (start === null) return fail("--start takes an ISO 8601 date or time, or epoch milliseconds");

  const temporary = dataDirFlag === undefined;
  const dataDir = temporary
    ? mkdtempSync(join(tmpdir(), "haril-demo-"))
    : resolve(host.cwd ?? process.cwd(), dataDirFlag);
  let current = start;
  const clock: Clock & { set(ms: number): void } = {
    now: () => current,
    set: (ms) => {
      current = ms;
    },
    schedule: () => () => undefined,
  };
  const ids = temporary ? sequentialIds() : storeAccess(host).ids;
  let outcome: DemoOutcome | string;
  try {
    outcome = runOnStore(dataDir, temporary, clock, ids, host, {
      goal,
      seed,
      delegators,
      executors,
      stops: stops as Stop[],
      start,
    });
  } finally {
    if (temporary) rmSync(dataDir, { recursive: true, force: true });
  }
  if (typeof outcome === "string") return fail(outcome);

  const { snapshot, result, chain, rows } = outcome;
  const limits = DEFAULT_DELEGATION_LIMITS;
  const store = temporary
    ? { kind: "temporary", path: dataDir, removed: true }
    : { kind: "data-dir", path: dataDir, removed: false };
  if (parsed.flags.has("--json")) {
    io.out(
      JSON.stringify({
        snapshot,
        demo: { seed, start, goal, delegators, executors, stops, store },
        orderId: result.orderId,
        peaks: result.peaks,
        limits: {
          executors: limits.maxConcurrent.executors,
          auditors: limits.maxConcurrent.auditors,
          delegators: limits.maxConcurrent.delegators,
          writers: limits.maxConcurrent.writers,
          orchestratorChildren: limits.maxActiveChildren.orchestrator,
          delegatorChildren: limits.maxActiveChildren.delegator,
          agents: limits.maxAgentsPerWorkflow,
          auditRetries: limits.maxAuditRetries,
          escalations: limits.maxEscalationsPerTask,
        },
        counts: result.counts,
        rework: result.rework,
        chain,
        rows,
      }),
    );
  } else {
    for (const line of renderText(snapshot, result, chain, rows, seed, store)) io.out(line);
  }
  return snapshot.workflow.state === "failed" ? EXIT_INVALID : EXIT_OK;
}

function runOnStore(
  dataDir: string,
  temporary: boolean,
  clock: Clock & { set(ms: number): void },
  ids: Ids,
  host: HostInfo,
  options: {
    goal: string;
    seed: number;
    delegators: number;
    executors: number;
    stops: Stop[];
    start: number;
  },
): DemoOutcome | string {
  const store = openStore({
    dataDir,
    clock,
    ids,
    rules: STORE_RULES,
    runtime: { nodeVersion: host.nodeVersion },
    env: host.env ?? process.env,
    ...(host.isPidAlive === undefined ? {} : { isPidAlive: host.isPidAlive }),
  });
  try {
    if (!temporary && store.commands.listQueued().length > 0) {
      return `${dataDir} has queued commands; run haril start there first, or give --data-dir an empty folder`;
    }
    const project =
      store.projects.getBySlug("workflow-demo") ??
      store.projects.register({
        slug: "workflow-demo",
        name: "Workflow demo (simulated)",
        rootPath: temporary ? dataDir : join(dataDir, "workflow-demo"),
      });
    const grant = store.runtime.acquire({
      pid: process.pid,
      nodeVersion: host.nodeVersion,
      sqliteVersion: store.info().sqliteVersion,
      ttlMs: 600_000,
    });
    if (!grant.ok) {
      return `a runtime holds the lease of ${dataDir} (pid ${grant.error.pid}); stop it or use another --data-dir`;
    }
    const epoch = grant.value.epoch;
    let result: DemoResult;
    try {
      result = runDemoWorkflow(store, epoch, clock, project.projectId, {
        goal: options.goal,
        seed: options.seed,
        delegators: options.delegators,
        executorsPerDelegator: options.executors,
        autonomy: { mode: options.stops.length > 0 ? "stops" : "autonomous", stops: options.stops },
        limits: DEFAULT_DELEGATION_LIMITS,
        policy: DEFAULT_WATCHDOG_POLICY,
        orchestratorModel: ORCHESTRATOR_MODEL,
        models: demoModels(options.start),
        runKey: ids.next(),
      });
    } finally {
      store.runtime.release(epoch, true);
    }
    const snapshot = buildWorkflowSnapshot(store, result.workflowId, {
      now: clock.now(),
      quotaOf,
      quota: quotaRows(options.start),
    });
    return {
      snapshot,
      result,
      chain: store.usageLog.verify(),
      rows: {
        orders: store.usageLog.orders({ workflowId: result.workflowId }).length,
        usage: store.usageLog.usage({ workflowId: result.workflowId }).length,
      },
    };
  } finally {
    store.close();
  }
}

function renderText(
  snapshot: WorkflowSnapshot,
  result: DemoResult,
  chain: ReturnType<Store["usageLog"]["verify"]>,
  rows: { orders: number; usage: number },
  seed: number,
  store: { kind: string; path: string; removed: boolean },
): string[] {
  const limits = DEFAULT_DELEGATION_LIMITS;
  const { totals } = snapshot;
  const { peaks, counts } = result;
  const lines = [
    ...headerLines(snapshot, `simulated, seed ${seed}`),
    "",
    ...treeLines(snapshot),
    "",
  ];
  lines.push(
    `totals     agents ${totals.agentsCreated}/${totals.agentsCap} · tokens ${kilo(totals.tokensUsed)} of ${kilo(totals.tokensBudget ?? 0)} · queued ${totals.queued}`,
    `rework     retries ${counts.retries} · escalations ${counts.escalations} · reformulations ${counts.reformulations} · idle closes ${counts.idleCloses} · failed nodes ${counts.failedNodes} · proposals refused ${counts.proposalsRefused}`,
    `peak live  executors ${peaks.executors}/${limits.maxConcurrent.executors} · auditors ${peaks.auditors}/${limits.maxConcurrent.auditors} · delegators ${peaks.delegators}/${limits.maxConcurrent.delegators} · writers ${peaks.writers}/${limits.maxConcurrent.writers} · children of the orchestrator ${peaks.orchestratorChildren}/${limits.maxActiveChildren.orchestrator} · of a delegator ${peaks.delegatorChildren}/${limits.maxActiveChildren.delegator}`,
    `watchdog   checks ${counts.watchdogChecks} · closed ${counts.idleCloses}`,
    `quota      ${snapshot.quota
      .map((row) =>
        row.window5hPct === null
          ? `${row.provider} sin dato`
          : `${row.provider} ${row.window5hPct}%/5h ${row.weeklyPct}%/week${row.note === "in use" ? "" : ` (${row.note.split(":")[1]?.trim() ?? row.note})`}`,
      )
      .join(" · ")}`,
    `usage log  ${rows.orders} ${rows.orders === 1 ? "order" : "orders"} · ${rows.usage} usage rows · chain ${chain.ok ? "ok" : "BROKEN"}`,
  );
  const state = snapshot.workflow.state;
  const reason =
    snapshot.events.filter((event) => event.type.startsWith("workflow.")).at(-1)?.text ?? "";
  if (state === "awaiting_human") {
    lines.push(
      `stopped    at ${reason.replace("reason=", "")}: the workflow waits for haril workflow continue (phase F2); its queued turns stay in the store`,
    );
  } else if (state === "failed") {
    lines.push(`failed     ${reason.replace("reason=", "")}`);
  }
  lines.push(
    store.removed
      ? "store      temporary, removed (keep the rows with --data-dir <path>)"
      : `store      ${store.path} (read it with haril usage log --data-dir ${store.path})`,
  );
  return lines;
}

export function workflow(args: readonly string[], io: CliIo, host: HostInfo): number {
  const [sub, ...rest] = args;
  if (sub === "demo") return demo(rest, io, host);
  io.err(USAGE);
  return EXIT_USAGE;
}
