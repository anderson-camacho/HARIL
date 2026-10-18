import { isStop, type Stop } from "@haril/contracts";
import { type DelegationLimits, orderPreview, visibleText } from "@haril/core";
import type { Store, WorkflowRecord } from "@haril/core/ports";
import { detectBaseBranch, inspectRepository } from "@haril/git";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_INVALID, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { loadDelegationSettings } from "../delegation-config.js";
import { delegationLimitsOf } from "../delegation-section.js";
import { clockFor, storeAccess } from "../host.js";
import { dataDirFor, openExisting, queueCommand, withProject } from "./common.js";
import { piContextUsed } from "./pi-context.js";
import { storeQuota } from "./snapshot-quota.js";
import { buildWorkflowSnapshot, headerLines, treeLines } from "./workflow-snapshot.js";

// `haril workflow start|list|show|continue` (docs/modos-y-delegacion.md 6, 3.13; phase F2). start queues workflow.start
// for the runtime with the human's choices: the goal, the orchestrator's model (pinned, 3.11), the agent family and the
// autonomy (P1: with nothing said, it stops after the first plan). It also writes the order to the orders log (4.5).
// list and show read the store; show --json prints WorkflowSnapshot v1 (ADR-0021). continue queues the human's
// workflow.continue, the only way a stop is lifted (3.13). haril.json's delegation section (phase F7) gives what start
// does not say: the orchestrator's model (models.layers.orchestrator.model, after --model and before
// HARIL_DEFAULT_MODEL), the default stops (autonomy.defaultStops) and the snapshot of the limits and the compaction
// thresholds the workflow keeps (P11). The agents follow the orchestrator's ref: orchestrator runs
// real Pi agents (orchestrator, delegator, executor, auditor), and fake:orchestrate runs the fake workflow agents
// (fake:delegate, fake:execute, fake:audit).
//
// Phase F8: a workflow on a project whose root is the top level of a git repository writes. start fixes its base branch
// (--base, else haril.json's delegation.git.baseBranch, else main or the default branch detected when the project names
// it otherwise) and that branch's commit, so every executor's worktree starts from it whatever happens to the branch
// meanwhile, and the result goes to the integration branch haril/<workflow>/integration. --read-only keeps a workflow
// from writing. Without git, or when the root is not a repository's top level, the workflow stays read-only and start
// says why.

const START_USAGE = [
  "usage: haril workflow start <goal> [--model <ref>] [--agent <ref>] [--autonomous | --stop-at <stops>] [--project <slug>]",
  "                            [--budget-tokens <n>] [--read-only | --base <branch>] [--idempotency-key <key>] [--json]",
  "                            [--data-dir <path>]",
  "  queues a three-layer workflow for the runtime (haril start runs it). --model is the orchestrator's model (pinned),",
  "  default delegation.models.layers.orchestrator.model in haril.json, then HARIL_DEFAULT_MODEL; every child runs on it",
  "  until the model catalog arrives. --agent orchestrator runs real Pi agents; the default, fake:orchestrate, runs the",
  "  simulated agents. Without --autonomous or --stop-at it stops at delegation.autonomy.defaultStops (default",
  "  after_plan); continue it with haril workflow continue. The workflow keeps haril.json's limits as they are now.",
  "  In a git project the executors write, each in its own worktree from main (or --base, or delegation.git.baseBranch),",
  "  and the delegators merge their work into the branch haril/<workflow>/integration for you to review; nothing is",
  "  merged into main or pushed. --read-only keeps the agents from writing.",
].join("\n");
const LIST_USAGE = "usage: haril workflow list [--project <slug>] [--json] [--data-dir <path>]";
const SHOW_USAGE = "usage: haril workflow show <workflowId> [--json] [--data-dir <path>]";
const CONTINUE_USAGE =
  "usage: haril workflow continue <workflowId> [--remove-stop <stop>]... [--project <slug>] [--json] [--data-dir <path>]";
const MODEL_ENV = "HARIL_DEFAULT_MODEL";
// Provisional (F2b): the default stays the simulated family, like haril task add's fake:succeed; real agents are asked
// for with --agent orchestrator.
const DEFAULT_AGENT = "fake:orchestrate";
const REAL_ORCHESTRATOR = "orchestrator";
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

// What start fixes for a workflow that writes (phase F8), or why it stays read-only. `configured` names haril.json's
// git.baseBranch when that branch is what the repository lacks.
type WritingBase =
  | { readonly writes: true; readonly branch: string; readonly sha: string }
  | { readonly writes: false; readonly reason: string; readonly configured?: string };

// The base branch, in order: --base, haril.json's delegation.git.baseBranch, then detection (main, else the remote's
// default, init.defaultBranch or master). A branch the user named, on the command line or in the file, is never swapped
// for another one.
async function writingBaseOf(
  root: string,
  readOnly: boolean,
  requested: string | null,
  configured: string | null,
): Promise<WritingBase> {
  if (readOnly) return { writes: false, reason: "--read-only" };
  const repository = await inspectRepository(root);
  if (!repository.ok) return { writes: false, reason: repository.detail };
  const base = await detectBaseBranch(root, requested ?? configured);
  if (base.ok) return { writes: true, branch: base.branch, sha: base.sha };
  return requested === null && configured !== null
    ? { writes: false, reason: base.detail, configured }
    : { writes: false, reason: base.detail };
}

// A writing workflow's limits (phase F8) on top of haril.json's (phase F7): with worktrees the writers no longer share
// one checkout, so up to the executor limit write at once (3.9.4: the writer limit was 1 only until worktrees existed);
// the surface locks still serialize writers whose files may overlap.
function limitsFor(base: WritingBase, configured: DelegationLimits): DelegationLimits {
  if (!base.writes) return configured;
  const concurrent = configured.maxConcurrent;
  return {
    ...configured,
    maxConcurrent: { ...concurrent, writers: Math.max(concurrent.writers, concurrent.executors) },
  };
}

// The project root start would queue for: --project's, or the only one. Undefined when the store or the project is
// missing (the enqueue step then says why).
function projectRootFor(
  host: HostInfo,
  dataDir: string,
  slug: string | undefined,
): string | undefined {
  let root: string | undefined;
  const silent = { out: () => undefined, err: () => undefined, readFile: () => "" };
  withProject(silent, host, dataDir, slug, (_store, project) => {
    root = project.rootPath;
    return EXIT_OK;
  });
  return root;
}

export async function workflowStart(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
): Promise<number> {
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
      "--base",
    ],
    flags: ["--json", "--autonomous", "--read-only"],
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
  // P11: what the workflow keeps from haril.json; a file the rules refuse stops the start, with each problem.
  const delegation = loadDelegationSettings(host);
  if (!delegation.ok) {
    io.err(`haril: ${delegation.path} has problems; fix them first (haril doctor lists them):`);
    for (const error of delegation.errors) io.err(`  ${error}`);
    return EXIT_USAGE;
  }
  const settings = delegation.settings;
  const model = (
    lastValue(parsed, "--model") ??
    settings.models.layers.orchestrator.model ??
    host.env?.[MODEL_ENV] ??
    ""
  ).trim();
  if (model === "") {
    return fail(
      io,
      `the orchestrator needs a model: pass --model <ref> (see haril models), set delegation.models.layers.orchestrator.model (haril config set) or set ${MODEL_ENV}`,
    );
  }
  const agent = (lastValue(parsed, "--agent") ?? DEFAULT_AGENT).trim();
  if (agent === "") return fail(io, "--agent needs an agent reference");
  // The root decides the family of every turn (orchestrator's children are the real archetypes, a fake: root's are the
  // fake workflow agents), so any other ref would start a workflow no agent can run.
  if (agent !== REAL_ORCHESTRATOR && agent !== DEFAULT_AGENT) {
    return fail(
      io,
      `--agent takes ${REAL_ORCHESTRATOR} (real agents) or ${DEFAULT_AGENT} (simulated agents); got "${agent}"`,
    );
  }
  const stops = stopsOf(lastValue(parsed, "--stop-at"));
  if (typeof stops === "string") return fail(io, stops);
  const autonomous = parsed.flags.has("--autonomous");
  if (autonomous && stops.length > 0)
    return fail(io, "--autonomous and --stop-at exclude each other");
  // P1: with nothing said, the workflow stops at haril.json's default stops (after_plan unless changed); none is
  // autonomous.
  const chosen = autonomous ? [] : stops.length > 0 ? stops : [...settings.autonomy.defaultStops];
  const autonomy = { mode: chosen.length === 0 ? "autonomous" : "stops", stops: chosen };
  const budgetText = lastValue(parsed, "--budget-tokens");
  const budgetTokens = budgetText === undefined ? DEFAULT_BUDGET_TOKENS : Number(budgetText);
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1) {
    return fail(io, "--budget-tokens takes a whole number of at least 1");
  }
  const explicitKey = lastValue(parsed, "--idempotency-key");
  if (explicitKey !== undefined && explicitKey.trim() === "") {
    return fail(io, "--idempotency-key needs a value");
  }
  const readOnly = parsed.flags.has("--read-only");
  const requestedBase = lastValue(parsed, "--base") ?? null;
  if (readOnly && requestedBase !== null)
    return fail(io, "--read-only and --base exclude each other");
  if (requestedBase !== null && requestedBase.trim() === "")
    return fail(io, "--base needs a branch name");
  const json = parsed.flags.has("--json");
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const slug = lastValue(parsed, "--project");
  const root = projectRootFor(host, dataDir, slug);
  const base: WritingBase =
    root === undefined
      ? { writes: false, reason: "no project" }
      : await writingBaseOf(root, readOnly, requestedBase, settings.git.baseBranch);
  if (requestedBase !== null && !base.writes) {
    return fail(io, `--base ${requestedBase}: ${base.reason}`);
  }
  if (!base.writes && base.configured !== undefined) {
    return fail(
      io,
      `delegation.git.baseBranch "${base.configured}": ${base.reason}; pass --base <branch> or --read-only, or change it with haril config set`,
    );
  }
  const limits = limitsFor(base, delegationLimitsOf(settings.limits));
  const idempotencyKey = explicitKey ?? `workflow-start-${storeAccess(host).ids.next()}`;
  return withProject(io, host, dataDir, slug, (store, project) => {
    // 4.5: the order that passes through the shell, its hash, length and redacted preview, never its text.
    const order = store.usageLog.appendOrder({
      mode: "delegacion",
      source: "cli",
      text: goal,
      preview: orderPreview(goal),
      projectId: project.projectId,
      idempotencyKey: `order:${idempotencyKey}`,
    });
    const code = queueCommand(
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
          // P11: the limits and the compaction thresholds are a snapshot taken when the workflow starts.
          limits: { ...limits, context: settings.context },
          budgetTokens,
          timeoutMs: limits.attemptTimeoutMs,
          orderId: order.record.orderId,
          // Phase F8: the base branch and the commit every worktree of the workflow starts from.
          ...(base.writes ? { baseBranch: base.branch, baseSha: base.sha } : {}),
        },
        idempotencyKey,
      },
      dataDir,
    );
    if (!json) {
      io.out(
        visibleText(
          base.writes
            ? `writes     in git worktrees from ${base.branch} ${base.sha.slice(0, 7)}; the result goes to the branch haril/<workflow>/integration (never merged into ${base.branch}, never pushed)`
            : `read-only  the agents write nothing (${base.reason})`,
        ),
      );
    }
    return code;
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
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  return withWorkflow(io, host, lastValue(parsed, "--data-dir"), workflowId, (store, workflow) => {
    const now = clockFor(host).now();
    const snapshot = buildWorkflowSnapshot(store, workflow.workflowId, {
      now,
      ...storeQuota(store, host, now),
      contextUsedOf: (runId) => piContextUsed(dataDir, runId),
    });
    if (parsed.flags.has("--json")) {
      io.out(JSON.stringify(snapshot));
      return EXIT_OK;
    }
    // Which agents ran it: the demo's simulation, the fake workflow agents, or real ones.
    const root = store.workflows.tasks(workflow.workflowId)[0];
    const label = workflow.simulated
      ? "simulated"
      : root?.agentRef.startsWith("fake:") === true
        ? "fake agents"
        : "real agents";
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
