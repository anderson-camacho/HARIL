import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runHaril } from "./cli.js";
import { type DelegationView, decodeDelegationView } from "./delegation-settings.js";
import type { PendingApproval } from "./status.js";

export interface DashboardMethodology {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
  readonly summary: string;
}

interface DashboardTask {
  readonly taskId: string;
  readonly state: string;
  readonly goal: string;
  readonly agent: string;
  readonly model: string | null;
}

export interface DashboardEvent {
  readonly seq: number;
  readonly time: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly taskId: string | null;
}

export interface DashboardData {
  readonly projectSlug: string | undefined;
  readonly initialized: boolean | undefined;
  readonly runtimeAvailable: boolean;
  readonly tasks: readonly DashboardTask[];
  readonly queued: readonly string[];
  readonly approvals: readonly PendingApproval[];
  readonly approvalsAvailable: boolean;
  readonly events: readonly DashboardEvent[];
  readonly methodologies: readonly string[];
  readonly methodologyEntries: readonly DashboardMethodology[];
  readonly methodologiesAvailable: boolean;
  readonly memorySummary: string;
  readonly errors: readonly string[];
  readonly loadedAt: number | undefined;
  // haril.json's delegation settings (haril config get delegation --json, phase F7), or why they are not shown. Kept out
  // of `errors`: the project's data does not depend on them.
  readonly delegation?: DelegationView;
  readonly delegationError?: string;
}

export const emptyDashboardData = (projectSlug?: string): DashboardData => ({
  projectSlug,
  initialized: undefined,
  runtimeAvailable: false,
  tasks: [],
  queued: [],
  approvals: [],
  approvalsAvailable: false,
  events: [],
  methodologies: [],
  methodologyEntries: [],
  methodologiesAvailable: false,
  memorySummary: "not loaded",
  errors: [],
  loadedAt: undefined,
});

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rows(value: unknown): Record<string, unknown>[] | undefined {
  return Array.isArray(value)
    ? value.map(record).filter((row): row is Record<string, unknown> => row !== undefined)
    : undefined;
}

async function readJson(
  args: readonly string[],
  label: string,
  scoped: boolean,
): Promise<{ value?: unknown; error?: string }> {
  const result = await runHaril(args, { timeoutMs: 10_000 });
  if (!result.ok)
    return {
      error: `${label}: ${result.stderr.trim() || `command failed (${result.code ?? "unknown"})`}`,
    };
  try {
    return { value: JSON.parse(result.stdout) as unknown };
  } catch {
    return { error: `${label}: HARIL returned invalid JSON${scoped ? " for this project" : ""}` };
  }
}

// The delegation settings for TOOLS, or the reason they are not shown.
async function readDelegation(): Promise<Pick<DashboardData, "delegation" | "delegationError">> {
  const result = await readJson(
    ["config", "get", "delegation", "--json"],
    "Delegation settings",
    false,
  );
  if (result.error !== undefined) return { delegationError: result.error };
  const view = decodeDelegationView(result.value);
  return view === undefined
    ? { delegationError: "Delegation settings: unexpected JSON shape" }
    : { delegation: view };
}

export async function loadDashboardData(projectSlug: string | undefined): Promise<DashboardData> {
  const methodsPromise = readJson(["methodology", "list", "--json"], "Methodologies", false);
  const delegationPromise = readDelegation();
  if (projectSlug === undefined) {
    const methodsResult = await methodsPromise;
    const decoded = decodeMethodologies(methodsResult.value);
    const errors = methodsResult.error === undefined ? [] : [methodsResult.error];
    if (methodsResult.value !== undefined && decoded === undefined)
      errors.push("Methodologies: unexpected JSON shape");
    return {
      ...emptyDashboardData(),
      methodologies: decoded?.map(formatMethodology) ?? [],
      methodologyEntries: decoded ?? [],
      methodologiesAvailable: methodsResult.error === undefined && decoded !== undefined,
      errors,
      loadedAt: Date.now(),
      ...(await delegationPromise),
    };
  }
  const scope = ["--project", projectSlug];
  const [statusResult, approvalsResult, eventsResult, methodsResult] = await Promise.all([
    readJson(["status", ...scope, "--json"], "Project status", true),
    readJson(["approvals", ...scope, "--json"], "Approvals", true),
    readJson(["events", ...scope, "--limit", "20", "--json"], "Events", true),
    methodsPromise,
  ]);
  const status = record(statusResult.value);
  const lease = record(status?.runtime);
  const leaseState = lease?.status;
  const runtimeAvailable =
    leaseState === "none" ||
    (lease !== undefined &&
      (leaseState === "active" || leaseState === "released" || leaseState === "lost") &&
      typeof lease.pid === "number" &&
      typeof lease.expiresAt === "number");
  const tasks = rows(status?.taskList);
  const queued = rows(status?.queuedCommands);
  const approvals = rows(approvalsResult.value);
  const events = rows(eventsResult.value);
  const methodList = decodeMethodologies(methodsResult.value);
  const memory = record(status?.memory);
  const outbox = record(memory?.outbox);
  const results = [statusResult, approvalsResult, eventsResult, methodsResult];
  const errors = results.flatMap((result) => (result.error === undefined ? [] : [result.error]));
  if (statusResult.value !== undefined && status === undefined)
    errors.push("Project status: unexpected JSON shape");
  else if (statusResult.value !== undefined && !runtimeAvailable)
    errors.push("Project status: runtime lease state is missing or unrecognized");
  if (approvalsResult.value !== undefined && approvals === undefined)
    errors.push("Approvals: unexpected JSON shape");
  if (eventsResult.value !== undefined && events === undefined)
    errors.push("Events: unexpected JSON shape");
  if (methodsResult.value !== undefined && methodList === undefined)
    errors.push("Methodologies: unexpected JSON shape");
  return {
    projectSlug,
    initialized: typeof status?.initialized === "boolean" ? status.initialized : undefined,
    runtimeAvailable,
    tasks: (tasks ?? []).flatMap((row) => {
      if (typeof row.taskId !== "string" || typeof row.state !== "string") return [];
      return [
        {
          taskId: row.taskId,
          state: row.state,
          goal: typeof row.goal === "string" ? row.goal : "(no goal recorded)",
          agent: typeof row.agentRef === "string" ? row.agentRef : "unknown",
          model: typeof row.model === "string" ? row.model : null,
        },
      ];
    }),
    queued: (queued ?? []).flatMap((row) =>
      typeof row.commandId === "string"
        ? [`${row.commandId} · ${String(row.type ?? "queued command")}`]
        : [],
    ),
    approvals: (approvals ?? []).flatMap((row) => {
      if (typeof row.approvalId !== "string" || row.projectSlug !== projectSlug) return [];
      return [
        {
          approvalId: row.approvalId,
          projectSlug,
          tasks: typeof row.tasks === "number" ? row.tasks : 0,
          model: typeof row.model === "string" ? row.model : null,
        },
      ];
    }),
    approvalsAvailable: approvalsResult.error === undefined && approvals !== undefined,
    events: (events ?? []).flatMap((row) => {
      if (typeof row.seq !== "number" || typeof row.type !== "string") return [];
      return [
        {
          seq: row.seq,
          time: typeof row.time === "string" ? row.time : "unknown time",
          type: row.type,
          aggregateType: typeof row.aggregateType === "string" ? row.aggregateType : "event",
          aggregateId: typeof row.aggregateId === "string" ? row.aggregateId : "unknown",
          taskId: typeof row.taskId === "string" ? row.taskId : null,
        },
      ];
    }),
    methodologies: methodList?.map(formatMethodology) ?? [],
    methodologyEntries: methodList ?? [],
    methodologiesAvailable: methodsResult.error === undefined && methodList !== undefined,
    memorySummary:
      memory === undefined
        ? "unavailable from HARIL status"
        : `${String(memory.provider ?? "provider unknown")} · ${String(memory.health ?? "health unknown")} · degraded ${String(memory.degraded ?? "unknown")} · outbox ${String(outbox?.depth ?? "unknown")}`,
    errors,
    loadedAt: Date.now(),
    ...(await delegationPromise),
  };
}

function decodeMethodologies(value: unknown): DashboardMethodology[] | undefined {
  const methodRows = record(value)?.methodologies;
  if (!Array.isArray(methodRows)) return undefined;
  const decoded: DashboardMethodology[] = [];
  for (const candidate of methodRows) {
    const row = record(candidate);
    if (
      row === undefined ||
      typeof row.id !== "string" ||
      typeof row.version !== "string" ||
      typeof row.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.sha256)
    )
      return undefined;
    const match = /^haril\.methodology\.([a-z0-9][a-z0-9-]*)$/.exec(row.id);
    const name = match?.[1];
    if (name === undefined) return undefined;
    decoded.push({
      id: row.id,
      name,
      version: row.version,
      sha256: row.sha256,
      summary: typeof row.summary === "string" ? row.summary : "No summary provided.",
    });
  }
  return decoded;
}

function formatMethodology(entry: DashboardMethodology): string {
  return `${entry.id} · v${entry.version} · ${entry.summary}`;
}

export async function readMethodologyDefinition(
  entry: DashboardMethodology,
): Promise<{ readonly contents?: string; readonly error?: string }> {
  const cliPath = process.env.HARIL_CLI;
  if (cliPath === undefined || cliPath === "")
    return { error: "HARIL_CLI is unavailable; the installed definition path cannot be resolved." };
  const match = /^haril\.methodology\.([a-z0-9][a-z0-9-]*)$/.exec(entry.id);
  const name = match?.[1];
  if (name === undefined || name !== entry.name)
    return { error: "The selected methodology identifier is invalid." };
  const path = join(dirname(cliPath), "blocks", "methodologies", name, "block.md");
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1_048_576)
      return {
        error:
          "The selected methodology definition is unavailable or exceeds the 1 MiB display limit.",
      };
    const contents = await readFile(path, "utf8");
    const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
    const header = frontMatter?.[1];
    if (header === undefined)
      return { error: "The bundled methodology has no valid metadata header." };
    const metadata = record(JSON.parse(header) as unknown);
    if (metadata === undefined || metadata.id !== entry.id || metadata.version !== entry.version)
      return { error: "The bundled definition does not match the selected registry version." };
    const digest = createHash("sha256").update(contents, "utf8").digest("hex");
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || digest !== entry.sha256)
      return { error: "The bundled definition hash does not match the selected registry entry." };
    return { contents };
  } catch {
    return { error: `The bundled definition for ${entry.id} could not be read.` };
  }
}

export async function readApproval(
  projectSlug: string,
  approvalId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await runHaril(["approvals", "show", approvalId, "--json"], { timeoutMs: 10_000 });
  if (!result.ok) return undefined;
  try {
    const approval = record(JSON.parse(result.stdout) as unknown);
    return approval?.approvalId === approvalId && approval.projectSlug === projectSlug
      ? approval
      : undefined;
  } catch {
    return undefined;
  }
}

export function summarizeApproval(approval: Record<string, unknown>): string[] {
  const details = [
    `Approval ${String(approval.approvalId)}`,
    `Project ${String(approval.projectSlug)} · ${String(approval.status)} · ${String(approval.tasks)} tasks`,
    `Requested by ${String(approval.requestedBy ?? "unknown")}`,
  ];
  const plan = record(approval.plan);
  const planTasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  for (const [index, entry] of planTasks.entries()) {
    const task = record(entry);
    if (task !== undefined)
      details.push(`${index + 1}. ${String(task.title ?? task.goal ?? "Task")}`);
  }
  return details;
}
