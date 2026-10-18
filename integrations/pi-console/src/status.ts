import { runHarilJson } from "./cli.js";

// The HARIL side of the bar: the pending approvals and whether a runtime holds the lease, read through the CLI
// (`haril approvals --json` and `haril status --json`), scoped to the bound project when there is one.

export interface PendingApproval {
  readonly approvalId: string;
  readonly projectSlug: string;
  readonly tasks: number;
  readonly model: string | null;
}

export interface HarilStatus {
  // undefined when the CLI could not answer.
  readonly runtimeAlive: boolean | undefined;
  readonly pending: readonly PendingApproval[] | undefined;
}

interface LeaseView {
  readonly status?: unknown;
  readonly pid?: unknown;
  readonly expiresAt?: unknown;
}

// A lease holder is alive when its lease is active and unexpired and its process exists (as haril shell judges it).
function leaseAlive(lease: LeaseView | undefined, now: number): boolean {
  if (lease?.status !== "active") return false;
  if (typeof lease.expiresAt !== "number" || lease.expiresAt <= now) return false;
  return typeof lease.pid === "number" && pidAlive(lease.pid);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as { code?: unknown }).code === "EPERM";
  }
}

function scope(slug: string | undefined): string[] {
  return slug === undefined ? [] : ["--project", slug];
}

export async function readPending(
  slug: string | undefined,
): Promise<PendingApproval[] | undefined> {
  const listed = await runHarilJson(["approvals", "--json", ...scope(slug)]);
  if (!Array.isArray(listed)) return undefined;
  const pending: PendingApproval[] = [];
  for (const row of listed as Record<string, unknown>[]) {
    if (typeof row.approvalId !== "string") continue;
    pending.push({
      approvalId: row.approvalId,
      projectSlug: typeof row.projectSlug === "string" ? row.projectSlug : "",
      tasks: typeof row.tasks === "number" ? row.tasks : 0,
      model: typeof row.model === "string" ? row.model : null,
    });
  }
  return pending;
}

export async function readRuntimeAlive(slug: string | undefined): Promise<boolean | undefined> {
  const report = await runHarilJson(["status", "--json", ...scope(slug)]);
  if (typeof report !== "object" || report === null) return undefined;
  return leaseAlive((report as { runtime?: LeaseView }).runtime, Date.now());
}

export async function readStatus(slug: string | undefined): Promise<HarilStatus> {
  const [runtimeAlive, pending] = await Promise.all([readRuntimeAlive(slug), readPending(slug)]);
  return { runtimeAlive, pending };
}
