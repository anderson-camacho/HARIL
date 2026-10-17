// core/memory's service (MC-T4; memory.md 2.2, 4.3 to 4.5; ADR-0008 D4 to D6; ARCH 8.3, 8.4): the outbox consumer and
// the degradation of memory for one runtime epoch. A write to a persistent provider becomes a memory_outbox row and only
// the consumer delivers it, at least once and with the operationId fixed at enqueue time, so the provider deduplicates
// a redelivery (MEM-03, MEM-04); events is never the channel to memory. While the provider is Unavailable, reads come
// back empty, rows wait with their backoff, memory.degraded is recorded once per transition, and only the tasks whose
// requires[] has memory wait as blocked(memory_unavailable) (MEM-08). Health is checked on demand and with a backoff,
// never by polling (H6). Pure: the Store and the provider come in as ports, the clock, ids and hash are injected (R7).
import type {
  MemoryHealth,
  MemoryHitPage,
  MemoryOrigin,
  MemoryProviderState,
  MemoryQuery,
  MemoryWrite,
  MemoryWriteScope,
  RecallBundle,
  RecallRequest,
  WriteReceipt,
} from "@haril/contracts";
import type {
  Clock,
  Hasher,
  Ids,
  JsonObject,
  MarkDeliveredInput,
  MemoryFailure,
  MemoryProvider,
  MemoryRefInsert,
  OutboxRow,
  PromotedTask,
  Result,
  Store,
} from "../ports/index.js";
import { outboxDepth } from "./status.js";
import { checked, contractInvalid, memoryFailure, ok, utf8Length } from "./support.js";

// R-O4: exponential backoff from 1 s up to 60 s [S], unmeasured.
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
// [S]: the contract proposes no cap on delivery attempts (memory.md 4.4). An outage costs one attempt at most, since a
// degraded service does not drain until its health check passes.
export const MAX_DELIVERY_ATTEMPTS = 10;
// [S] rows delivered per drain, so one turn of the runtime loop stays short; the rest go in the next turn.
const DRAIN_BATCH = 50;

export interface MemoryServiceOptions {
  readonly store: Pick<Store, "memory" | "events">;
  readonly provider: MemoryProvider;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly hasher: Hasher;
  // The runtime epoch that fences every write of the service.
  readonly epoch: number;
  // A delay in [0, maxMs) taken off each backoff (R-O4 jitter). Absent: no jitter; the Core has no randomness (R7).
  readonly jitter?: (maxMs: number) => number;
}

// A write as core/memory receives it: the ScopeRef the runtime injected, with its kind, and content already redacted
// (RF-226). The service adds the operationId, the content hash and the schema version.
export interface MemoryWriteDraft {
  readonly scope: MemoryWriteScope;
  readonly title: string;
  readonly content: string;
  readonly topicKey?: string;
  readonly origin: MemoryOrigin;
  readonly sourceRef?: { readonly table: string; readonly id: string };
}

// queued: the row waits in the outbox. A provider that does not persist is never queued (CM-04): it answers at once.
export type EnqueuedWrite =
  | { readonly operationId: string; readonly queued: true }
  | { readonly operationId: string; readonly queued: false; readonly receipt: WriteReceipt };

// The tasks a turn moved: blocked while memory is unavailable, released when it is back.
export interface MemoryTick {
  readonly blocked: readonly PromotedTask[];
  readonly released: readonly PromotedTask[];
}

export interface MemoryService {
  readonly state: MemoryProviderState;
  // Requeues the rows earlier epochs left sending (MEM-16), checks the provider and records its state, then releases
  // the tasks left waiting and drains the outbox when it is up, or blocks the tasks that need it (ARCH 7.5, R-O7).
  start(): Promise<MemoryTick>;
  // One turn of the runtime loop: the health check when its backoff is due, the drain when rows are due, and the tasks
  // that wait for memory. A turn with nothing due touches neither the Store nor the provider.
  tick(): Promise<MemoryTick>;
  enqueueWrite(draft: MemoryWriteDraft): Promise<Result<EnqueuedWrite, MemoryFailure>>;
  // Reads never fail with Unavailable: they come back empty, and the provider is degraded (RF-128).
  recall(request: RecallRequest): Promise<Result<RecallBundle, MemoryFailure>>;
  search(query: MemoryQuery): Promise<Result<MemoryHitPage, MemoryFailure>>;
}

// R-O4 for attempt n (1-based): 1 s, 2 s, 4 s ... up to 60 s.
export function deliveryBackoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

// What a failed delivery does to its row (memory.md 4.4). An Unavailable the adapter could not resolve, an unknown
// result, comes back non-retryable and goes to review: it is never resent blindly (R-O6). SessionEnded and
// ScopeMismatch cannot be retargeted without changing the row's ScopeRef. Unsupported, NotFound and contract.invalid
// mean the Core queued what it should not have: the row is dead.
export function outboxTransitionOf(
  failure: MemoryFailure,
  attempts: number,
): "pending" | "needs_review" | "dead" {
  if (failure.code === "Unavailable") {
    if (!failure.retryable) return "needs_review";
    return attempts >= MAX_DELIVERY_ATTEMPTS ? "dead" : "pending";
  }
  if (failure.code === "SessionEnded" || failure.code === "ScopeMismatch") return "needs_review";
  return "dead";
}

// What a delivered row records: its receipt, its pointers and its event.
type Delivered = Omit<MarkDeliveredInput, "operationId" | "provider">;

export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  const { store, provider, clock, ids, hasher, epoch } = options;
  const capabilities = provider.capabilities();
  const providerName = capabilities.provider;
  let state: MemoryProviderState = "active";
  let healthFailures = 0;
  let nextHealthAt = 0;
  let drainRequested = false;
  let nextDueAt: number | null = null;

  // The backoff of attempt n less up to half of it as jitter, in whole milliseconds: never above the cap.
  const backoff = (attempt: number): number => {
    const delay = deliveryBackoffMs(attempt);
    const jitter = Math.floor(options.jitter?.(delay / 2) ?? 0);
    return delay - Math.min(delay / 2, Math.max(0, jitter));
  };

  const record = (to: MemoryProviderState, code?: string): void => {
    store.memory.setState(epoch, {
      provider: providerName,
      state: to,
      persistent: capabilities.persistent,
      ...(code === undefined ? {} : { code }),
    });
  };

  // active -> degraded (or blocked_by_policy) once: the first fall records it and starts the health backoff.
  const degrade = (code: string, to: MemoryProviderState = "degraded"): void => {
    if (state === to) return;
    if (state === "active") {
      healthFailures = 0;
      nextHealthAt = clock.now() + backoff(1);
    }
    state = to;
    record(to, code);
  };

  const recover = (): void => {
    state = "active";
    healthFailures = 0;
    drainRequested = true;
    record("active");
  };

  // Called only while degraded and only when the backoff is due. True when the provider is back.
  const checkHealth = async (): Promise<boolean> => {
    const health = await provider.health();
    if (isHealthy(health)) {
      recover();
      return true;
    }
    healthFailures += 1;
    nextHealthAt = clock.now() + backoff(healthFailures + 1);
    if (health.state === "blocked_by_policy") degrade(codeOf(health), "blocked_by_policy");
    return false;
  };

  const send = async (row: OutboxRow): Promise<Result<Delivered, MemoryFailure>> => {
    switch (row.op) {
      case "store": {
        const write = checked("write", row.payload);
        if (!write.ok) return write;
        const sent = await provider.store(write.value);
        return sent.ok ? ok(storedRow(row, write.value, sent.value)) : sent;
      }
      case "summarize": {
        const summary = checked("summarize-write", row.payload);
        if (!summary.ok) return summary;
        const sent = await provider.summarize(summary.value);
        if (!sent.ok) return sent;
        const write = {
          scope: { ...summary.value.scope, kind: "run_summary" as const },
          origin: "haril" as const,
          contentSha256: summary.value.textSha256,
        };
        return ok(storedRow(row, write, sent.value));
      }
      case "forget": {
        const request = checked("forget-request", row.payload);
        if (!request.ok) return request;
        const sent = await provider.forget(request.value);
        if (!sent.ok) return sent;
        return ok({
          receipt: sent.value,
          refs: [],
          event: {
            type: "memory.forgotten",
            payload: {
              operationId: row.operationId,
              mode: sent.value.mode,
              erasure: sent.value.erasure,
              providerRef: sent.value.ref.providerRef,
            },
          },
        });
      }
      case "consolidate": {
        const request = checked("consolidation-request", row.payload);
        if (!request.ok) return request;
        const sent = await provider.consolidate(request.value);
        if (!sent.ok) return sent;
        return ok({
          receipt: sent.value,
          refs: [],
          event: {
            type: "memory.consolidated",
            payload: {
              operationId: row.operationId,
              sourceCount: request.value.sources.length,
              mode: sent.value.mode,
            },
          },
        });
      }
    }
  };

  // The provider call runs outside any transaction of haril.db: claim, call, close (R-O2). True when delivered.
  const deliver = async (row: OutboxRow): Promise<boolean> => {
    const sent = await send(row);
    if (sent.ok) {
      store.memory.markDelivered(epoch, {
        operationId: row.operationId,
        provider: providerName,
        ...sent.value,
      });
      return true;
    }
    const to = outboxTransitionOf(sent.error, row.attempts);
    store.memory.markFailed(epoch, {
      operationId: row.operationId,
      code: sent.error.code,
      to,
      ...(to === "pending" ? { nextAttemptAt: clock.now() + backoff(row.attempts) } : {}),
    });
    if (isUnavailable(sent.error)) degrade(sent.error.code);
    return false;
  };

  // One consumer, sequential, in outbox order (R-O1, R-O3); it stops as soon as the provider falls.
  const drain = async (): Promise<void> => {
    drainRequested = false;
    let delivered = 0;
    for (let count = 0; state === "active"; count += 1) {
      if (count >= DRAIN_BATCH) {
        drainRequested = true;
        break;
      }
      const [row] = store.memory.claimDue(epoch, 1);
      if (row === undefined) break;
      if (await deliver(row)) delivered += 1;
    }
    nextDueAt = store.memory.nextDueAt();
    if (delivered === 0) return;
    store.events.append({
      aggregateType: "memory",
      aggregateId: providerName,
      type: "memory.outbox.flushed",
      actorKind: "system",
      actorId: `runtime:${epoch}`,
      payload: {
        provider: providerName,
        delivered,
        remaining: outboxDepth(store.memory.status().outbox),
      },
    });
  };

  const drainDue = (): boolean =>
    drainRequested || (nextDueAt !== null && clock.now() >= nextDueAt);

  // A read while degraded does not reach the provider: the health check finds it back (H6).
  const read = async <T>(
    call: () => Promise<Result<T, MemoryFailure>>,
    empty: () => T,
  ): Promise<Result<T, MemoryFailure>> => {
    if (state !== "active") return ok(empty());
    const result = await call();
    if (result.ok || !isUnavailable(result.error)) return result;
    degrade(result.error.code);
    return ok(empty());
  };

  const waitingTasks = (): readonly PromotedTask[] =>
    state === "active" ? [] : store.memory.blockTasks(epoch);

  return {
    get state() {
      return state;
    },

    async start() {
      store.memory.requeueStale(epoch);
      const health = await provider.health();
      let released: readonly PromotedTask[] = [];
      if (isHealthy(health)) {
        recover();
        released = store.memory.releaseTasks(epoch);
        await drain();
      } else {
        degrade(
          codeOf(health),
          health.state === "blocked_by_policy" ? "blocked_by_policy" : "degraded",
        );
      }
      return { blocked: waitingTasks(), released };
    },

    async tick() {
      let released: readonly PromotedTask[] = [];
      if (state !== "active" && clock.now() >= nextHealthAt && (await checkHealth())) {
        released = store.memory.releaseTasks(epoch);
      }
      if (state === "active" && drainDue()) await drain();
      return { blocked: waitingTasks(), released };
    },

    async enqueueWrite(draft) {
      const operationId = ids.next();
      const write = checked("write", {
        schemaVersion: 1,
        operationId,
        scope: draft.scope,
        title: draft.title,
        content: draft.content,
        contentSha256: hasher.sha256(draft.content),
        ...(draft.topicKey === undefined ? {} : { topicKey: draft.topicKey }),
        origin: draft.origin,
        ...(draft.sourceRef === undefined ? {} : { sourceRef: draft.sourceRef }),
      });
      if (!write.ok) return write;
      // Never truncated in silence (memory.md 4.3): content that does not fit is split or summarized by the caller.
      const bytes = utf8Length(draft.content);
      if (capabilities.maxContentBytes !== null && bytes > capabilities.maxContentBytes) {
        return contractInvalid(
          `the content is ${bytes} bytes, more than the ${capabilities.maxContentBytes} the provider takes`,
          { bytes, limitBytes: capabilities.maxContentBytes },
        );
      }
      if (draft.topicKey !== undefined && !capabilities.topicKeyUpsert) {
        return memoryFailure("Unsupported", `${providerName} does not upsert by topicKey`);
      }
      if (!capabilities.persistent) {
        const stored = await provider.store(write.value);
        if (!stored.ok) {
          if (isUnavailable(stored.error)) degrade(stored.error.code);
          return stored;
        }
        return ok({ operationId, queued: false, receipt: stored.value });
      }
      store.memory.enqueue(epoch, [
        {
          operationId,
          projectId: draft.scope.projectKey,
          op: "store",
          payload: write.value,
          schemaVersion: 1,
          sessionId: draft.scope.sessionId,
          ...(draft.sourceRef === undefined ? {} : { source: draft.sourceRef }),
        },
      ]);
      drainRequested = true;
      return ok({ operationId, queued: true });
    },

    recall: (request) =>
      read(
        () => provider.recall(request),
        () => ({
          schemaVersion: 1,
          scope: request.scope,
          budgetTokens: request.budgetTokens,
          usedTokens: 0,
          items: [],
          omittedCount: 0,
          degraded: true,
        }),
      ),

    search: (query) =>
      read(
        () => provider.search(query),
        () => ({ items: [] }),
      ),
  };
}

// A store or a summarize the provider took: its pointer (when the provider names the record) and memory.stored. The
// event carries no content (memory.md 6).
function storedRow(
  row: OutboxRow,
  write: Pick<MemoryWrite, "scope" | "origin" | "contentSha256"> &
    Partial<Pick<MemoryWrite, "topicKey" | "sourceRef">>,
  receipt: WriteReceipt,
): Delivered {
  const refs: MemoryRefInsert[] =
    receipt.providerRef === undefined
      ? []
      : [
          {
            projectId: row.projectId,
            ...(write.scope.taskId === undefined ? {} : { taskId: write.scope.taskId }),
            provider: receipt.provider,
            providerRef: receipt.providerRef,
            ...(receipt.syncId === undefined ? {} : { syncId: receipt.syncId }),
            ...(write.topicKey === undefined ? {} : { topicKey: write.topicKey }),
            direction: "out",
            kind: write.scope.kind,
            origin: write.origin,
            contentSha256: write.contentSha256,
          },
        ];
  const payload: JsonObject = {
    operationId: row.operationId,
    op: row.op,
    provider: receipt.provider,
    outcome: receipt.outcome,
    truncated: receipt.truncated,
    redacted: receipt.redacted,
    kind: write.scope.kind,
    projectId: row.projectId,
    ...(receipt.providerRef === undefined ? {} : { providerRef: receipt.providerRef }),
    ...(write.sourceRef === undefined ? {} : { sourceRef: write.sourceRef }),
  };
  return { receipt, refs, event: { type: "memory.stored", payload } };
}

// A ping that answers while the real read fails is not healthy (MEM-09).
function isHealthy(health: MemoryHealth): boolean {
  return health.state === "active" && health.realReadOk !== false;
}

function codeOf(health: MemoryHealth): string {
  return health.lastError?.code ?? "Unavailable";
}

// The provider is down; an unknown result it could not resolve (non-retryable) is the row's problem, not the provider's.
function isUnavailable(failure: MemoryFailure): boolean {
  return failure.code === "Unavailable" && failure.retryable;
}
