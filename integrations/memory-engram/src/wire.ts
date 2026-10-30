// Engram's HTTP answers as the adapter reads them. The routes and the field names of /health (status, version,
// instance_id) and of an observation are 06 sec3.2 and sec3.6 [V]; every other JSON shape here (the save result, the
// /search and /context envelopes, the session, the import report, the error body) is the adapter's [S] assumption,
// because the real shapes are NOT VERIFIED (06 sec11 point 1; memory.md 9.4 point 5). They are pinned against a real
// `engram serve` in MC-T6 (06:1), and this module is the one place that changes then. A reader returns undefined for
// an answer it cannot read, never a guess.

export interface WireHealth {
  readonly version: string | null;
  readonly instanceId: string | null;
}

export interface WireObservation {
  readonly id: string;
  readonly syncId: string | undefined;
  readonly sessionId: string;
  readonly type: string;
  readonly title: string;
  readonly content: string;
  readonly project: string;
  readonly scope: string;
  readonly topicKey: string | undefined;
  readonly revisionCount: number | undefined;
  readonly duplicateCount: number | undefined;
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deleted: boolean;
  // Relevance from /search, higher is better [S].
  readonly score: number | undefined;
}

type SaveOutcome = "created" | "updated" | "deduped" | "stored";

export interface WireSaveResult {
  readonly id: string;
  readonly syncId: string | undefined;
  readonly outcome: SaveOutcome;
}

export interface WireSession {
  readonly project: string;
  readonly ended: boolean;
  readonly summary: string | null;
}

export interface WireContext {
  readonly observations: readonly WireObservation[];
  // Every live observation the filter matches, also those max_bytes left out [S].
  readonly total: number;
}

export interface WireImport {
  readonly imported: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly rejected: number;
}

type Fields = Readonly<Record<string, unknown>>;

function fields(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// An Engram id: a positive integer, sent as a number or a string.
function idOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) ? value : undefined;
}

export function isEngramId(ref: string): boolean {
  return idOf(ref) !== undefined;
}

// Epoch ms of an Engram timestamp: SQLite's "YYYY-MM-DD HH:MM:SS" is UTC [I]; an ISO string is read as written.
// Anything else is 0, never the local time zone.
function timeOf(value: unknown): number {
  if (typeof value !== "string") return 0;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : 0;
}

export function readHealth(value: unknown): WireHealth | undefined {
  const body = fields(value);
  if (body === undefined) return undefined;
  return { version: text(body.version) ?? null, instanceId: text(body.instance_id) ?? null };
}

export function readObservation(value: unknown): WireObservation | undefined {
  const body = fields(value);
  const id = idOf(body?.id);
  if (body === undefined || id === undefined) return undefined;
  const title = text(body.title);
  const content = text(body.content);
  const project = text(body.project);
  if (title === undefined || content === undefined || project === undefined) return undefined;
  const deletedAt = text(body.deleted_at);
  return {
    id,
    syncId: text(body.sync_id),
    sessionId: text(body.session_id) ?? "",
    type: text(body.type) ?? "",
    title,
    content,
    project,
    scope: text(body.scope) ?? "project",
    topicKey: text(body.topic_key),
    revisionCount: count(body.revision_count),
    duplicateCount: count(body.duplicate_count),
    pinned: body.pinned === true,
    createdAt: timeOf(body.created_at),
    updatedAt: timeOf(body.updated_at),
    deleted: deletedAt !== undefined && deletedAt !== "",
    score: typeof body.score === "number" && Number.isFinite(body.score) ? body.score : undefined,
  };
}

function readList(value: unknown): WireObservation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: WireObservation[] = [];
  for (const item of value) {
    const observation = readObservation(item);
    if (observation === undefined) return undefined;
    list.push(observation);
  }
  return list;
}

export function readSearch(value: unknown): WireObservation[] | undefined {
  // Released Engram returns a bare array; older adapter fixtures used an envelope.
  return readList(Array.isArray(value) ? value : fields(value)?.results);
}

export function readContext(value: unknown): WireContext | undefined {
  const body = fields(value);
  const observations = readList(body?.observations);
  if (observations === undefined) return undefined;
  return { observations, total: Math.max(count(body?.total) ?? 0, observations.length) };
}

// The answer of POST /observations, or the result inside GET /observations/save-result ({status, result}).
export function readSaveResult(value: unknown): WireSaveResult | undefined {
  const outer = fields(value);
  const body = fields(outer?.result) ?? outer;
  const id = idOf(body?.id);
  const outcome =
    body?.outcome ??
    (body?.status === "saved" || body?.status === "committed" ? "stored" : undefined);
  if (
    id === undefined ||
    (outcome !== "created" &&
      outcome !== "updated" &&
      outcome !== "deduped" &&
      outcome !== "stored")
  ) {
    return undefined;
  }
  return { id, syncId: text(body?.sync_id), outcome };
}

export function readSession(value: unknown): WireSession | undefined {
  const body = fields(value);
  const project = text(body?.project);
  if (body === undefined || project === undefined) return undefined;
  const endedAt = text(body.ended_at);
  return {
    project,
    ended: endedAt !== undefined && endedAt !== "",
    summary: text(body.summary) ?? null,
  };
}

export function readImport(value: unknown): WireImport | undefined {
  const body = fields(value);
  const imported = count(body?.imported);
  const updated = count(body?.updated);
  const unchanged = count(body?.unchanged);
  if (imported === undefined || updated === undefined || unchanged === undefined) return undefined;
  return { imported, updated, unchanged, rejected: count(body?.rejected) ?? 0 };
}

// The version of an export file and how many observations it holds (null when it does not list them).
export function readExport(
  value: unknown,
): { readonly version: string; readonly records: number | null } | undefined {
  const body = fields(value);
  const version = text(body?.version);
  if (version === undefined) return undefined;
  const observations = body?.observations;
  return { version, records: Array.isArray(observations) ? observations.length : null };
}

// The error code of an answer: the "error" or "code" field of a JSON body, else a known code found in the text.
const KNOWN_CODES = [
  "session_already_ended",
  "session_project_conflict",
  "ambiguous_project",
  "observation_project_mismatch",
  "operation_id_conflict",
];

export function errorCodeOf(body: unknown, raw: string): string | undefined {
  const named = text(fields(body)?.error) ?? text(fields(body)?.code);
  if (named !== undefined && KNOWN_CODES.includes(named)) return named;
  return KNOWN_CODES.find((code) => raw.includes(code)) ?? named;
}
