import { orderPreview } from "@haril/core";
import type { AppendOrderInput, AppendUsageInput, OrderMode, Store } from "@haril/core/ports";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { dataDirFor, openExisting } from "./common.js";

// `haril usage record --stdin` (docs/modos-y-delegacion.md 4.5, P14, P15): how the console logs its chat. Each call
// appends one row, read as one JSON object from stdin so the order's text never travels in argv: an order (the user's
// prompt or command) or a chat usage row (one assistant message, its model, tokens and duration). The row is checked
// field by field before it reaches the store: a closed set of fields, the closed vocabularies of the log, whole
// non-negative token counts or null (not reported, never 0), and identifiers that are plain printable ASCII the
// redaction would leave unchanged, so no credential-shaped value lands in a row. An order keeps the SHA-256 and the
// length of its text and a redacted preview of at most 200 characters, never the text. P14: the append needs no runtime
// lease, since both logs are append-only and depend on no task state; it is the one write outside the runtime.

const USAGE = "usage: haril usage record --stdin [--project <slug>] [--json] [--data-dir <path>]";
const NOT_INITIALIZED =
  "store not initialized (run haril project init <path> --name <name> --yes first)";
const MODES: readonly OrderMode[] = ["accion", "consulta", "plan", "delegacion", "cli"];
const ORDER_SOURCES = ["chat", "cli"] as const;
// Larger input is refused before it is parsed.
const MAX_INPUT_CHARS = 2_000_000;
const MAX_TEXT_CHARS = 1_000_000;
const MAX_ID_CHARS = 256;
const MAX_OUTCOME_CHARS = 64;
// Plain printable ASCII without spaces: model ids, provider ids, session ids, idempotency keys.
const IDENTIFIER = /^[!-~]+$/;

const ORDER_FIELDS = new Set([
  "kind",
  "mode",
  "source",
  "text",
  "sessionId",
  "workflowId",
  "idempotencyKey",
]);
const ORDER_IDS = ["sessionId", "workflowId", "idempotencyKey"] as const;

const USAGE_FIELDS = new Set([
  "kind",
  "mode",
  "orderId",
  "sessionId",
  "workflowId",
  "provider",
  "modelRequested",
  "modelServed",
  "tokensIn",
  "tokensOut",
  "tokensCached",
  "tokensReasoning",
  "costMicros",
  "startedAt",
  "endedAt",
  "durationMs",
  "outcome",
  "idempotencyKey",
]);
const USAGE_IDS = [
  "orderId",
  "sessionId",
  "workflowId",
  "provider",
  "modelRequested",
  "modelServed",
  "idempotencyKey",
] as const;
const REQUIRED_COUNTS = ["tokensIn", "tokensOut"] as const;
const OPTIONAL_COUNTS = [
  "tokensCached",
  "tokensReasoning",
  "costMicros",
  "startedAt",
  "endedAt",
  "durationMs",
] as const;

type OrderRow = Omit<AppendOrderInput, "projectId" | "preview">;
type UsageRow = Omit<AppendUsageInput, "projectId">;
type Parsed =
  | { readonly order: OrderRow }
  | { readonly usage: UsageRow }
  | { readonly problem: string };

function fail(io: CliIo, problem: string): number {
  io.err(`haril: ${problem}`);
  return EXIT_USAGE;
}

function identifier(
  row: Record<string, unknown>,
  field: string,
): string | null | { problem: string } {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_CHARS) {
    return { problem: `${field} must be a string of 1 to ${MAX_ID_CHARS} characters or null` };
  }
  // The redaction would change a value that looks like a key or a token: such a value never lands in a row.
  if (!IDENTIFIER.test(value) || orderPreview(value) !== value) {
    return {
      problem: `${field} must be a plain identifier (printable ASCII, no spaces, nothing that looks like a credential)`,
    };
  }
  return value;
}

function count(row: Record<string, unknown>, field: string): number | null | { problem: string } {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return { problem: `${field} must be a whole number of at least 0, or null when not reported` };
  }
  return value;
}

function isProblem(value: unknown): value is { problem: string } {
  return typeof value === "object" && value !== null && "problem" in value;
}

function unknownField(
  row: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.keys(row).find((key) => !allowed.has(key));
}

function parseOrder(row: Record<string, unknown>, mode: OrderMode): Parsed {
  const extra = unknownField(row, ORDER_FIELDS);
  if (extra !== undefined) return { problem: `an order row has no field "${extra}"` };
  const source = row.source ?? "chat";
  if (!(ORDER_SOURCES as readonly unknown[]).includes(source)) {
    return { problem: `an order's source is one of ${ORDER_SOURCES.join(", ")}` };
  }
  const text = row.text;
  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT_CHARS) {
    return {
      problem: `an order needs its text: a non-empty string of at most ${MAX_TEXT_CHARS} characters`,
    };
  }
  const ids: Record<string, string | null> = {};
  for (const field of ORDER_IDS) {
    const value = identifier(row, field);
    if (isProblem(value)) return value;
    ids[field] = value;
  }
  return {
    order: {
      mode,
      source: source as (typeof ORDER_SOURCES)[number],
      text,
      sessionId: ids.sessionId ?? null,
      workflowId: ids.workflowId ?? null,
      idempotencyKey: ids.idempotencyKey ?? null,
    },
  };
}

function parseUsage(row: Record<string, unknown>, mode: OrderMode): Parsed {
  const extra = unknownField(row, USAGE_FIELDS);
  if (extra !== undefined) return { problem: `a chat usage row has no field "${extra}"` };
  for (const field of REQUIRED_COUNTS) {
    if (!(field in row))
      return { problem: `a chat usage row needs ${field} (null when not reported)` };
  }
  const ids: Record<string, string | null> = {};
  for (const field of USAGE_IDS) {
    const value = identifier(row, field);
    if (isProblem(value)) return value;
    ids[field] = value;
  }
  const counts: Record<string, number | null> = {};
  for (const field of [...REQUIRED_COUNTS, ...OPTIONAL_COUNTS]) {
    const value = count(row, field);
    if (isProblem(value)) return value;
    counts[field] = value;
  }
  const outcome = row.outcome;
  if (
    outcome !== undefined &&
    outcome !== null &&
    (typeof outcome !== "string" ||
      outcome.length === 0 ||
      outcome.length > MAX_OUTCOME_CHARS ||
      !IDENTIFIER.test(outcome))
  ) {
    return {
      problem: `outcome must be a word of at most ${MAX_OUTCOME_CHARS} characters, or null`,
    };
  }
  return {
    usage: {
      kind: "chat",
      mode,
      orderId: ids.orderId ?? null,
      sessionId: ids.sessionId ?? null,
      workflowId: ids.workflowId ?? null,
      provider: ids.provider ?? null,
      modelRequested: ids.modelRequested ?? null,
      modelServed: ids.modelServed ?? null,
      tokensIn: counts.tokensIn ?? null,
      tokensOut: counts.tokensOut ?? null,
      tokensCached: counts.tokensCached ?? null,
      tokensReasoning: counts.tokensReasoning ?? null,
      costMicros: counts.costMicros ?? null,
      startedAt: counts.startedAt ?? null,
      endedAt: counts.endedAt ?? null,
      durationMs: counts.durationMs ?? null,
      outcome: typeof outcome === "string" ? outcome : null,
      idempotencyKey: ids.idempotencyKey ?? null,
    },
  };
}

// The row on stdin, checked.
function parseRecordInput(input: string): Parsed {
  if (input.length > MAX_INPUT_CHARS) {
    return { problem: `the row on stdin is larger than ${MAX_INPUT_CHARS} characters` };
  }
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return { problem: "stdin must hold one JSON object (an order or a chat usage row)" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { problem: "stdin must hold one JSON object (an order or a chat usage row)" };
  }
  const row = value as Record<string, unknown>;
  const mode = row.mode;
  if (!(MODES as readonly unknown[]).includes(mode)) {
    return { problem: `mode is one of ${MODES.join(", ")}` };
  }
  if (row.kind === "order") return parseOrder(row, mode as OrderMode);
  if (row.kind === "chat") return parseUsage(row, mode as OrderMode);
  // agent_run rows belong to the runtime, which writes them when an attempt closes.
  return { problem: 'kind is "order" or "chat" (the runtime writes the agent_run rows)' };
}

function projectIdOf(store: Store, slug: string | undefined): string | null | { problem: string } {
  if (slug === undefined) return null;
  const project = store.projects.getBySlug(slug);
  return project === undefined ? { problem: `no project with slug "${slug}"` } : project.projectId;
}

export function usageRecord(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: ["--project", "--data-dir"],
    flags: ["--stdin", "--json"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) return fail(io, USAGE);
  if (!parsed.flags.has("--stdin")) {
    return fail(io, `the row is read from stdin, never from argv: pass --stdin\n${USAGE}`);
  }
  const store = openExisting(host, dataDirFor(host, lastValue(parsed, "--data-dir")));
  if (store === undefined) return fail(io, NOT_INITIALIZED);
  try {
    let input: string;
    try {
      input = (host.readStdin ?? (() => ""))();
    } catch (error) {
      return fail(
        io,
        `could not read stdin: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const row = parseRecordInput(input);
    if ("problem" in row) return fail(io, row.problem);
    const projectId = projectIdOf(store, lastValue(parsed, "--project"));
    if (isProblem(projectId)) return fail(io, projectId.problem);
    const json = parsed.flags.has("--json");
    if ("order" in row) {
      const result = store.usageLog.appendOrder({
        ...row.order,
        preview: orderPreview(row.order.text),
        projectId,
      });
      const id = result.record.orderId;
      if (json) io.out(JSON.stringify({ table: "orders", id, created: result.created }));
      else io.out(`order ${id} ${result.created ? "recorded" : "already recorded (same key)"}`);
      return EXIT_OK;
    }
    const result = store.usageLog.appendUsage({ ...row.usage, projectId });
    const id = result.record.usageId;
    if (json) io.out(JSON.stringify({ table: "usage_log", id, created: result.created }));
    else io.out(`usage ${id} ${result.created ? "recorded" : "already recorded (same key)"}`);
    return EXIT_OK;
  } finally {
    store.close();
  }
}
