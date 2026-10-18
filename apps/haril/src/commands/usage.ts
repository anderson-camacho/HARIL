import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  OrderFilter,
  OrderMode,
  OrderRecord,
  Store,
  UsageDifficulty,
  UsageFilter,
  UsageGroupBy,
  UsageKind,
  UsageRecord,
} from "@haril/core/ports";
import { argsProblem, lastValue, type ParsedArgs, parseArgs } from "../args.js";
import { type CliIo, EXIT_INVALID, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { clockFor } from "../host.js";
import { dataDirFor, openExisting } from "./common.js";
import {
  chainLine,
  csvLines,
  DIFFICULTIES,
  orderLine,
  parseDuration,
  parseInstant,
  summaryLines,
  usageLine,
} from "./usage-format.js";

// `haril usage log|summary|verify|export` (docs/modos-y-delegacion.md 4.5 and 6, R-L1): read-only views of the orders
// and usage logs. A missing database is never created. Time bounds apply to the time a row was written: --since is
// measured back from now, --from is inclusive and --to (or --before) exclusive.

const USAGE = [
  "usage: haril usage log|summary|verify|export",
  "  haril usage log [--since 2h | --from <time> --to <time>] [--kind order|chat|agent_run] [--model <id>] [--workflow <id>]",
  "    [--layer 1|2|3] [--mode <mode>] [--difficulty <class>] [--limit <n>] [--json] [--data-dir <path>]",
  "  haril usage summary [--by day|model|layer|difficulty|workflow|mode|role] [--since ... | --from ... --to ...] [--json]",
  "  haril usage verify [--json]          walk both hash chains; exit 1 when a row was changed or deleted",
  "  haril usage export --format jsonl|csv [--table usage|orders] [--since ... | --from ... --to ... | --before <time>]",
  "    [--out <file>]   a time is an ISO 8601 date or time, or epoch milliseconds",
].join("\n");
const NOT_INITIALIZED =
  "store not initialized (run haril project init <path> --name <name> --yes first)";

const MODES: readonly OrderMode[] = ["accion", "consulta", "plan", "delegacion", "cli"];
const KINDS = ["order", "chat", "agent_run"] as const;
const GROUPS: readonly UsageGroupBy[] = [
  "day",
  "model",
  "layer",
  "difficulty",
  "workflow",
  "mode",
  "role",
];
const TIME_VALUES = ["--since", "--from", "--to", "--before"];

const ORDER_KEYS: readonly (keyof OrderRecord)[] = [
  "seq",
  "orderId",
  "ts",
  "sessionId",
  "mode",
  "source",
  "workflowId",
  "projectId",
  "textSha256",
  "textChars",
  "preview",
  "idempotencyKey",
  "prevHash",
  "hash",
];

const USAGE_KEYS: readonly (keyof UsageRecord)[] = [
  "seq",
  "usageId",
  "ts",
  "orderId",
  "kind",
  "sessionId",
  "projectId",
  "workflowId",
  "taskId",
  "runId",
  "threadId",
  "layer",
  "role",
  "mode",
  "provider",
  "modelRequested",
  "modelServed",
  "modelPinned",
  "tokensIn",
  "tokensOut",
  "tokensCached",
  "tokensReasoning",
  "costMicros",
  "unreconciled",
  "startedAt",
  "endedAt",
  "durationMs",
  "difficultyEst",
  "difficultyReason",
  "outcome",
  "auditVerdict",
  "retries",
  "simulated",
  "idempotencyKey",
  "prevHash",
  "hash",
];

type Problem = { readonly problem: string };

function isProblem(value: unknown): value is Problem {
  return typeof value === "object" && value !== null && "problem" in value;
}

interface TimeRange {
  readonly from?: number;
  readonly to?: number;
}

function timeRange(parsed: ParsedArgs, host: HostInfo): TimeRange | Problem {
  const since = lastValue(parsed, "--since");
  const fromText = lastValue(parsed, "--from");
  const toText = lastValue(parsed, "--to") ?? lastValue(parsed, "--before");
  if (since !== undefined && (fromText !== undefined || toText !== undefined)) {
    return { problem: "give either --since or --from/--to, not both" };
  }
  if (since !== undefined) {
    const duration = parseDuration(since);
    if (duration === null) {
      return { problem: `--since takes a duration such as 90s, 15m, 2h, 7d or 1w; got "${since}"` };
    }
    return { from: clockFor(host).now() - duration };
  }
  const range: { from?: number; to?: number } = {};
  for (const [name, text] of [
    ["--from", fromText],
    ["--to", toText],
  ] as const) {
    if (text === undefined) continue;
    const value = parseInstant(text);
    if (value === null) {
      return {
        problem: `${name} takes an ISO 8601 date or time, or epoch milliseconds; got "${text}"`,
      };
    }
    if (name === "--from") range.from = value;
    else range.to = value;
  }
  return range;
}

interface LogFilters {
  readonly kind: (typeof KINDS)[number] | undefined;
  readonly usage: UsageFilter;
  readonly orders: OrderFilter;
  // A filter only usage rows have (model, layer, difficulty, or a usage kind): orders are left out.
  readonly usageOnly: boolean;
  readonly limit: number | undefined;
}

function logFilters(parsed: ParsedArgs, host: HostInfo): LogFilters | Problem {
  const range = timeRange(parsed, host);
  if (isProblem(range)) return range;
  const kind = lastValue(parsed, "--kind");
  if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) {
    return { problem: `--kind is one of ${KINDS.join(", ")}; got "${kind}"` };
  }
  const mode = lastValue(parsed, "--mode");
  if (mode !== undefined && !(MODES as readonly string[]).includes(mode)) {
    return { problem: `--mode is one of ${MODES.join(", ")}; got "${mode}"` };
  }
  const difficulty = lastValue(parsed, "--difficulty");
  if (difficulty !== undefined && !(DIFFICULTIES as readonly string[]).includes(difficulty)) {
    return { problem: `--difficulty is one of ${DIFFICULTIES.join(", ")}; got "${difficulty}"` };
  }
  const layerText = lastValue(parsed, "--layer");
  const layer = layerText === undefined ? undefined : Number(layerText);
  if (layer !== undefined && ![1, 2, 3].includes(layer)) {
    return { problem: `--layer is 1, 2 or 3; got "${layerText}"` };
  }
  const limitText = lastValue(parsed, "--limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    return { problem: "--limit must be a whole number of at least 1" };
  }
  const model = lastValue(parsed, "--model");
  const workflowId = lastValue(parsed, "--workflow");
  return {
    kind: kind as LogFilters["kind"],
    usage: {
      ...range,
      kind: kind === "chat" || kind === "agent_run" ? (kind as UsageKind) : undefined,
      model,
      workflowId,
      layer,
      mode: mode as OrderMode | undefined,
      difficulty: difficulty as UsageDifficulty | undefined,
      limit,
    },
    orders: { ...range, mode: mode as OrderMode | undefined, workflowId, limit },
    usageOnly:
      model !== undefined ||
      layer !== undefined ||
      difficulty !== undefined ||
      kind === "chat" ||
      kind === "agent_run",
    limit,
  };
}

type Merged =
  | { readonly table: "orders"; readonly row: OrderRecord }
  | { readonly table: "usage_log"; readonly row: UsageRecord };

// Orders and usage rows in the order they were written: by time, an order before the usage rows it caused.
function mergedRows(store: Store, filters: LogFilters): Merged[] {
  const orders: Merged[] = filters.usageOnly
    ? []
    : store.usageLog.orders(filters.orders).map((row) => ({ table: "orders", row }));
  const usage: Merged[] =
    filters.kind === "order"
      ? []
      : store.usageLog.usage(filters.usage).map((row) => ({ table: "usage_log", row }));
  const all = [...orders, ...usage].sort(
    (a, b) =>
      a.row.ts - b.row.ts ||
      (a.table === b.table ? a.row.seq - b.row.seq : a.table === "orders" ? -1 : 1),
  );
  return filters.limit === undefined ? all : all.slice(-filters.limit);
}

function withStore(
  io: CliIo,
  host: HostInfo,
  parsed: ParsedArgs,
  work: (store: Store) => number,
): number {
  const store = openExisting(host, dataDirFor(host, lastValue(parsed, "--data-dir")));
  if (store === undefined) {
    io.err(`haril: ${NOT_INITIALIZED}`);
    return EXIT_USAGE;
  }
  try {
    return work(store);
  } finally {
    store.close();
  }
}

function fail(io: CliIo, problem: string): number {
  io.err(`haril: ${problem}`);
  return EXIT_USAGE;
}

function log(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: [
      "--since",
      "--from",
      "--to",
      "--kind",
      "--model",
      "--workflow",
      "--layer",
      "--mode",
      "--difficulty",
      "--limit",
      "--data-dir",
    ],
    flags: ["--json"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) return fail(io, USAGE);
  const filters = logFilters(parsed, host);
  if (isProblem(filters)) return fail(io, filters.problem);
  return withStore(io, host, parsed, (store) => {
    const rows = mergedRows(store, filters);
    if (parsed.flags.has("--json")) {
      io.out(JSON.stringify(rows.map((item) => ({ table: item.table, ...item.row }))));
    } else {
      for (const item of rows)
        io.out(item.table === "orders" ? orderLine(item.row) : usageLine(item.row));
    }
    return EXIT_OK;
  });
}

function summary(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: ["--by", "--since", "--from", "--to", "--kind", "--data-dir"],
    flags: ["--json"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) return fail(io, USAGE);
  const by = (lastValue(parsed, "--by") ?? "model") as UsageGroupBy;
  if (!GROUPS.includes(by)) return fail(io, `--by is one of ${GROUPS.join(", ")}; got "${by}"`);
  const range = timeRange(parsed, host);
  if (isProblem(range)) return fail(io, range.problem);
  const kind = lastValue(parsed, "--kind");
  if (kind !== undefined && kind !== "chat" && kind !== "agent_run") {
    return fail(io, `--kind is chat or agent_run; got "${kind}"`);
  }
  return withStore(io, host, parsed, (store) => {
    const rows = store.usageLog.summary(by, { ...range, kind: kind as UsageKind | undefined });
    const orders = store.usageLog.orders(range).length;
    if (parsed.flags.has("--json")) io.out(JSON.stringify({ by, rows, orders }));
    else for (const line of summaryLines(by, rows, orders)) io.out(line);
    return EXIT_OK;
  });
}

function verify(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) return fail(io, USAGE);
  return withStore(io, host, parsed, (store) => {
    const report = store.usageLog.verify();
    if (parsed.flags.has("--json")) io.out(JSON.stringify(report));
    else {
      io.out(chainLine(report.orders));
      io.out(chainLine(report.usage));
    }
    return report.ok ? EXIT_OK : EXIT_INVALID;
  });
}

function exportRows(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: ["--format", "--table", "--out", ...TIME_VALUES, "--data-dir"],
    flags: [],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) return fail(io, USAGE);
  const format = lastValue(parsed, "--format");
  if (format !== "jsonl" && format !== "csv") return fail(io, "--format is jsonl or csv");
  const table = lastValue(parsed, "--table") ?? "usage";
  if (table !== "usage" && table !== "orders") return fail(io, "--table is usage or orders");
  const range = timeRange(parsed, host);
  if (isProblem(range)) return fail(io, range.problem);
  return withStore(io, host, parsed, (store) => {
    const rows: Record<string, unknown>[] =
      table === "orders"
        ? store.usageLog.orders(range).map((row) => ({ ...row }))
        : store.usageLog.usage(range).map((row) => ({ ...row }));
    const keys: readonly string[] = table === "orders" ? ORDER_KEYS : USAGE_KEYS;
    const lines =
      format === "jsonl" ? rows.map((row) => JSON.stringify(row)) : csvLines(rows, keys);
    const out = lastValue(parsed, "--out");
    if (out === undefined) {
      for (const line of lines) io.out(line);
      return EXIT_OK;
    }
    const path = resolve(host.cwd ?? process.cwd(), out);
    try {
      writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return fail(
        io,
        code === "EEXIST"
          ? `${path} already exists; choose another --out`
          : `cannot write ${path}: ${code ?? "error"}`,
      );
    }
    io.out(`${rows.length} ${rows.length === 1 ? "row" : "rows"} written to ${path}`);
    return EXIT_OK;
  });
}

export function usage(args: readonly string[], io: CliIo, host: HostInfo): number {
  const [sub, ...rest] = args;
  if (sub === "log") return log(rest, io, host);
  if (sub === "summary") return summary(rest, io, host);
  if (sub === "verify") return verify(rest, io, host);
  if (sub === "export") return exportRows(rest, io, host);
  io.err(USAGE);
  return EXIT_USAGE;
}
