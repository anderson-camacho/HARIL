import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { SchemaValidation } from "./blocks.js";
import { SessionIdSchema, TaskIdSchema } from "./primitives.js";

// Memory contract v1 draft (docs/contracts/memory.md 3; ScopeRef from schemas.md 13). The types the MemoryProvider port
// of the Core speaks: what a write carries, what the provider answers, and the honest capabilities and health of a
// provider. Every loss (dedupe, truncation, redaction, soft forget) is declared in a result, never silent.
// TODO(memory.md 3.2): each schema has a proposed $id (urn:haril:memory.<name>:v1, the key of MEMORY_SCHEMAS below);
// like the other contracts here, the schemas carry no $id until the schema generator of ADR-0018 exists.

// MemoryKind (memory.md 3.3, CM-02): closed when writing. A provider may return another type; it is read as "unknown".
export const MemoryKindSchema = Type.Union([
  Type.Literal("decision"),
  Type.Literal("convention"),
  Type.Literal("preference"),
  Type.Literal("discovery"),
  Type.Literal("pattern"),
  Type.Literal("architecture"),
  Type.Literal("bugfix"),
  Type.Literal("run_summary"),
]);
export type MemoryKind = Static<typeof MemoryKindSchema>;

const ReadKindSchema = Type.Union([MemoryKindSchema, Type.Literal("unknown")]);
export type MemoryReadKind = Static<typeof ReadKindSchema>;

export const MemoryOriginSchema = Type.Union([
  Type.Literal("haril"),
  Type.Literal("agent"),
  Type.Literal("import"),
]);
export type MemoryOrigin = Static<typeof MemoryOriginSchema>;

// personal and global are filter labels, not a privacy boundary, and only with opt-in (ADR-0008 D6.7).
export const VisibilitySchema = Type.Union([
  Type.Literal("project"),
  Type.Literal("personal"),
  Type.Literal("global"),
]);
export type Visibility = Static<typeof VisibilitySchema>;

// MemoryErrorCode (memory.md 3.3): the memory category of HarilError. Only Unavailable is retryable.
export const MemoryErrorCodeSchema = Type.Union([
  Type.Literal("NotFound"),
  Type.Literal("ScopeMismatch"),
  Type.Literal("SessionEnded"),
  Type.Literal("Unavailable"),
  Type.Literal("Unsupported"),
]);
export type MemoryErrorCode = Static<typeof MemoryErrorCodeSchema>;

const Sha256HexSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const EpochMsSchema = Type.Integer({ minimum: 0 });
const CountSchema = Type.Integer({ minimum: 0 });
const NameSchema = Type.String({ minLength: 1 });
// CM-14: Ids.next() at enqueue time, reused on every retry and treated as an opaque string.
const OperationIdSchema = Type.String({ minLength: 1, maxLength: 128 });

// ScopeRef (schemas.md 13): always explicit, never derived from the cwd or Git. workspaceId is the StoreId and
// projectKey the ProjectId [S]; sessionId is HARIL's, not Pi's.
const ScopeFields = {
  workspaceId: NameSchema,
  projectKey: NameSchema,
  visibility: VisibilitySchema,
  sessionId: SessionIdSchema,
  agentId: Type.Optional(NameSchema),
  taskId: Type.Optional(TaskIdSchema),
};

// kind is optional here because a read may cross kinds; a write requires it (MemoryWriteScope).
export const ScopeRefSchema = Type.Object(
  { ...ScopeFields, kind: Type.Optional(NameSchema) },
  { additionalProperties: false },
);
export type ScopeRef = Static<typeof ScopeRefSchema>;

export const MemoryWriteScopeSchema = Type.Object(
  { ...ScopeFields, kind: MemoryKindSchema },
  { additionalProperties: false },
);
export type MemoryWriteScope = Static<typeof MemoryWriteScopeSchema>;

// A stable pointer to a record of one provider (persisted in memory_refs).
export const MemoryRefSchema = Type.Object(
  { provider: NameSchema, providerRef: NameSchema, syncId: Type.Optional(NameSchema) },
  { additionalProperties: false },
);
export type MemoryRef = Static<typeof MemoryRefSchema>;

export const SessionRefSchema = Type.Object(
  {
    provider: NameSchema,
    sessionId: SessionIdSchema,
    providerSessionId: Type.Optional(NameSchema),
  },
  { additionalProperties: false },
);
export type SessionRef = Static<typeof SessionRefSchema>;

export const MemorySessionSchema = Type.Object(
  { ref: SessionRefSchema, scope: ScopeRefSchema, state: Type.Literal("open") },
  { additionalProperties: false },
);
export type MemorySession = Static<typeof MemorySessionSchema>;

// ---- Writes. Every write carries the operationId that makes it idempotent (memory.md 4.1). ----

export const MemoryWriteSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    operationId: OperationIdSchema,
    scope: MemoryWriteScopeSchema,
    title: NameSchema,
    // Already redacted (RF-226).
    content: Type.String(),
    // SHA-256 of content, from the Hasher at enqueue time: it detects a reused operationId (CM-12).
    contentSha256: Sha256HexSchema,
    // Only knowledge that evolves; at most 120 bytes, which the provider checks (06 sec3.6).
    topicKey: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    origin: MemoryOriginSchema,
    sourceRef: Type.Optional(
      Type.Object({ table: NameSchema, id: NameSchema }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);
export type MemoryWrite = Static<typeof MemoryWriteSchema>;

// truncated and redacted are independent flags, not outcomes (CM-01); discarded comes only from Null.
export const WriteReceiptSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    operationId: OperationIdSchema,
    provider: NameSchema,
    providerRef: Type.Optional(NameSchema),
    syncId: Type.Optional(NameSchema),
    outcome: Type.Union([
      Type.Literal("created"),
      Type.Literal("updated"),
      Type.Literal("deduped"),
      Type.Literal("discarded"),
      // Released Engram acknowledges persistence without distinguishing insert/upsert/dedupe.
      Type.Literal("stored"),
    ]),
    truncated: Type.Boolean(),
    redacted: Type.Boolean(),
    originalBytes: Type.Optional(CountSchema),
    limitBytes: Type.Optional(CountSchema),
  },
  { additionalProperties: false },
);
export type WriteReceipt = Static<typeof WriteReceiptSchema>;

// A summary HARIL already generated; it ends the provider session (CM-06).
export const SummarizeWriteSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    operationId: OperationIdSchema,
    scope: ScopeRefSchema,
    session: SessionRefSchema,
    text: Type.String({ minLength: 1 }),
    textSha256: Sha256HexSchema,
  },
  { additionalProperties: false },
);
export type SummarizeWrite = Static<typeof SummarizeWriteSchema>;

const ForgetModeSchema = Type.Union([Type.Literal("soft"), Type.Literal("hard")]);

export const ForgetRequestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    operationId: OperationIdSchema,
    ref: MemoryRefSchema,
    mode: ForgetModeSchema,
    expectedScope: ScopeRefSchema,
    // Informative: the Core already checked the approval of a hard forget.
    authorizedBy: Type.Optional(NameSchema),
  },
  { additionalProperties: false },
);
export type ForgetRequest = Static<typeof ForgetRequestSchema>;

// No MVP provider guarantees an unrecoverable erasure (#1780).
export const ForgetReceiptSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    operationId: OperationIdSchema,
    ref: MemoryRefSchema,
    mode: ForgetModeSchema,
    outcome: Type.Union([Type.Literal("forgotten"), Type.Literal("already_forgotten")]),
    erasure: Type.Union([
      Type.Literal("hidden"),
      Type.Literal("deleted"),
      Type.Literal("deleted_with_residue"),
    ]),
  },
  { additionalProperties: false },
);
export type ForgetReceipt = Static<typeof ForgetReceiptSchema>;

export const ConsolidationRequestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    operationId: OperationIdSchema,
    scope: ScopeRefSchema,
    sources: Type.Array(MemoryRefSchema, { minItems: 2 }),
    // false: only a plan; true: apply the confirmed plan.
    apply: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ConsolidationRequest = Static<typeof ConsolidationRequestSchema>;

export const ConsolidationOutcomeSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    mode: Type.Union([Type.Literal("plan"), Type.Literal("applied")]),
    plan: Type.Optional(
      Type.Object(
        {
          sources: Type.Array(MemoryRefSchema),
          proposedTitle: Type.String(),
          proposedContent: Type.String(),
          needsConfirmation: Type.Literal(true),
        },
        { additionalProperties: false },
      ),
    ),
    receipt: Type.Optional(WriteReceiptSchema),
    forgotten: Type.Optional(Type.Array(ForgetReceiptSchema)),
  },
  { additionalProperties: false },
);
export type ConsolidationOutcome = Static<typeof ConsolidationOutcomeSchema>;

// ---- Reads ----

export const MemoryQuerySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    scope: ScopeRefSchema,
    text: Type.String({ minLength: 1 }),
    kinds: Type.Optional(Type.Array(MemoryKindSchema)),
    matchMode: Type.Union([Type.Literal("all"), Type.Literal("any")]),
    // At most capabilities().maxSearchResults, which the provider checks.
    limit: Type.Integer({ minimum: 1 }),
    includePinned: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type MemoryQuery = Static<typeof MemoryQuerySchema>;

export const MemoryHitSchema = Type.Object(
  {
    ref: MemoryRefSchema,
    kind: ReadKindSchema,
    title: Type.String(),
    snippet: Type.String(),
    score: Type.Union([Type.Number(), Type.Null()]),
    pinned: Type.Boolean(),
    updatedAt: EpochMsSchema,
    topicKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type MemoryHit = Static<typeof MemoryHitSchema>;

// Page<MemoryHit> (schemas.md 4): without next it is the last page; never next while pagination is false.
export const MemoryHitPageSchema = Type.Object(
  { items: Type.Array(MemoryHitSchema), next: Type.Optional(NameSchema) },
  { additionalProperties: false },
);
export type MemoryHitPage = Static<typeof MemoryHitPageSchema>;

export const MemoryRecordSchema = Type.Object(
  {
    ref: MemoryRefSchema,
    scope: ScopeRefSchema,
    kind: ReadKindSchema,
    title: Type.String(),
    content: Type.String(),
    topicKey: Type.Optional(Type.String()),
    pinned: Type.Boolean(),
    revisionCount: Type.Optional(Type.Integer({ minimum: 1 })),
    duplicateCount: Type.Optional(CountSchema),
    createdAt: EpochMsSchema,
    updatedAt: EpochMsSchema,
    deleted: Type.Boolean(),
    // Only with capabilities().versionHistory.
    history: Type.Optional(
      Type.Array(
        Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            title: Type.String(),
            content: Type.String(),
            at: EpochMsSchema,
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);
export type MemoryRecord = Static<typeof MemoryRecordSchema>;

// The budget is in HARIL tokens, not in the provider's bytes.
export const RecallRequestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    scope: ScopeRefSchema,
    budgetTokens: CountSchema,
    query: Type.Optional(Type.String()),
    kinds: Type.Optional(Type.Array(MemoryKindSchema)),
    includePinned: Type.Boolean(),
    maxItems: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type RecallRequest = Static<typeof RecallRequestSchema>;

// Recalled memory is always untrusted, whatever its origin (CM-10; ARCH 9.10).
export const RecallItemSchema = Type.Object(
  {
    ref: MemoryRefSchema,
    kind: ReadKindSchema,
    title: Type.String(),
    content: Type.String(),
    // An upper bound by the injected TokenEstimator.
    tokens: CountSchema,
    trust: Type.Literal("untrusted"),
    pinned: Type.Boolean(),
    updatedAt: EpochMsSchema,
  },
  { additionalProperties: false },
);
export type RecallItem = Static<typeof RecallItemSchema>;

// usedTokens <= budgetTokens and items are whole (MEM-06). degraded is true only when core/memory builds an empty
// bundle in place of an Unavailable provider.
export const RecallBundleSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    scope: ScopeRefSchema,
    budgetTokens: CountSchema,
    usedTokens: CountSchema,
    items: Type.Array(RecallItemSchema),
    omittedCount: CountSchema,
    degraded: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type RecallBundle = Static<typeof RecallBundleSchema>;

// ---- Administration ----

export const ExportFormatSchema = Type.Object(
  { id: Type.Literal("engram-export"), version: NameSchema },
  { additionalProperties: false },
);
export type ExportFormat = Static<typeof ExportFormatSchema>;

// The content never travels in memory: the artifact points at a file under the data root.
export const ExportArtifactSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    format: ExportFormatSchema,
    provider: NameSchema,
    scope: Type.Union([ScopeRefSchema, Type.Literal("all")]),
    path: NameSchema,
    sha256: Sha256HexSchema,
    size: CountSchema,
    recordCount: Type.Union([CountSchema, Type.Null()]),
    createdAt: EpochMsSchema,
  },
  { additionalProperties: false },
);
export type ExportArtifact = Static<typeof ExportArtifactSchema>;

export const ImportReportSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    format: ExportFormatSchema,
    imported: CountSchema,
    updated: CountSchema,
    unchanged: CountSchema,
    rejected: CountSchema,
    records: Type.Array(
      Type.Object({ ref: MemoryRefSchema, kind: ReadKindSchema }, { additionalProperties: false }),
    ),
    recordsTruncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ImportReport = Static<typeof ImportReportSchema>;

// ---- Capabilities and health ----

const NullableName = Type.Union([NameSchema, Type.Null()]);
const NullableLimit = Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]);

// Honest capabilities: what a provider does not support is false and returns Unsupported (MEM-15). With
// providerVersion null every optional capability is false.
export const MemoryCapabilitiesSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    provider: NameSchema,
    providerVersion: NullableName,
    // CM-04: false for Null and InMemory; nothing is queued for a provider that does not persist.
    persistent: Type.Boolean(),
    // false: the provider never returns SessionEnded.
    sessionTracking: Type.Boolean(),
    supportsOperationId: Type.Boolean(),
    topicKeyUpsert: Type.Boolean(),
    versionHistory: Type.Boolean(),
    planConfirmConsolidation: Type.Boolean(),
    conflictJudgment: Type.Boolean(),
    hardDelete: Type.Boolean(),
    ttl: Type.Boolean(),
    semanticSearch: Type.Boolean(),
    searchSyntax: Type.Union([
      Type.Literal("none"),
      Type.Literal("substring"),
      Type.Literal("fts5-trigram"),
    ]),
    maxContentBytes: NullableLimit,
    maxSearchResults: Type.Integer({ minimum: 1 }),
    maxRecallBytes: NullableLimit,
    dedupeWindowMs: Type.Union([CountSchema, Type.Null()]),
    exportVersion: NullableName,
    importVersions: Type.Array(NameSchema),
    pagination: Type.Boolean(),
    visibilities: Type.Array(VisibilitySchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type MemoryCapabilities = Static<typeof MemoryCapabilitiesSchema>;

export const MemoryProviderStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("degraded"),
  Type.Literal("blocked_by_policy"),
]);
export type MemoryProviderState = Static<typeof MemoryProviderStateSchema>;

// health() makes a real read: a ping that answers while a read fails is degraded (MEM-09).
export const MemoryHealthSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    provider: NameSchema,
    state: MemoryProviderStateSchema,
    checkedAt: EpochMsSchema,
    // null: no read was attempted (process not launched yet).
    realReadOk: Type.Union([Type.Boolean(), Type.Null()]),
    version: NullableName,
    instanceId: NullableName,
    dataDir: NullableName,
    lastError: Type.Union([
      Type.Object(
        {
          code: Type.Union([MemoryErrorCodeSchema, Type.Literal("contract.invalid")]),
          at: EpochMsSchema,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type MemoryHealth = Static<typeof MemoryHealthSchema>;

// The memory schemas by the name of their proposed $id (memory.md 3.2; scope-ref from schemas.md 1.5).
const MEMORY_SCHEMAS = {
  "scope-ref": ScopeRefSchema,
  ref: MemoryRefSchema,
  "session-ref": SessionRefSchema,
  session: MemorySessionSchema,
  write: MemoryWriteSchema,
  "write-receipt": WriteReceiptSchema,
  "summarize-write": SummarizeWriteSchema,
  "forget-request": ForgetRequestSchema,
  "forget-receipt": ForgetReceiptSchema,
  "consolidation-request": ConsolidationRequestSchema,
  "consolidation-outcome": ConsolidationOutcomeSchema,
  query: MemoryQuerySchema,
  hit: MemoryHitSchema,
  "hit-page": MemoryHitPageSchema,
  record: MemoryRecordSchema,
  "recall-request": RecallRequestSchema,
  "recall-bundle": RecallBundleSchema,
  "export-format": ExportFormatSchema,
  "export-artifact": ExportArtifactSchema,
  "import-report": ImportReportSchema,
  capabilities: MemoryCapabilitiesSchema,
  health: MemoryHealthSchema,
} as const;

export type MemorySchemaName = keyof typeof MEMORY_SCHEMAS;
export type MemorySchemaValue<N extends MemorySchemaName> = Static<(typeof MEMORY_SCHEMAS)[N]>;

// Schema-level check of an untrusted memory value (the Core has no schema library of its own). Returns readable paths,
// never throws on bad input.
export function validateMemoryValue<N extends MemorySchemaName>(
  name: N,
  value: unknown,
): SchemaValidation<MemorySchemaValue<N>> {
  const schema: TSchema = MEMORY_SCHEMAS[name];
  if (Value.Check(schema, value)) return { ok: true, value: value as MemorySchemaValue<N> };
  const errors = Value.Errors(schema, value).map(
    (error) => `${error.instancePath || "/"}: ${error.message}`,
  );
  return { ok: false, errors };
}
