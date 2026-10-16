// Minimal Store port for M1 (M1-D3): schema info, projects, the command queue and the event log.
// Operations are synchronous because node:sqlite is synchronous. Errors carry a `store.*` code.

export type GateStatus = "ok" | "warn" | "error";

export interface StoreGate {
  readonly name: string;
  readonly status: GateStatus;
  readonly detail: string;
}

export interface StorePragmas {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
}

export interface StoreInfo {
  readonly storeId: string;
  readonly schemaVersion: number;
  readonly sqliteVersion: string;
  readonly pragmas: StorePragmas;
  readonly gates: readonly StoreGate[];
}

export interface ProjectRecord {
  readonly projectId: string;
  readonly slug: string;
  readonly name: string;
  readonly rootPath: string;
  readonly createdAt: number;
}

export interface RegisterProjectInput {
  readonly slug: string;
  readonly name: string;
  readonly rootPath: string;
}

export interface EnqueueCommandInput {
  readonly type: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly projectId?: string;
}

export interface EnqueueResult {
  readonly commandId: string;
  // True when the idempotency key was already queued with the same request hash.
  readonly duplicate: boolean;
}

export interface CommandRecord {
  readonly commandId: string;
  readonly projectId: string | null;
  readonly type: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly enqueuedAt: number;
}

export interface AppendEventInput {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly type: string;
  readonly actorKind: "user" | "agent" | "system";
  readonly actorId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly schemaVersion?: number;
  readonly audit?: boolean;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface EventRecord extends AppendEventInput {
  readonly seq: number;
  readonly eventId: string;
  readonly ts: number;
}

export interface EventFilter {
  readonly aggregateId?: string;
}

export interface Store {
  info(): StoreInfo;
  readonly projects: {
    register(input: RegisterProjectInput): ProjectRecord;
    list(): readonly ProjectRecord[];
    getBySlug(slug: string): ProjectRecord | undefined;
  };
  readonly commands: {
    enqueue(input: EnqueueCommandInput): EnqueueResult;
    listQueued(): readonly CommandRecord[];
  };
  readonly events: {
    append(input: AppendEventInput): EventRecord;
    list(filter?: EventFilter): readonly EventRecord[];
  };
  close(): void;
}
