import type { MetricsSnapshot, UsageSummary } from "@haril/core/ports";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { dataDirFor, openExisting } from "./common.js";

// `haril metrics` (M1-T6): read-only. Runs, tasks and events give the counts (ACE-11). Tokens come from the
// budget ledger once the Broker has settled a request (M2-T2); cost stays null because M2 budgets count tokens.
const USAGE = "usage: haril metrics [--project <slug>] [--json] [--data-dir <path>]";
const NOT_INITIALIZED =
  "store not initialized (run haril project init <path> --name <name> --yes first)";
const NOT_YET = "tokens and cost are available from M2 (Broker)";
const NO_COST = "cost is not tracked in M2 (token budgets only)";
const TASK_STATES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

interface MetricsView {
  readonly project: string | null;
  readonly tasks: Readonly<Record<(typeof TASK_STATES)[number], number>>;
  readonly runs: {
    readonly total: number;
    readonly completed: number;
    readonly failed: number;
    readonly orphaned: number;
    readonly running: number;
  };
  readonly retries: number;
  readonly orphanedRecoveries: number;
  readonly successRate: number | null;
  readonly duration: { readonly totalMs: number; readonly averageMs: number | null };
  readonly agents: ReadonlyArray<{
    readonly agentRef: string;
    readonly runs: number;
    readonly completed: number;
    readonly failed: number;
    readonly orphaned: number;
    readonly totalMs: number;
  }>;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly unreconciled: number;
  } | null;
  readonly cost: null;
  readonly note: string;
}

export function metrics(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--project", "--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const store = openExisting(host, dataDirFor(host, lastValue(parsed, "--data-dir")));
  if (store === undefined) {
    io.err(`haril: ${NOT_INITIALIZED}`);
    return EXIT_USAGE;
  }
  try {
    const slug = lastValue(parsed, "--project");
    let projectId: string | undefined;
    if (slug !== undefined) {
      const project = store.projects.getBySlug(slug);
      if (project === undefined) {
        io.err(`haril: no project with slug "${slug}"`);
        return EXIT_USAGE;
      }
      projectId = project.projectId;
    }
    const usage = store.budgets.usageSummary(projectId === undefined ? undefined : { projectId });
    const view = toView(slug ?? null, store.metrics.snapshot(projectId), usage);
    if (parsed.flags.has("--json")) {
      io.out(JSON.stringify(view));
    } else {
      printText(io, view);
    }
    return EXIT_OK;
  } finally {
    store.close();
  }
}

function toView(
  project: string | null,
  snapshot: MetricsSnapshot,
  usage: UsageSummary | null,
): MetricsView {
  const count = (status: string): number => snapshot.runsByStatus[status] ?? 0;
  const completed = count("completed");
  const failed = count("failed");
  const total = Object.values(snapshot.runsByStatus).reduce((sum, n) => sum + n, 0);
  return {
    project,
    tasks: { ...snapshot.tasksByState },
    runs: {
      total,
      completed,
      failed,
      orphaned: count("orphaned"),
      running: count("running"),
    },
    retries: snapshot.retries,
    orphanedRecoveries: snapshot.orphanedRecoveries,
    // Success counts the attempts the agent settled; an orphaned attempt is the runtime's loss, not the agent's.
    successRate: completed + failed === 0 ? null : completed / (completed + failed),
    duration: {
      totalMs: snapshot.durationTotalMs,
      averageMs: snapshot.closedRuns === 0 ? null : snapshot.durationTotalMs / snapshot.closedRuns,
    },
    agents: snapshot.perAgent.map((agent) => ({
      agentRef: agent.agentRef,
      runs: agent.runs,
      completed: agent.completed,
      failed: agent.failed,
      orphaned: agent.orphaned,
      totalMs: agent.totalMs,
    })),
    tokens:
      usage === null
        ? null
        : {
            input: usage.inputTokens,
            output: usage.outputTokens,
            unreconciled: usage.unreconciled,
          },
    cost: null,
    note: usage === null ? NOT_YET : NO_COST,
  };
}

function printText(io: CliIo, view: MetricsView): void {
  io.out(`metrics for ${view.project === null ? "all projects" : `project ${view.project}`}`);
  io.out(`tasks: ${TASK_STATES.map((state) => `${state} ${view.tasks[state]}`).join(", ")}`);
  io.out(
    `runs: ${view.runs.total} total (completed ${view.runs.completed}, failed ${view.runs.failed}, orphaned ${view.runs.orphaned}, running ${view.runs.running})`,
  );
  io.out(`retries: ${view.retries}`);
  io.out(`orphaned recoveries: ${view.orphanedRecoveries}`);
  io.out(
    `success rate: ${view.successRate === null ? "n/a (no settled runs)" : `${(view.successRate * 100).toFixed(1)}%`}`,
  );
  io.out(
    `duration: total ${view.duration.totalMs} ms, average ${view.duration.averageMs === null ? "n/a" : `${view.duration.averageMs.toFixed(1)} ms`}`,
  );
  if (view.agents.length === 0) {
    io.out("agents: none");
  } else {
    io.out("agents:");
    for (const agent of view.agents) {
      io.out(
        `  ${agent.agentRef}: runs ${agent.runs}, completed ${agent.completed}, failed ${agent.failed}, orphaned ${agent.orphaned}`,
      );
    }
  }
  if (view.tokens === null) {
    io.out(`tokens: null, cost: null (${NOT_YET})`);
  } else {
    io.out(
      `tokens: input ${view.tokens.input}, output ${view.tokens.output}, unreconciled ${view.tokens.unreconciled}; cost: null (${NO_COST})`,
    );
  }
}
