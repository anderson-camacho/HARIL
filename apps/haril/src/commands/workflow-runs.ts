import { isStop, type Stop } from "@haril/contracts";
import { DEFAULT_DELEGATION_LIMITS, orderPreview, visibleText } from "@haril/core";
import type { Store, WorkflowRecord } from "@haril/core/ports";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_INVALID, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { clockFor, storeAccess } from "../host.js";
import { dataDirFor, openExisting, queueCommand, withProject } from "./common.js";
import { buildWorkflowSnapshot, headerLines, treeLines } from "./workflow-snapshot.js";

// `haril workflow start|list|show|continue` (docs/modos-y-delegacion.md 6, 3.13; phase F2). start queues workflow.start
// for the runtime with the human's choices: the goal, the orchestrator's model (pinned, 3.11), the agent family and the
// autonomy (P1: with nothing said, it stops after the first plan). It also writes the order to the orders log (4.5).
// list and show read the store; show --json prints WorkflowSnapshot v1 (ADR-0021). continue queues the human's
// workflow.continue, the only way a stop is lifted (3.13). The agents follow the orchestrator's ref: fake:orchestrate
// runs the fake workflow agents (fake:delegate, fake:execute, fake:audit); the real ones get Pi's bridge tools in F2b.

const START_USAGE = [
  "usage: haril workflow start <goal> [--model <ref>] [--agent <ref>] [--autonomous | --stop-at <stops>] [--project <slug>]",
  "                            [--budget-tokens <n>] [--idempotency-key <key>] [--json] [--data-dir <path>]",
  "  queues a three-layer workflow for the runtime (haril start runs it). --model is the orchestrator's model (pinned),",
  "  default HARIL_DEFAULT_MODEL. --agent defaults to fake:orchestrate (the simulated agents; real ones arrive in F2b).",
  "  Without --autonomous or --stop-at it stops after the first plan (after_plan); continue it with haril workflow continue.",
].join("\n");
const LIST_USAGE = "usage: haril workflow list [--project <slug>] [--json] [--data-dir <path>]";
const SHOW_USAGE = "usage: haril workflow show <workflowId> [--json] [--data-dir <path>]";
const CONTINUE_USAGE =
  "usage: haril workflow continue <workflowId> [--remove-stop <stop>]... [--project <slug>] [--json] [--data-dir <path>]";
const MODEL_ENV = "HARIL_DEFAULT_MODEL";
const DEFAULT_AGENT = "fake:orchestrate";
// The orchestrator turn's token budget when --budget-tokens is not given.
const DEFAULT_BUDGET_TOKENS = 200_000;
const NOT_INITIALIZED =
  "store not initialized (run haril project init <path> --name <name> --yes first)";

function fail(io: CliIo, message: string): number {
  io.err(`haril: ${message}`);
  return EXIT_USAGE;
}

function stopsOf(text: string | undefined): Stop[] | string {
  if (text === undefined) return [];
  const stops = text
    .split(",")
    .map((stop) => stop.trim())
    .filter((stop) => stop !== "");
  const bad = stops.find((stop) => !isStop(stop));
  return bad === undefined
    ? (stops as Stop[])
    : `--stop-at has an unknown stop "${bad}" (after_plan, after_node:<id>, on_audit_failure, on_budget_pct:<n>, at_end)`;
}

export function workflowStart(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: [
      "--goal",
      "--model",
      "--agent",
      "--stop-at",
      "--project",
      "--budget-tokens",
      "--idempotency-key",
      "--data-dir",
    ],
    flags: ["--json", "--autonomous"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const goal = (lastValue(parsed, "--goal") ?? parsed.positionals.join(" ")).trim();
  if (goal === "") {
    io.err(START_USAGE);
    return EXIT_USAGE;
  }
  if (lastValue(parsed, "--goal") !== undefined && parsed.positionals.length > 0) {
    return fail(io, "give the goal once: as words or with --goal, not both");
  }
  const model = (lastValue(parsed, "--model") ?? host.env?.[MODEL_ENV] ?? "").trim();
  if (model === "") {
    return fail(
      io,
      `the orchestrator needs a model: pass --model <ref> (see haril models) or set ${MODEL_ENV}`,
    );
  }
  const agent = (lastValue(parsed, "--agent") ?? DEFAULT_AGENT).trim();
  if (agent === "") return fail(io, "--agent needs an agent reference");
  const stops = stopsOf(lastValue(parsed, "--stop-at"));
  if (typeof stops === "string") return fail(io, stops);
  const autonomous = parsed.flags.has("--autonomous");
  if (autonomous && stops.length > 0)
    return fail(io, "--autonomous and --stop-at exclude each other");
  // P1: with nothing said, the workflow stops after the orchestrator's first plan.
  const autonomy = autonomous
    ? { mode: "autonomous", stops: [] }
    : { mode: "stops", stops: stops.length > 0 ? stops : ["after_plan"] };
  const budgetText = lastValue(parsed, "--budget-tokens");
  const budgetTokens = budgetText === undefined ? DEFAULT_BUDGET_TOKENS : Number(budgetText);
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1) {
    return fail(io, "--budget-tokens takes a whole number of at least 1");
  }
  const explicitKey = lastValue(parsed, "--idempotency-key");
  if (explicitKey !== undefined && explicitKey.trim() === "") {
    return fail(io, "--idempotency-key needs a value");
  }
  const json = parsed.flags.has("--json");
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const idempotencyKey = explicitKey ?? `workflow-start-${storeAccess(host).ids.next()}`;
  return withProject(io, host, dataDir, lastValue(parsed, "--project"), (store, project) => {
    // 4.5: the order that passes through the shell, its hash, length and redacted preview, never its text.
    const order = store.usageLog.appendOrder({
      mode: "delegacion",
      source: "cli",
      text: goal,
      preview: orderPreview(goal),
      projectId: project.projectId,
      idempotencyKey: `order:${idempotencyKey}`,
    });
    return queueCommand(
      io,
      json,
      store,
      {
        type: "workflow.start",
        projectId: project.projectId,
        args: {
          goal,
          model,
          agent,
          autonomy,
          // P11: the limits are a snapshot taken when the workflow starts.
          limits: DEFAULT_DELEGATION_LIMITS,
          budgetTokens,
          timeoutMs: DEFAULT_DELEGATION_LIMITS.attemptTimeoutMs,
          orderId: order.record.orderId,
        },
        idempotencyKey,
      },
      dataDir,
    );
  });
}

function listLine(workflow: WorkflowRecord): string {
  const created = new Date(workflow.createdAt).toISOString();
  const why = workflow.stopReason === null ? "" : ` (${workflow.stopReason})`;
  return visibleText(
    `${workflow.workflowId}  ${workflow.state}${why}  ${created}  agents ${workflow.agentsCreated}  ${workflow.goal}`,
  );
}

export function workflowList(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--project", "--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) return fail(io, LIST_USAGE);
  const store = openExisting(host, dataDirFor(host, lastValue(parsed, "--data-dir")));
  if (store === undefined) return fail(io, NOT_INITIALIZED);
  try {
    const slug = lastValue(parsed, "--project");
    const project = slug === undefined ? undefined : store.projects.getBySlug(slug);
    if (slug !== undefined && project === undefined)
      return fail(io, `no project with slug "${slug}"`);
    const workflows = store.workflows.list(
      project === undefined ? {} : { projectId: project.projectId },
    );
    if (parsed.flags.has("--json")) {
      io.out(JSON.stringify(workflows));
    } else if (workflows.length === 0) {
      io.out("no workflow yet (haril workflow start <goal> queues one)");
    } else {
      for (const workflow of workflows) io.out(listLine(workflow));
    }
    return EXIT_OK;
  } finally {
    store.close();
  }
}

function withWorkflow(
  io: CliIo,
  host: HostInfo,
  dataDirFlag: string | undefined,
  workflowId: string,
  work: (store: Store, workflow: WorkflowRecord) => number,
): number {
  const store = openExisting(host, dataDirFor(host, dataDirFlag));
  if (store === undefined) return fail(io, NOT_INITIALIZED);
  try {
    const workflow = store.workflows.get(workflowId);
    if (workflow === undefined) return fail(io, `no workflow with id "${workflowId}"`);
    return work(store, workflow);
  } finally {
    store.close();
  }
}

export function workflowShow(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [workflowId, ...extra] = parsed.positionals;
  if (workflowId === undefined || extra.length > 0) return fail(io, SHOW_USAGE);
  return withWorkflow(io, host, lastValue(parsed, "--data-dir"), workflowId, (store, workflow) => {
    const snapshot = buildWorkflowSnapshot(store, workflow.workflowId, {
      now: clockFor(host).now(),
    });
    if (parsed.flags.has("--json")) {
      io.out(JSON.stringify(snapshot));
      return EXIT_OK;
    }
    const label = workflow.simulated ? "simulated" : (workflow.stopReason ?? "live");
    for (const line of [...headerLines(snapshot, label), "", ...treeLines(snapshot)]) io.out(line);
    const { totals } = snapshot;
    io.out("");
    io.out(
      `totals     agents ${totals.agentsCreated}/${totals.agentsCap} · tokens ${totals.tokensUsed} · queued ${totals.queued} · retries ${totals.retries} · escalations ${totals.escalations}`,
    );
    if (workflow.state === "awaiting_human") {
      io.out(
        `stopped    at ${workflow.stopReason ?? "a stop"}: continue it with haril workflow continue ${workflow.workflowId}`,
      );
    } else if (workflow.state === "failed") {
      io.out(visibleText(`failed     ${workflow.stopReason ?? ""}`));
    }
    return workflow.state === "failed" ? EXIT_INVALID : EXIT_OK;
  });
}

export function workflowContinue(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: ["--remove-stop", "--project", "--data-dir"],
    flags: ["--json"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [workflowId, ...extra] = parsed.positionals;
  if (workflowId === undefined || extra.length > 0) return fail(io, CONTINUE_USAGE);
  const remove = parsed.values.get("--remove-stop") ?? [];
  const bad = remove.find((stop) => !isStop(stop));
  if (bad !== undefined) return fail(io, `--remove-stop has an unknown stop "${bad}"`);
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  return withProject(io, host, dataDir, lastValue(parsed, "--project"), (store, project) => {
    const workflow = store.workflows.get(workflowId);
    if (workflow === undefined || workflow.projectId !== project.projectId) {
      return fail(io, `no workflow "${workflowId}" in project ${project.slug}`);
    }
    if (workflow.state !== "awaiting_human") {
      return fail(io, `workflow ${workflowId} is ${workflow.state}, not waiting for you`);
    }
    return queueCommand(
      io,
      parsed.flags.has("--json"),
      store,
      {
        type: "workflow.continue",
        projectId: project.projectId,
        args: { workflowId, removeStops: remove },
        idempotencyKey: `workflow-continue-${storeAccess(host).ids.next()}`,
      },
      dataDir,
    );
  });
}
