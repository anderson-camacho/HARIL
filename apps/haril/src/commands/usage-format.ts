import { visibleText } from "@haril/core";
import type {
  ChainReport,
  OrderRecord,
  UsageDifficulty,
  UsageRecord,
  UsageSummaryRow,
} from "@haril/core/ports";

// Parsing and formatting for `haril usage` (docs/modos-y-delegacion.md 4.5): time bounds, one log line per row in the
// style of `haril events` (seq time type aggregate:id key=value ...), the summary table and CSV.

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export const DIFFICULTIES: readonly UsageDifficulty[] = [
  "trivial",
  "easy",
  "medium",
  "hard",
  "expert",
];

// "90s", "15m", "2h", "7d" or "1w", or null.
export function parseDuration(text: string): number | null {
  const match = /^(\d{1,9})([smhdw])$/.exec(text.trim());
  if (match === null) return null;
  return Number(match[1]) * (UNIT_MS[match[2] as string] as number);
}

// An ISO 8601 date or time (a date alone is midnight UTC), or epoch milliseconds; null when neither.
export function parseInstant(text: string): number | null {
  const trimmed = text.trim();
  if (/^\d{1,16}$/.test(trimmed)) return Number(trimmed);
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
  const value = Date.parse(trimmed);
  return Number.isNaN(value) ? null : value;
}

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

function pairs(fields: readonly [string, string | number | null | undefined][]): string {
  return fields
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function tokens(value: number | null): string {
  return value === null ? "unreported" : String(value);
}

export function orderLine(row: OrderRecord): string {
  const head = `${row.seq} ${iso(row.ts)} order.${row.source} order:${row.orderId}`;
  const rest = pairs([
    ["mode", row.mode],
    ["chars", row.textChars],
    ["session", row.sessionId],
    ["workflow", row.workflowId],
    ["preview", row.preview === null ? null : JSON.stringify(row.preview)],
  ]);
  return visibleText(`${head} ${rest}`);
}

export function usageLine(row: UsageRecord): string {
  const aggregate = row.runId !== null ? `run:${row.runId}` : `usage:${row.usageId}`;
  const head = `${row.seq} ${iso(row.ts)} usage.${row.kind} ${aggregate}`;
  const rest = pairs([
    ["role", row.role],
    ["layer", row.layer],
    ["mode", row.kind === "chat" ? row.mode : null],
    ["model", row.modelServed ?? row.modelRequested],
    ["pinned", row.modelPinned ? "yes" : null],
    ["difficulty", row.difficultyEst],
    ["tokensIn", tokens(row.tokensIn)],
    ["tokensOut", tokens(row.tokensOut)],
    ["durationMs", row.durationMs],
    ["outcome", row.outcome],
    ["verdict", row.auditVerdict],
    ["retries", row.retries],
    ["workflow", row.workflowId],
    ["session", row.sessionId],
    ["order", row.orderId],
    ["simulated", row.simulated ? "yes" : null],
  ]);
  return visibleText(`${head} ${rest}`);
}

function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

const SUMMARY_HEADER = [
  "key",
  "rows",
  "tokens in",
  "tokens out",
  "unreported in/out",
  "time",
  "retries",
  "approved",
  "rejected",
];

// A plain table: the groups, then the total.
export function summaryLines(
  by: string,
  rows: readonly UsageSummaryRow[],
  orders: number,
): string[] {
  const total = rows.reduce(
    (sum, row) => ({
      rows: sum.rows + row.rows,
      tokensIn: sum.tokensIn + row.tokensIn,
      tokensOut: sum.tokensOut + row.tokensOut,
      inUnreported: sum.inUnreported + row.tokensInUnreported,
      outUnreported: sum.outUnreported + row.tokensOutUnreported,
      durationMs: sum.durationMs + row.durationMs,
      retries: sum.retries + row.retries,
      approved: sum.approved + row.approved,
      rejected: sum.rejected + row.rejected,
    }),
    {
      rows: 0,
      tokensIn: 0,
      tokensOut: 0,
      inUnreported: 0,
      outUnreported: 0,
      durationMs: 0,
      retries: 0,
      approved: 0,
      rejected: 0,
    },
  );
  const cells = (key: string, row: typeof total) => [
    key,
    String(row.rows),
    String(row.tokensIn),
    String(row.tokensOut),
    `${row.inUnreported}/${row.outUnreported}`,
    clock(row.durationMs),
    String(row.retries),
    String(row.approved),
    String(row.rejected),
  ];
  const table = [
    SUMMARY_HEADER,
    ...rows.map((row) =>
      cells(visibleText(row.key ?? "(none)"), {
        rows: row.rows,
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
        inUnreported: row.tokensInUnreported,
        outUnreported: row.tokensOutUnreported,
        durationMs: row.durationMs,
        retries: row.retries,
        approved: row.approved,
        rejected: row.rejected,
      }),
    ),
    cells("total", total),
  ];
  const widths = SUMMARY_HEADER.map((_, column) =>
    Math.max(...table.map((line) => Array.from(line[column] ?? "").length)),
  );
  const render = (line: readonly string[]) =>
    line
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
      )
      .join("  ")
      .trimEnd();
  return [`usage by ${by}`, ...table.map(render), `orders: ${orders}`];
}

const BREAK_TEXT: Readonly<Record<string, string>> = {
  hash_mismatch: "the row was changed after it was written",
  prev_hash_mismatch: "the row before it was deleted or replaced",
  sequence_gap: "a row before it was deleted",
  head_mismatch: "the newest rows were deleted",
};

export function chainLine(report: ChainReport): string {
  const rows = `${report.rows} ${report.rows === 1 ? "row" : "rows"}`;
  if (report.firstBroken === null) return `${report.table}: ${rows}, chain ok`;
  const { seq, reason } = report.firstBroken;
  return `${report.table}: ${rows}, chain broken at seq ${seq} (${reason}: ${BREAK_TEXT[reason] ?? reason})`;
}

// A spreadsheet runs a text cell that starts with =, +, -, @, a tab or a carriage return as a formula (CSV injection),
// so such a cell starts with an apostrophe, which spreadsheets show as text. Text is always quoted.
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${text.replace(/"/g, '""')}"`;
}

// Header from the record's keys, then one line per row; text is quoted, null is an empty cell.
export function csvLines(
  rows: readonly Record<string, unknown>[],
  keys: readonly string[],
): string[] {
  return [keys.join(","), ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(","))];
}
