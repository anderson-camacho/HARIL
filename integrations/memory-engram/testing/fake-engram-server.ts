// Fake Engram HTTP server for the memory-engram tests. It speaks the routes the adapter uses with in-memory state, and
// it is NOT Engram: the routes and parameters follow docs/research/06-engram.md sec3.2, but every JSON shape below is
// the adapter's [S] assumption (06 sec11 point 1: the real shapes are NOT VERIFIED and get pinned against a real
// `engram serve` in MC-T6). Behaviour it copies from 06 sec3.6 [V]: topic_key upsert in place, the 15-minute dedupe
// without topic_key, `<private>` redaction, 20 search results at most, the Bearer token on the protected routes.
// It is stricter than Engram where a deviation of the adapter must show: a request without `project` is refused as
// ambiguous (Engram would detect a project from its cwd) and `all_projects` is refused outright.
// Self-contained (node builtins only), so testing/fake-engram.mjs can load it with Node's type stripping.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export type FakeRoute =
  | "health"
  | "compatibility"
  | "sessions.open"
  | "sessions.get"
  | "sessions.end"
  | "observations.add"
  | "observations.save-result"
  | "observations.get"
  | "observations.delete"
  | "search"
  | "context"
  | "export"
  | "import";

// down: the connection is dropped and nothing is applied. slow: the answer comes after slowMs. 5xx: 503 and nothing
// is applied. ambiguous: the request is applied and its answer is lost.
export type FakeFault = "down" | "slow" | "5xx" | "ambiguous";

export interface FakeFaultOptions {
  // How many requests the fault hits; absent: until clearFaults().
  readonly times?: number;
  // After an ambiguous request, the next request of each of these routes answers 503 (its lookup fails too).
  readonly thenFail?: readonly FakeRoute[];
}

export interface FakeEngramOptions {
  // 0 (default): an ephemeral loopback port.
  readonly port?: number;
  readonly token?: string;
  readonly instanceId?: string;
  readonly version?: string;
  // The clock of created_at, updated_at and the dedupe window. Absent: Date.now.
  readonly now?: () => number;
  readonly slowMs?: number;
  // Answer /search and /context without honouring their scope and type parameters, which 06 does not list for them:
  // the adapter must filter on its side.
  readonly ignoreFilters?: boolean;
  // Test-only route POST /__fake/exit?code=N, for the fake executable: it answers, then calls this.
  readonly onExitRequest?: (code: number) => void;
  // Test-only route GET /__fake/env, for the fake executable: what it answers (its process environment).
  readonly onEnvRequest?: () => unknown;
}

export interface FakeRequest {
  readonly route: FakeRoute | "unknown";
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

export interface FakeObservation {
  id: number;
  sync_id: string;
  session_id: string;
  type: string;
  title: string;
  content: string;
  project: string;
  scope: string;
  topic_key: string | null;
  revision_count: number;
  duplicate_count: number;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  createdMs: number;
  updatedMs: number;
}

interface FakeSession {
  readonly id: string;
  readonly project: string;
  ended_at: string | null;
  summary: string | null;
}

interface LedgerEntry {
  readonly fingerprint: string;
  readonly result: Record<string, unknown>;
}

interface ArmedFault {
  readonly fault: FakeFault;
  remaining: number;
  readonly thenFail: readonly FakeRoute[];
}

const DEDUPE_WINDOW_MS = 15 * 60 * 1000;
const MAX_SEARCH_RESULTS = 20;
const DEFAULT_CONTEXT_BYTES = 16 * 1024;
const MAX_CONTEXT_BYTES = 64 * 1024;
const TOPIC_KEY_MAX_BYTES = 120;
const EXPORT_VERSION = "0.2.0";
const IMPORT_VERSIONS = ["0.2.0", "0.1.0"];
const PRIVATE_TAG = /<private>[\s\S]*?<\/private>/gi;
// The routes requireAuth guards in v3.4.0 that the adapter or the supervisor use (06 sec3.2 [V]).
const PROTECTED: readonly FakeRoute[] = [
  "compatibility",
  "observations.delete",
  "export",
  "import",
];

function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// Engram's normalizeTopicKey (06 sec3.6): trimmed, lowercase, spaces joined with "-", at most 120 bytes.
function normalizeTopicKey(key: string): string {
  let out = key.trim().toLowerCase().replace(/\s+/g, "-");
  while (utf8Bytes(out) > TOPIC_KEY_MAX_BYTES) out = out.slice(0, -1);
  return out;
}

function routeOf(method: string, parts: readonly string[]): FakeRoute | "unknown" {
  const [head, id, tail] = parts;
  if (method === "GET" && head === "health" && id === undefined) return "health";
  if (method === "GET" && head === "compatibility" && id === undefined) return "compatibility";
  if (head === "sessions") {
    if (method === "POST" && id === undefined) return "sessions.open";
    if (method === "GET" && id !== undefined && tail === undefined) return "sessions.get";
    if (method === "POST" && id !== undefined && tail === "end") return "sessions.end";
  }
  if (head === "observations") {
    if (method === "POST" && id === undefined) return "observations.add";
    if (method === "GET" && id === "save-result") return "observations.save-result";
    if (method === "GET" && id !== undefined && tail === undefined) return "observations.get";
    if (method === "DELETE" && id !== undefined && tail === undefined) return "observations.delete";
  }
  if (method === "GET" && head === "search") return "search";
  if (method === "GET" && head === "context") return "context";
  if (method === "GET" && head === "export") return "export";
  if (method === "POST" && head === "import") return "import";
  return "unknown";
}

function stringField(body: unknown, name: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

export class FakeEngramServer {
  readonly token: string;
  readonly instanceId: string;
  readonly version: string;
  // Every request the server received, in order (the spy of ADR-0008 T8).
  readonly requests: FakeRequest[] = [];
  private readonly requestedPort: number;
  private readonly now: () => number;
  private readonly slowMs: number;
  private readonly ignoreFilters: boolean;
  private readonly onExitRequest: ((code: number) => void) | undefined;
  private readonly onEnvRequest: (() => unknown) | undefined;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly faults = new Map<FakeRoute | "all", ArmedFault>();
  private readonly sessions = new Map<string, FakeSession>();
  private readonly observations = new Map<number, FakeObservation>();
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly expired = new Set<string>();
  private nextId = 1;

  constructor(options: FakeEngramOptions = {}) {
    this.requestedPort = options.port ?? 0;
    this.token = options.token ?? "fake-engram-token";
    this.instanceId = options.instanceId ?? randomBytes(16).toString("hex");
    this.version = options.version ?? "3.4.0";
    this.now = options.now ?? Date.now;
    this.slowMs = options.slowMs ?? 1000;
    this.ignoreFilters = options.ignoreFilters ?? false;
    this.onExitRequest = options.onExitRequest;
    this.onEnvRequest = options.onEnvRequest;
    this.server = createServer((req, res) => this.receive(req, res));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.requestedPort, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  setFault(route: FakeRoute | "all", fault: FakeFault, options: FakeFaultOptions = {}): void {
    this.faults.set(route, {
      fault,
      remaining: options.times ?? Number.POSITIVE_INFINITY,
      thenFail: options.thenFail ?? [],
    });
  }

  clearFaults(): void {
    this.faults.clear();
  }

  // The operation_id ledger forgets these operations: a lookup or a replay answers 410 (06 sec3.2).
  expireOperations(...operationIds: string[]): void {
    for (const id of operationIds) {
      this.ledger.delete(id);
      this.expired.add(id);
    }
  }

  // The live and soft-deleted observations, for assertions.
  stored(): FakeObservation[] {
    return [...this.observations.values()].map((observation) => ({ ...observation }));
  }

  endSessionOutside(id: string, summary: string): void {
    const session = this.sessions.get(id);
    if (session !== undefined) {
      session.ended_at = sqliteTime(this.now());
      session.summary = summary;
    }
  }

  // ---- Transport ----

  private receive(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = text;
      }
      this.dispatch(req, res, body);
    });
  }

  private dispatch(req: IncomingMessage, res: ServerResponse, body: unknown): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const parts = url.pathname
      .split("/")
      .filter((part) => part !== "")
      .map(decodeURIComponent);
    if (method === "POST" && parts[0] === "__fake" && parts[1] === "exit") {
      const code = Number(url.searchParams.get("code") ?? "1");
      this.send(res, 200, { exiting: code });
      setImmediate(() => this.onExitRequest?.(code));
      return;
    }
    if (method === "GET" && parts[0] === "__fake" && parts[1] === "env") {
      this.send(res, 200, this.onEnvRequest?.() ?? {});
      return;
    }
    const route = routeOf(method, parts);
    const query = Object.fromEntries(url.searchParams.entries());
    const authorization = req.headers.authorization;
    this.requests.push({ route, method, path: url.pathname, query, body, authorization });
    const fault = route === "unknown" ? undefined : this.takeFault(route);
    if (fault === "down") {
      req.socket.destroy();
      return;
    }
    if (fault === "5xx") {
      this.send(res, 503, { error: "fake_unavailable" });
      return;
    }
    const answer = (): void => {
      if (
        route !== "unknown" &&
        PROTECTED.includes(route) &&
        authorization !== `Bearer ${this.token}`
      ) {
        this.send(res, 401, { error: "unauthorized" });
        return;
      }
      const [status, payload] = this.handle(route, parts, url.searchParams, body);
      if (fault === "ambiguous") {
        req.socket.destroy();
        return;
      }
      this.send(res, status, payload);
    };
    if (fault === "slow") {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        answer();
      }, this.slowMs);
      this.timers.add(timer);
      return;
    }
    answer();
  }

  private takeFault(route: FakeRoute): FakeFault | undefined {
    const key = this.faults.has(route) ? route : this.faults.has("all") ? "all" : undefined;
    if (key === undefined) return undefined;
    const armed = this.faults.get(key);
    if (armed === undefined) return undefined;
    armed.remaining -= 1;
    if (armed.remaining <= 0) this.faults.delete(key);
    if (armed.fault === "ambiguous") {
      for (const next of armed.thenFail) this.setFault(next, "5xx", { times: 1 });
    }
    return armed.fault;
  }

  private send(res: ServerResponse, status: number, payload: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  }

  // ---- Routes ----

  private handle(
    route: FakeRoute | "unknown",
    parts: readonly string[],
    query: URLSearchParams,
    body: unknown,
  ): [number, unknown] {
    switch (route) {
      case "health":
        return [
          200,
          {
            status: "ok",
            service: "engram",
            version: this.version,
            instance_id: this.instanceId,
            capabilities: {},
          },
        ];
      case "compatibility":
        // The facts of the store at start-up [S]; the supervisor only needs the status.
        return [200, { status: "ok" }];
      case "sessions.open":
        return this.openSession(body);
      case "sessions.get":
        return this.getSession(parts[1] ?? "");
      case "sessions.end":
        return this.endSession(parts[1] ?? "", body);
      case "observations.add":
        return this.addObservation(body);
      case "observations.save-result":
        return this.saveResult(query.get("operation_id") ?? "");
      case "observations.get":
        return this.getObservation(parts[1] ?? "");
      case "observations.delete":
        return this.deleteObservation(parts[1] ?? "", query);
      case "search":
        return this.search(query);
      case "context":
        return this.context(query);
      case "export":
        return this.export(query);
      case "import":
        return this.import(body);
      default:
        return [404, { error: "not_found" }];
    }
  }

  private openSession(body: unknown): [number, unknown] {
    const id = stringField(body, "id");
    const project = stringField(body, "project");
    if (id === undefined || id === "") return [400, { error: "id is required" }];
    if (project === undefined || project === "") return [409, { error: "ambiguous_project" }];
    const existing = this.sessions.get(id);
    if (existing !== undefined) {
      if (existing.project !== project) return [409, { error: "session_project_conflict" }];
      if (existing.ended_at !== null) return [409, { error: "session_already_ended" }];
      return [200, { id, project }];
    }
    this.sessions.set(id, { id, project, ended_at: null, summary: null });
    return [201, { id, project }];
  }

  private getSession(id: string): [number, unknown] {
    const session = this.sessions.get(id);
    if (session === undefined) return [404, { error: "session_not_found" }];
    return [200, { ...session }];
  }

  private endSession(id: string, body: unknown): [number, unknown] {
    const session = this.sessions.get(id);
    if (session === undefined) return [404, { error: "session_not_found" }];
    if (session.ended_at !== null) return [409, { error: "session_already_ended" }];
    session.ended_at = sqliteTime(this.now());
    session.summary = stringField(body, "summary") ?? "";
    return [200, { id, ended_at: session.ended_at }];
  }

  private addObservation(body: unknown): [number, unknown] {
    const fields = (typeof body === "object" && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const sessionId = stringField(fields, "session_id");
    const content = stringField(fields, "content");
    const title = stringField(fields, "title") ?? "";
    const project = stringField(fields, "project");
    if (sessionId === undefined || content === undefined) {
      return [400, { error: "session_id and content are required" }];
    }
    if (title.trim() === "") return [400, { error: "title is required" }];
    if (project === undefined || project === "") return [409, { error: "ambiguous_project" }];
    const operationId = stringField(fields, "operation_id");
    const fingerprint = JSON.stringify([
      sessionId,
      project,
      fields.scope,
      fields.type,
      title,
      content,
      fields.topic_key ?? null,
    ]);
    if (operationId !== undefined) {
      if (this.expired.has(operationId)) return [410, { error: "operation_expired" }];
      const first = this.ledger.get(operationId);
      if (first !== undefined) {
        return first.fingerprint === fingerprint
          ? [200, first.result]
          : [409, { error: "operation_id_conflict" }];
      }
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) return [404, { error: "session_not_found" }];
    if (session.project !== project) return [409, { error: "session_project_conflict" }];
    if (session.ended_at !== null) return [409, { error: "session_already_ended" }];
    const result = this.keep({
      sessionId,
      project,
      scope: stringField(fields, "scope") ?? "project",
      type: stringField(fields, "type") ?? "discovery",
      title: title.replace(PRIVATE_TAG, "[REDACTED]"),
      content: content.replace(PRIVATE_TAG, "[REDACTED]"),
      topicKey: stringField(fields, "topic_key"),
    });
    if (operationId !== undefined) this.ledger.set(operationId, { fingerprint, result });
    return [200, result];
  }

  private keep(write: {
    readonly sessionId: string;
    readonly project: string;
    readonly scope: string;
    readonly type: string;
    readonly title: string;
    readonly content: string;
    readonly topicKey: string | undefined;
  }): Record<string, unknown> {
    const nowMs = this.now();
    const live = this.live(write.project, write.scope);
    if (write.topicKey !== undefined && write.topicKey !== "") {
      const key = normalizeTopicKey(write.topicKey);
      const topic = live
        .filter((observation) => observation.topic_key === key)
        .sort((a, b) => b.id - a.id)[0];
      if (topic !== undefined) {
        topic.title = write.title;
        topic.content = write.content;
        topic.type = write.type;
        topic.revision_count += 1;
        topic.updated_at = sqliteTime(nowMs);
        topic.updatedMs = nowMs;
        return this.resultOf(topic, "updated");
      }
      return this.resultOf(this.create(write, key, nowMs), "created");
    }
    const twin = live.find(
      (observation) =>
        observation.topic_key === null &&
        observation.type === write.type &&
        observation.title === write.title &&
        observation.content.trim().toLowerCase() === write.content.trim().toLowerCase() &&
        nowMs - observation.createdMs <= DEDUPE_WINDOW_MS,
    );
    if (twin !== undefined) {
      twin.duplicate_count += 1;
      return this.resultOf(twin, "deduped");
    }
    return this.resultOf(this.create(write, null, nowMs), "created");
  }

  private create(
    write: {
      readonly sessionId: string;
      readonly project: string;
      readonly scope: string;
      readonly type: string;
      readonly title: string;
      readonly content: string;
    },
    topicKey: string | null,
    nowMs: number,
  ): FakeObservation {
    const id = this.nextId++;
    const observation: FakeObservation = {
      id,
      sync_id: `fake-sync-${this.instanceId.slice(0, 8)}-${id}`,
      session_id: write.sessionId,
      type: write.type,
      title: write.title,
      content: write.content,
      project: write.project,
      scope: write.scope,
      topic_key: topicKey,
      revision_count: 1,
      duplicate_count: 0,
      pinned: false,
      created_at: sqliteTime(nowMs),
      updated_at: sqliteTime(nowMs),
      deleted_at: null,
      createdMs: nowMs,
      updatedMs: nowMs,
    };
    this.observations.set(id, observation);
    return observation;
  }

  private resultOf(observation: FakeObservation, outcome: string): Record<string, unknown> {
    return {
      id: observation.id,
      sync_id: observation.sync_id,
      outcome,
      revision_count: observation.revision_count,
      duplicate_count: observation.duplicate_count,
    };
  }

  private saveResult(operationId: string): [number, unknown] {
    if (this.expired.has(operationId)) return [410, { error: "operation_expired" }];
    const entry = this.ledger.get(operationId);
    if (entry === undefined) return [404, { error: "operation_not_found" }];
    return [200, { status: "applied", result: entry.result }];
  }

  private getObservation(rawId: string): [number, unknown] {
    const observation = this.observations.get(Number(rawId));
    if (observation === undefined) return [404, { error: "observation_not_found" }];
    return [200, this.wire(observation)];
  }

  private deleteObservation(rawId: string, query: URLSearchParams): [number, unknown] {
    const id = Number(rawId);
    const observation = this.observations.get(id);
    if (observation === undefined) return [404, { error: "observation_not_found" }];
    if (query.get("expected_project") !== observation.project) {
      return [409, { error: "observation_project_mismatch" }];
    }
    if (query.get("hard") === "true") {
      this.observations.delete(id);
      return [200, { id, deleted: "hard" }];
    }
    observation.deleted_at ??= sqliteTime(this.now());
    return [200, { id, deleted: "soft" }];
  }

  // The project and the scope (undefined: every scope, when the fake ignores the filters) of a read.
  private scoped(query: URLSearchParams): [string, string | undefined] | [number, unknown] {
    if (query.has("all_projects")) return [400, { error: "all_projects is refused by the fake" }];
    const project = query.get("project");
    if (project === null || project === "") return [409, { error: "ambiguous_project" }];
    return [project, this.ignoreFilters ? undefined : (query.get("scope") ?? "project")];
  }

  private typeOf(query: URLSearchParams): string | null {
    return this.ignoreFilters ? null : query.get("type");
  }

  private search(query: URLSearchParams): [number, unknown] {
    const scoped = this.scoped(query);
    if (typeof scoped[0] === "number") return scoped as [number, unknown];
    const [project, scope] = scoped as [string, string | undefined];
    const terms = (query.get("q") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term !== "");
    const any = query.get("match_mode") === "any";
    const type = this.typeOf(query);
    const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(query.get("limit") ?? "10")));
    const results = this.live(project, scope)
      .filter((observation) => type === null || observation.type === type)
      .map((observation) => {
        const text = `${observation.title}\n${observation.content}`.toLowerCase();
        return { observation, score: terms.filter((term) => text.includes(term)).length };
      })
      .filter(({ score }) => (any ? score > 0 : terms.length > 0 && score === terms.length))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.observation.updatedMs - a.observation.updatedMs ||
          b.observation.id - a.observation.id,
      )
      .slice(0, limit)
      .map(({ observation, score }) => ({ ...this.wire(observation), score }));
    return [200, { results }];
  }

  private context(query: URLSearchParams): [number, unknown] {
    const scoped = this.scoped(query);
    if (typeof scoped[0] === "number") return scoped as [number, unknown];
    const [project, scope] = scoped as [string, string | undefined];
    const type = this.typeOf(query);
    const pinned = query.get("pinned") !== "false";
    const maxBytes = Math.min(
      MAX_CONTEXT_BYTES,
      Number(query.get("max_bytes") ?? DEFAULT_CONTEXT_BYTES),
    );
    const universe = this.live(project, scope)
      .filter((observation) => type === null || observation.type === type)
      .filter((observation) => pinned || !observation.pinned)
      .sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedMs - a.updatedMs || b.id - a.id,
      );
    const observations: Record<string, unknown>[] = [];
    let used = 0;
    for (const observation of universe) {
      used += utf8Bytes(observation.title) + utf8Bytes(observation.content);
      if (used > maxBytes) break;
      observations.push(this.wire(observation));
    }
    return [200, { observations, total: universe.length }];
  }

  private export(query: URLSearchParams): [number, unknown] {
    const project = query.get("project");
    const observations = [...this.observations.values()]
      .filter((observation) => observation.deleted_at === null)
      .filter((observation) => project === null || observation.project === project)
      .map((observation) => this.wire(observation));
    const sessions = [...this.sessions.values()]
      .filter((session) => project === null || session.project === project)
      .map((session) => ({ ...session }));
    return [
      200,
      { version: EXPORT_VERSION, exported_at: sqliteTime(this.now()), observations, sessions },
    ];
  }

  private import(body: unknown): [number, unknown] {
    const version = stringField(body, "version");
    if (version === undefined || !IMPORT_VERSIONS.includes(version)) {
      return [400, { error: "unsupported_export_version" }];
    }
    const data = body as { observations?: unknown; sessions?: unknown };
    for (const raw of Array.isArray(data.sessions) ? data.sessions : []) {
      const id = stringField(raw, "id");
      const project = stringField(raw, "project");
      if (id === undefined || project === undefined || this.sessions.has(id)) continue;
      const fields = raw as Record<string, unknown>;
      this.sessions.set(id, {
        id,
        project,
        ended_at: typeof fields.ended_at === "string" ? fields.ended_at : null,
        summary: typeof fields.summary === "string" ? fields.summary : null,
      });
    }
    let imported = 0;
    let updated = 0;
    let unchanged = 0;
    for (const raw of Array.isArray(data.observations) ? data.observations : []) {
      const incoming = raw as FakeObservation;
      const existing = [...this.observations.values()].find(
        (observation) => observation.sync_id === incoming.sync_id,
      );
      if (existing === undefined) {
        const id = this.nextId++;
        this.observations.set(id, { ...incoming, id });
        imported += 1;
      } else if (incoming.updatedMs > existing.updatedMs) {
        this.observations.set(existing.id, { ...incoming, id: existing.id });
        updated += 1;
      } else {
        unchanged += 1;
      }
    }
    return [200, { imported, updated, unchanged, rejected: 0 }];
  }

  private live(project: string, scope: string | undefined): FakeObservation[] {
    return [...this.observations.values()].filter(
      (observation) =>
        observation.deleted_at === null &&
        observation.project === project &&
        (scope === undefined || observation.scope === scope),
    );
  }

  // The observation as the fake sends it; createdMs and updatedMs stay too (an export keeps them for the import's
  // "strictly newer" rule).
  private wire(observation: FakeObservation): Record<string, unknown> {
    return { ...observation };
  }
}
