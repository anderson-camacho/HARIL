import { type HarilStream, streamHaril } from "./cli.js";
import type { FactoryModel } from "./factory-types.js";

// The factory view's real data: `haril factory watch` runs as a child while the view is open and prints a FactoryModel
// per line on every change. The console reads HARIL only through the CLI (check-layers R6). A line that is not what it
// should be is dropped: nothing made up reaches the view. A child that dies is started again a bounded number of times,
// then the view is told the data stopped.

const EXIT_WITH_CONSOLE = "--exit-on-stdin-end";
const RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000];
const WORKFLOW_STATES = new Set(["running", "awaiting_human", "completed", "failed", "stopped"]);
const COLUMNS = new Set(["por_hacer", "en_curso", "detenidas", "errores", "hechas"]);
const REQUEST_KINDS = new Set(["approval", "stop", "task"]);
const QUOTA_SOURCES = new Set(["api", "estimated", "none"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function text(value: unknown): value is string {
  return typeof value === "string";
}

function textOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function explanationOk(value: unknown): boolean {
  const item = record(value);
  return (
    item !== undefined &&
    text(item.code) &&
    text(item.what) &&
    text(item.why) &&
    text(item.systemAction) &&
    typeof item.needsHuman === "boolean" &&
    (item.until === null || finite(item.until))
  );
}

function fillOk(value: unknown, first: string, second: string): boolean {
  if (value === null) return true;
  const item = record(value);
  return item !== undefined && finite(item[first]) && finite(item[second]);
}

function workflowOk(value: unknown): boolean {
  const row = record(value);
  return (
    row !== undefined &&
    text(row.id) &&
    text(row.projectSlug) &&
    text(row.goal) &&
    WORKFLOW_STATES.has(String(row.state)) &&
    textOrNull(row.stopReason) &&
    explanationOk(row.explanation) &&
    finite(row.startedAt) &&
    finite(row.elapsedMs) &&
    finite(row.tokensUsed) &&
    (row.tokensBudget === null || finite(row.tokensBudget)) &&
    finite(row.agentsCreated) &&
    finite(row.agentsCap) &&
    finite(row.closedTasks) &&
    finite(row.totalTasks) &&
    fillOk(row.criteria, "passed", "total")
  );
}

function taskOk(value: unknown): boolean {
  const row = record(value);
  return (
    row !== undefined &&
    text(row.id) &&
    text(row.workflowId) &&
    text(row.title) &&
    text(row.state) &&
    COLUMNS.has(String(row.column)) &&
    text(row.role) &&
    text(row.agent) &&
    textOrNull(row.delegatedBy) &&
    textOrNull(row.returnedTo) &&
    textOrNull(row.model) &&
    finite(row.attempts) &&
    (row.maxAttempts === null || finite(row.maxAttempts)) &&
    fillOk(row.context, "used", "threshold") &&
    finite(row.tokens) &&
    fillOk(row.criteria, "passed", "total") &&
    explanationOk(row.explanation) &&
    (row.closedAt === null || finite(row.closedAt)) &&
    finite(row.updatedAt)
  );
}

function agentOk(value: unknown): boolean {
  const row = record(value);
  return (
    row !== undefined &&
    text(row.workflowId) &&
    text(row.code) &&
    text(row.role) &&
    text(row.status) &&
    text(row.taskId) &&
    text(row.task) &&
    textOrNull(row.model) &&
    finite(row.tokens) &&
    (row.elapsedMs === null || finite(row.elapsedMs)) &&
    fillOk(row.context, "used", "threshold") &&
    textOrNull(row.parent) &&
    finite(row.depth) &&
    allOk(row.waitingFor, text)
  );
}

function eventOk(value: unknown): boolean {
  const row = record(value);
  return (
    row !== undefined &&
    finite(row.at) &&
    text(row.type) &&
    text(row.text) &&
    textOrNull(row.workflowId) &&
    textOrNull(row.agent)
  );
}

function requestOk(value: unknown): boolean {
  const row = record(value);
  return (
    row !== undefined &&
    REQUEST_KINDS.has(String(row.kind)) &&
    text(row.id) &&
    textOrNull(row.workflowId) &&
    text(row.projectSlug) &&
    text(row.title) &&
    explanationOk(row.explanation) &&
    finite(row.at)
  );
}

function edgeOk(value: unknown): boolean {
  const row = record(value);
  return row !== undefined && text(row.workflowId) && text(row.parent) && text(row.child);
}

function handoffOk(value: unknown): boolean {
  const row = record(value);
  return (
    row !== undefined &&
    finite(row.at) &&
    text(row.workflowId) &&
    textOrNull(row.agent) &&
    (row.kind === "model" || row.kind === "agent") &&
    text(row.from) &&
    text(row.to)
  );
}

function readingOk(value: unknown): boolean {
  const row = record(value);
  return (
    row !== undefined &&
    (row.pct === null || finite(row.pct)) &&
    (row.resetsAt === null || finite(row.resetsAt)) &&
    QUOTA_SOURCES.has(String(row.source)) &&
    (row.readAt === null || finite(row.readAt)) &&
    typeof row.stale === "boolean" &&
    textOrNull(row.state) &&
    (row.estimatedTokens === null || finite(row.estimatedTokens))
  );
}

function groupOk(value: unknown): boolean {
  const row = record(value);
  return (
    row !== undefined &&
    textOrNull(row.name) &&
    allOk(row.models, text) &&
    text(row.state) &&
    readingOk(row.window5h) &&
    readingOk(row.weekly)
  );
}

function accountOk(value: unknown): boolean {
  const row = record(value);
  return (
    row !== undefined &&
    text(row.id) &&
    text(row.provider) &&
    text(row.label) &&
    textOrNull(row.kind) &&
    textOrNull(row.plan) &&
    text(row.state) &&
    allOk(row.groups, groupOk) &&
    finite(row.successes) &&
    finite(row.failures) &&
    allOk(row.holders, text) &&
    (row.cachedTokens === null || finite(row.cachedTokens)) &&
    finite(row.inputTokens) &&
    (row.readAt === null || finite(row.readAt))
  );
}

function quotaOk(value: unknown): boolean {
  const row = record(value);
  const limits = record(row?.thresholds);
  return (
    row !== undefined &&
    limits !== undefined &&
    allOk(row.accounts, accountOk) &&
    allOk(row.unread, (item) => {
      const unread = record(item);
      return unread !== undefined && text(unread.provider) && text(unread.state);
    }) &&
    finite(limits.switchAt5h) &&
    finite(limits.stopAtWeekly) &&
    finite(limits.warnPct) &&
    finite(limits.dangerPct) &&
    allOk(row.history, (item) => {
      const series = record(item);
      return (
        series !== undefined &&
        text(series.key) &&
        text(series.label) &&
        allOk(series.points, (point) => {
          const at = record(point);
          return at !== undefined && finite(at.at) && finite(at.pct);
        })
      );
    })
  );
}

function healthOk(value: unknown): boolean {
  const row = record(value);
  return (
    row !== undefined &&
    (row.state === "ok" || row.state === "down" || row.state === "unknown") &&
    text(row.detail)
  );
}

function systemOk(value: unknown): boolean {
  const row = record(value);
  return (
    row !== undefined &&
    healthOk(row.runtime) &&
    healthOk(row.gateway) &&
    healthOk(row.store) &&
    finite(row.accounts) &&
    allOk(row.roleWarnings, (item) => {
      const warning = record(item);
      return warning !== undefined && text(warning.role) && text(warning.vendor);
    })
  );
}

function allOk(value: unknown, check: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(check);
}

// A line of haril factory watch (or show --json), checked field by field; undefined for anything else.
export function parseFactoryLine(line: string): FactoryModel | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  const model = record(value);
  if (
    model === undefined ||
    model.schemaVersion !== 1 ||
    !finite(model.generatedAt) ||
    !textOrNull(model.project) ||
    !allOk(model.workflows, workflowOk) ||
    !allOk(model.tasks, taskOk) ||
    !allOk(model.agents, agentOk) ||
    !allOk(model.edges, edgeOk) ||
    !allOk(model.events, eventOk) ||
    !allOk(model.humanRequests, requestOk) ||
    !allOk(model.handoffs, handoffOk) ||
    !quotaOk(model.quota) ||
    !systemOk(model.system)
  ) {
    return undefined;
  }
  return model as unknown as FactoryModel;
}

export interface FactoryFeedHost {
  cwd(): string | undefined;
  projectSlug(): string | undefined;
  onModel(model: FactoryModel): void;
  // The child kept dying, or could not start: the data stopped.
  onEnded(): void;
}

export interface FactoryFeed {
  // Ends the child; the feed does nothing after this.
  close(): void;
}

// Starts following at once.
export function startFactoryFeed(
  host: FactoryFeedHost,
  stream: typeof streamHaril = streamHaril,
  retryDelays: readonly number[] = RETRY_DELAYS_MS,
): FactoryFeed {
  let closed = false;
  let child: HarilStream | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let generation = 0;

  const start = (): void => {
    const own = ++generation;
    const slug = host.projectSlug();
    const opened = stream(
      [
        "factory",
        "watch",
        "--json",
        ...(slug === undefined ? [] : ["--project", slug]),
        EXIT_WITH_CONSOLE,
      ],
      {
        cwd: host.cwd(),
        onLine: (line) => {
          if (closed || own !== generation) return;
          const model = parseFactoryLine(line);
          if (model === undefined) return;
          attempt = 0;
          host.onModel(model);
        },
        onExit: () => {
          if (closed || own !== generation) return;
          const delay = retryDelays[attempt];
          if (delay === undefined) {
            host.onEnded();
            return;
          }
          attempt += 1;
          retry = setTimeout(() => {
            retry = undefined;
            if (!closed) start();
          }, delay);
        },
      },
    );
    if (opened === undefined) {
      host.onEnded();
      return;
    }
    child = opened;
  };

  start();
  return {
    close() {
      if (closed) return;
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      child?.close();
      child = undefined;
    },
  };
}
