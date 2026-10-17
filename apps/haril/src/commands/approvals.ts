import { validatePlanSchema } from "@haril/contracts";
import { checkPlanSubmission, planTaskLines, visibleText } from "@haril/core";
import type { ApprovalRecord, ApprovalStatus } from "@haril/core/ports";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { dataDirFor, nudgeQueued, openExisting } from "./common.js";

// `haril approvals` lists the approvals of the plans (LD-T3); `haril approve` and `haril deny` decide one. A decision is
// a declaration: decidedBy is the operator's OS user name, not an authenticated identity (ARCH 9.12). Each approval names
// the model its plan's tasks will run with (LD-T7a): the model of the task that proposed it, or none.
// `haril approvals show` (LD-T7c) prints one approval with its whole plan, as the shell's plan review shows it, so a
// plan can be read before it is approved from the CLI. Text output shows agent-written text through visibleText; the
// JSON output keeps it as stored.

const LIST_USAGE =
  "usage: haril approvals [--project <slug>] [--all] [--json] | haril approvals show <approvalId> [--json]";
const SHOW_USAGE = "usage: haril approvals show <approvalId> [--json] [--data-dir <path>]";
const SHOW_HINT = "haril approvals show <id> to read a plan";

export function approvals(args: readonly string[], io: CliIo, host: HostInfo): number {
  if (args[0] === "show") return approvalsShow(args.slice(1), io, host);
  const parsed = parseArgs(args, {
    values: ["--project", "--data-dir"],
    flags: ["--json", "--all"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(LIST_USAGE);
    return EXIT_USAGE;
  }
  const json = parsed.flags.has("--json");
  const all = parsed.flags.has("--all");
  const store = openExisting(host, dataDirFor(host, lastValue(parsed, "--data-dir")));
  try {
    const slug = lastValue(parsed, "--project");
    const project = slug === undefined ? undefined : store?.projects.getBySlug(slug);
    if (slug !== undefined && project === undefined) {
      io.err(`haril: no project with slug "${slug}"`);
      return EXIT_USAGE;
    }
    const status: ApprovalStatus | undefined = all ? undefined : "requested";
    const rows = store?.approvals.list({
      ...(project === undefined ? {} : { projectId: project.projectId }),
      ...(status === undefined ? {} : { status }),
    });
    const slugs = new Map(
      (store?.projects.list() ?? []).map((item) => [item.projectId, item.slug]),
    );
    const listing = (rows ?? []).map((approval) => toRow(approval, slugs));
    if (json) {
      io.out(JSON.stringify(listing));
      return EXIT_OK;
    }
    if (listing.length === 0) {
      io.out(all ? "no approvals" : "no pending approvals");
      return EXIT_OK;
    }
    for (const row of listing) {
      io.out(
        visibleText(
          `${row.approvalId}  ${row.projectSlug}  ${row.kind}  ${row.tasks} tasks  model ${row.model ?? "none"}  ${row.status}  requested ${iso(row.requestedAt)}`,
        ),
      );
    }
    io.out(SHOW_HINT);
    return EXIT_OK;
  } finally {
    store?.close();
  }
}

// `haril approvals show <approvalId>` (LD-T7c): read-only. The full id, as approve and deny take it.
function approvalsShow(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [approvalId, ...extra] = parsed.positionals;
  if (approvalId === undefined || extra.length > 0) {
    io.err(SHOW_USAGE);
    return EXIT_USAGE;
  }
  const store = openExisting(host, dataDirFor(host, lastValue(parsed, "--data-dir")));
  if (store === undefined) {
    io.err("haril: no store yet; there is no approval to show");
    return EXIT_USAGE;
  }
  try {
    const approval = store.approvals.get(approvalId);
    if (approval === undefined) {
      io.err(`haril: no approval with id "${visibleText(approvalId)}"`);
      return EXIT_USAGE;
    }
    const slugs = new Map(store.projects.list().map((item) => [item.projectId, item.slug]));
    const row = toRow(approval, slugs);
    if (parsed.flags.has("--json")) {
      io.out(JSON.stringify({ ...row, plan: approval.subject }));
      return EXIT_OK;
    }
    for (const line of approvalLines(row, approval.subject)) io.out(visibleText(line));
    return EXIT_OK;
  } finally {
    store.close();
  }
}

// The header of the approval, then every task of its plan with the fields the shell's plan review shows. A subject
// that is not a plan says so and shows no task. A plan still to be submitted (requested, or granted and not applied
// yet) is checked against the current rules: one stored before a rule existed is refused when the runtime applies it,
// so the approver reads why first (LD-T7c). An applied decision says when.
function approvalLines(row: ApprovalRow, subject: unknown): string[] {
  const checked = validatePlanSchema(subject);
  const pending =
    row.status === "requested" || (row.status === "granted" && row.appliedAt === null);
  const current = checked.ok && pending ? checkPlanSubmission(subject) : undefined;
  const tasks = checked.ok ? `${checked.plan.tasks.length} tasks` : "invalid plan";
  const decided =
    row.decidedAt === null
      ? []
      : [
          `decided by ${row.decidedBy ?? "unknown"} at ${iso(row.decidedAt)}${row.reason === null ? "" : `: ${row.reason}`}`,
        ];
  return [
    `approval ${row.approvalId}`,
    `project ${row.projectSlug}, kind ${row.kind}, status ${row.status}, model ${row.model ?? "none"}, ${tasks}`,
    `requested by ${row.requestedBy} at ${iso(row.requestedAt)}`,
    ...decided,
    ...(row.appliedAt === null ? [] : [`applied ${iso(row.appliedAt)}`]),
    ...(current === undefined || current.ok
      ? []
      : [`refused by the current rules: ${current.reason}`]),
    ...(checked.ok ? [] : [`the plan could not be read: ${checked.errors.join("; ")}`]),
    "",
    ...(checked.ok ? checked.plan.tasks.flatMap((task, index) => planTaskLines(task, index)) : []),
  ];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function approve(args: readonly string[], io: CliIo, host: HostInfo): number {
  return decide("granted", args, io, host);
}

export function deny(args: readonly string[], io: CliIo, host: HostInfo): number {
  return decide("denied", args, io, host);
}

function decide(
  outcome: "granted" | "denied",
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
): number {
  const verb = outcome === "granted" ? "approve" : "deny";
  const parsed = parseArgs(args, { values: ["--reason", "--data-dir"], flags: [] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [approvalId, ...extra] = parsed.positionals;
  if (approvalId === undefined || extra.length > 0) {
    io.err(`usage: haril ${verb} <approvalId> [--reason <text>] [--data-dir <path>]`);
    return EXIT_USAGE;
  }
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const reason = lastValue(parsed, "--reason");
  const store = openExisting(host, dataDir);
  if (store === undefined) {
    io.err("haril: no store yet; there is no approval to decide");
    return EXIT_USAGE;
  }
  try {
    // Store refusals (an unknown id, a second decision) reach the CLI as StoreError and exit 2 (cli.ts).
    const decided = store.approvals.decide({
      approvalId,
      outcome,
      decidedBy: decidedByOf(host),
      ...(reason === undefined ? {} : { reason }),
    });
    // A runtime that is up applies the decision at once; without one it applies it at its next start (ARCH 4.3).
    nudgeQueued(dataDir);
    io.out(
      `approval ${decided.approvalId} ${decided.status} by ${decided.decidedBy ?? "unknown"} (declared, not authenticated); applied by the runtime`,
    );
    return EXIT_OK;
  } finally {
    store.close();
  }
}

function decidedByOf(host: HostInfo): string {
  const user = host.user?.trim();
  return user === undefined || user === "" ? "unknown" : user;
}

interface ApprovalRow {
  readonly approvalId: string;
  readonly projectSlug: string;
  readonly kind: string;
  readonly status: ApprovalStatus;
  readonly tasks: number;
  readonly model: string | null;
  readonly requestedAt: number;
  readonly requestedBy: string;
  readonly decidedAt: number | null;
  readonly decidedBy: string | null;
  readonly reason: string | null;
  readonly appliedAt: number | null;
}

function toRow(approval: ApprovalRecord, slugs: ReadonlyMap<string, string>): ApprovalRow {
  const tasks = (approval.subject as { tasks?: unknown[] }).tasks;
  return {
    approvalId: approval.approvalId,
    projectSlug: slugs.get(approval.projectId) ?? approval.projectId,
    kind: approval.kind,
    status: approval.status,
    tasks: Array.isArray(tasks) ? tasks.length : 0,
    model: approval.model,
    requestedAt: approval.requestedAt,
    requestedBy: approval.requestedBy,
    decidedAt: approval.decidedAt,
    decidedBy: approval.decidedBy,
    reason: approval.reason,
    appliedAt: approval.appliedAt,
  };
}
