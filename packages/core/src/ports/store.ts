// Minimal Store port for M1 (M1-D3): schema info, projects, the command queue, tasks (read),
// the runtime lease (read) and the event log.
// Operations are synchronous because node:sqlite is synchronous. Errors carry a `store.*` code.
import type { TaskState } from "@haril/contracts";

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
  // Hash and text of the manifest that was registered (null when registered without one).
  readonly manifestSha256: string | null;
  readonly createdAt: number;
}

export interface RegisterProjectInput {
  // Optional: the store generates one when absent. The CLI passes the id it previewed.
  readonly projectId?: string;
  readonly slug: string;
  readonly name: string;
  readonly rootPath: string;
  readonly manifestSha256?: string;
  readonly manifestJson?: string;
}

export interface TaskRecord {
  readonly taskId: string;
  readonly projectId: string;
  readonly goal: string;
  readonly state: TaskState;
  readonly agentRef: string;
  readonly createdAt: number;
}

export interface TaskFilter {
  readonly projectId?: string;
}

// The newest runtime lease: `none` when no runtime has ever started (M1-D6).
export type RuntimeLeaseSummary =
  | { readonly status: "none" }
  | {
      readonly status: "active" | "released" | "lost";
      readonly instanceId: string;
      readonly pid: number;
      readonly startedAt: number;
      readonly heartbeatAt: number;
      readonly expiresAt: number;
      readonly nodeVersion: string;
      readonly sqliteVersion: string;
    };

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
    getByRootPath(rootPath: string): ProjectRecord | undefined;
  };
  readonly commands: {
    enqueue(input: EnqueueCommandInput): EnqueueResult;
    listQueued(): readonly CommandRecord[];
  };
  readonly tasks: {
    list(filter?: TaskFilter): readonly TaskRecord[];
  };
  readonly runtime: {
    leaseSummary(): RuntimeLeaseSummary;
  };
  readonly events: {
    append(input: AppendEventInput): EventRecord;
    list(filter?: EventFilter): readonly EventRecord[];
  };
  close(): void;
}
