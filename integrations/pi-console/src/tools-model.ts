import { plainText } from "./text.js";

// What `haril tools status|ensure|update --json` and `haril memory status --json` print, read defensively. The console
// imports no workspace package, so these shapes are repeated here for the fields the MEM tab uses; anything that is not
// what it expects is dropped, and every text that reaches the panel went through plainText first (a path, a message or
// a provider name comes from outside HARIL's own code).

export type ToolState = "ok" | "outdated" | "missing" | "unknown";
type ToolId = "engram" | "gentle-ai";

export interface InstallView {
  readonly path: string;
  // null: the version could not be read.
  readonly version: string | null;
  readonly origins: readonly string[];
  readonly active: boolean;
}

export interface ToolView {
  readonly id: ToolId;
  readonly state: ToolState;
  readonly active: InstallView | undefined;
  // The installs that are not the active one.
  readonly others: readonly InstallView[];
  readonly latest: string | null;
  readonly qualified: string | null;
  readonly newerUpstream: boolean;
  readonly notes: readonly string[];
}

export interface InstallFailureView {
  readonly failedAt: string;
  readonly message: string;
  // null once a new attempt is allowed.
  readonly retryAt: string | null;
}

// The memory provider haril.json sets, which `haril memory status` does not tell before the runtime has run. null: the
// file says nothing usable (no memory section, or one that cannot be read).
export interface MemoryConfigView {
  readonly provider: "null" | "engram" | null;
  readonly binary: string | undefined;
}

export interface ToolsStatusView {
  readonly engram: ToolView | undefined;
  readonly gentleAi: ToolView | undefined;
  readonly failure: InstallFailureView | undefined;
  // undefined: the report does not say (an older haril).
  readonly memoryConfig: MemoryConfigView | undefined;
}

type EnsureAction = "none" | "installed" | "updated" | "skipped" | "busy" | "failed";
type UpdateAction = "installed" | "updated" | "none" | "aborted" | "failed";

export interface EnsureView {
  readonly action: EnsureAction;
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly message: string | undefined;
  readonly notes: readonly string[];
  readonly status: ToolsStatusView | undefined;
}

export interface UpdateView {
  readonly action: UpdateAction;
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly path: string | undefined;
  readonly message: string | undefined;
  readonly warnings: readonly string[];
  readonly status: ToolsStatusView | undefined;
}

export interface MemoryView {
  readonly initialized: boolean;
  readonly running: boolean;
  readonly provider: string;
  readonly persistent: boolean | null;
  // "not_checked", or the state the runtime recorded ("active", "degraded"...).
  readonly health: string;
  readonly degraded: boolean;
  readonly lastErrorCode: string | undefined;
  readonly outboxDepth: number;
}

const MAX_TEXT = 400;
const MAX_ITEMS = 12;
const STATES: readonly string[] = ["ok", "outdated", "missing", "unknown"];
const ENSURE_ACTIONS: readonly string[] = [
  "none",
  "installed",
  "updated",
  "skipped",
  "busy",
  "failed",
];
const UPDATE_ACTIONS: readonly string[] = ["installed", "updated", "none", "aborted", "failed"];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// A text of the document as it may be drawn; undefined for anything else, or for a text with nothing visible in it.
function textOf(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = plainText(value).trim();
  return clean === "" ? undefined : clean.slice(0, max);
}

// A message of several lines (the end of go's output) with each line cleaned on its own, so the breaks survive.
function blockOf(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value
    .split(/\r?\n/)
    .map((line) => plainText(line).trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? undefined : lines.join("\n").slice(0, max);
}

function textsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value.slice(0, MAX_ITEMS)) {
    const clean = textOf(item);
    if (clean !== undefined) out.push(clean);
  }
  return out;
}

function installOf(value: unknown): InstallView | undefined {
  if (!isObject(value)) return undefined;
  const path = textOf(value.path, 600);
  if (path === undefined) return undefined;
  const origins = textsOf(value.origins);
  return {
    path,
    version: textOf(value.version, 40) ?? null,
    origins: origins.length === 0 ? textsOf([value.origin]) : origins,
    active: value.active === true,
  };
}

function toolOf(value: unknown): ToolView | undefined {
  if (!isObject(value) || (value.id !== "engram" && value.id !== "gentle-ai")) return undefined;
  const installs = (Array.isArray(value.installs) ? value.installs.slice(0, MAX_ITEMS) : [])
    .map(installOf)
    .filter((install): install is InstallView => install !== undefined);
  const active = installOf(value.active) ?? installs.find((install) => install.active);
  const state =
    typeof value.state === "string" && STATES.includes(value.state) ? value.state : "unknown";
  return {
    id: value.id,
    state: state as ToolState,
    active,
    others: installs.filter((install) => !install.active && install.path !== active?.path),
    latest: textOf(value.latest, 40) ?? null,
    qualified: textOf(value.qualified, 40) ?? null,
    newerUpstream: value.newerUpstream === true,
    notes: textsOf(value.notes),
  };
}

function failureOf(value: unknown): InstallFailureView | undefined {
  if (!isObject(value)) return undefined;
  const failedAt = textOf(value.failedAt, 40);
  const message = textOf(value.message);
  if (failedAt === undefined || message === undefined) return undefined;
  return { failedAt, message, retryAt: textOf(value.retryAt, 40) ?? null };
}

// The settings of the report; anything that is not the object it should be is "not said", never a guess.
function memoryConfigOf(value: unknown): MemoryConfigView | undefined {
  if (!isObject(value)) return undefined;
  const provider = value.provider;
  if (provider !== "null" && provider !== "engram" && provider !== null) return undefined;
  return { provider, binary: textOf(value.binary, 600) };
}

function statusOf(value: unknown): ToolsStatusView | undefined {
  if (!isObject(value) || !Array.isArray(value.tools)) return undefined;
  const tools = value.tools.map(toolOf).filter((tool): tool is ToolView => tool !== undefined);
  return {
    engram: tools.find((tool) => tool.id === "engram"),
    gentleAi: tools.find((tool) => tool.id === "gentle-ai"),
    failure: failureOf(value.engramInstallFailure),
    memoryConfig: memoryConfigOf(value.memoryConfig),
  };
}

// The document of `haril tools status --json` (also the `status` inside the ensure and update documents).
export function parseToolsStatus(text: string): ToolsStatusView | undefined {
  return statusOf(parseJson(text));
}

// The document of `haril tools ensure --json`; undefined when it is not one.
export function parseEnsure(text: string): EnsureView | undefined {
  const document = parseJson(text);
  if (!isObject(document) || !isObject(document.engram)) return undefined;
  const result = document.engram;
  if (typeof result.action !== "string" || !ENSURE_ACTIONS.includes(result.action))
    return undefined;
  return {
    action: result.action as EnsureAction,
    from: textOf(result.from, 40),
    to: textOf(result.to, 40),
    message: blockOf(result.message),
    notes: textsOf(result.notes),
    status: statusOf(document.status),
  };
}

// The document of `haril tools update gentle-ai --json`; undefined when it is not one.
export function parseUpdate(text: string): UpdateView | undefined {
  const document = parseJson(text);
  if (!isObject(document) || !isObject(document.gentleAi)) return undefined;
  const result = document.gentleAi;
  if (typeof result.action !== "string" || !UPDATE_ACTIONS.includes(result.action))
    return undefined;
  return {
    action: result.action as UpdateAction,
    from: textOf(result.from, 40),
    to: textOf(result.to, 40),
    path: textOf(result.path, 600),
    message: blockOf(result.message, 800),
    warnings: textsOf(result.warnings),
    status: statusOf(document.status),
  };
}

// The document of `haril memory status --json`; undefined when it is not one.
export function parseMemoryStatus(text: string): MemoryView | undefined {
  const document = parseJson(text);
  if (!isObject(document)) return undefined;
  const provider = textOf(document.provider, 40);
  if (provider === undefined) return undefined;
  const outbox = isObject(document.outbox) ? document.outbox : {};
  const lastError = isObject(document.lastError) ? textOf(document.lastError.code, 60) : undefined;
  return {
    initialized: document.initialized !== false,
    running: document.runtime === "running",
    provider,
    persistent: typeof document.persistent === "boolean" ? document.persistent : null,
    health: textOf(document.health, 40) ?? "not_checked",
    degraded: document.degraded === true,
    lastErrorCode: lastError,
    outboxDepth:
      typeof outbox.depth === "number" && outbox.depth >= 0 ? Math.floor(outbox.depth) : 0,
  };
}
