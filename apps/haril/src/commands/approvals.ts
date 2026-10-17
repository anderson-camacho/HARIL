import type { ApprovalRecord, ApprovalStatus } from "@haril/core/ports";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { dataDirFor, nudgeQueued, openExisting } from "./common.js";

// `haril approvals` lists the approvals of the plans (LD-T3); `haril approve` and `haril deny` decide one. A decision is
// a declaration: decidedBy is the operator's OS user name, not an authenticated identity (ARCH 9.12).

export function approvals(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: ["--project", "--data-dir"],
    flags: ["--json", "--all"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err("usage: haril approvals [--project <slug>] [--all] [--json]");
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
        `${row.approvalId}  ${row.projectSlug}  ${row.kind}  ${row.tasks} tasks  ${row.status}  requested ${new Date(row.requestedAt).toISOString()}`,
      );
    }
    return EXIT_OK;
  } finally {
    store?.close();
  }
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
    requestedAt: approval.requestedAt,
    requestedBy: approval.requestedBy,
    decidedAt: approval.decidedAt,
    decidedBy: approval.decidedBy,
    reason: approval.reason,
    appliedAt: approval.appliedAt,
  };
}
