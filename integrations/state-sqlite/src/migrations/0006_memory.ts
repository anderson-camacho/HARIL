import type { Migration } from "./types.js";

// Schema 0006 (MC-T4, DATA_MODEL 5.7, task-store.md 4.10): memory_outbox, the only way a write reaches a memory
// provider, and memory_refs, the pointers to what it holds, never its content. Additive: two new tables, so the release
// before it keeps opening the database. The provider state the CLI reads without a runtime lives in the meta keys
// memory.*, which need no schema. operation_id is generated at enqueue time and reused on every retry (ADR-0008 D4); a
// sending row names the epoch that claimed it, so a later runtime can requeue it (MEM-16).
const SQL = `
CREATE TABLE memory_outbox (
  outbox_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE CHECK (length(trim(operation_id)) > 0),
  project_id TEXT REFERENCES projects(project_id),
  op TEXT NOT NULL CHECK (op IN ('store','summarize','forget','consolidate')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  source_table TEXT,
  source_id TEXT,
  session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','delivered','needs_review','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  claimed_runtime_epoch INTEGER REFERENCES runtime_leases(runtime_epoch),
  last_error TEXT,
  receipt TEXT CHECK (receipt IS NULL OR json_valid(receipt)),
  delivered_provider TEXT,
  enqueued_at INTEGER NOT NULL,
  delivered_at INTEGER,
  CHECK ((source_table IS NULL) = (source_id IS NULL)),
  CHECK (status <> 'sending' OR claimed_runtime_epoch IS NOT NULL),
  CHECK (status <> 'delivered' OR (receipt IS NOT NULL AND delivered_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX ux_memory_outbox_source ON memory_outbox (source_table, source_id) WHERE source_table IS NOT NULL;
CREATE INDEX ix_memory_outbox_due ON memory_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX ix_memory_outbox_sending ON memory_outbox (claimed_runtime_epoch) WHERE status = 'sending';

CREATE TABLE memory_refs (
  ref_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  task_id TEXT REFERENCES tasks(task_id),
  run_id TEXT REFERENCES runs(run_id),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  provider_ref TEXT NOT NULL CHECK (length(trim(provider_ref)) > 0),
  sync_id TEXT,
  topic_key TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  origin TEXT NOT NULL CHECK (origin IN ('haril','agent','import')),
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
  operation_id TEXT REFERENCES memory_outbox(operation_id),
  dangling_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, provider_ref)
) STRICT;
CREATE INDEX ix_memory_refs_project ON memory_refs (project_id, created_at);
`;

export const MIGRATION_0006: Migration = {
  version: 6,
  name: "memory",
  kind: "additive",
  sql: SQL,
};
