import type { Migration } from "./types.js";

// Schema 0007 (docs/modos-y-delegacion.md 4.1, 4.2 and 4.5; ADR-0021): the three-layer delegation and the orders and
// usage logs. Additive: new tables, one view and nullable task columns; no existing row changes. A release before it
// still refuses the migrated database, as every release refuses a schema newer than it knows (open.ts).
//   - workflows: one run of the Delegation mode, with the autonomy and the limits it started with (a snapshot).
//   - delegations: every applied proposal (haril_delegate, haril_assign, haril_request_audit); payload_hash deduplicates
//     a replay after a restart (3.8 rule 6). Immutable.
//   - audits: every auditor verdict and what the rework machine did with it (3.8). Immutable.
//   - model_cooldowns and quota_samples: the quota rule's inputs (3.11); written from phase F6.
//   - orders and usage_log: append-only, hash-chained logs (4.5). Each row stores the hash of the previous row of its
//     table and its own hash (sha256 of the previous hash and the canonical JSON of the row), so editing or deleting a
//     row by hand is detected by `haril usage verify`. seq gives the total order of the chain. tokens_* NULL means "not
//     reported", never 0. A log never refuses a row over a missing reference, so its ids are plain text, except
//     usage_log.order_id, which names an order of the same database.
//   - model_stats: a view over usage_log and audits, so the difficulty table has a single source of truth.
// New task columns: the workflow, layer, role and thread of a delegated turn, its difficulty, whether its model was
// pinned by the user, the watchdog's next check (3.16), and the local id and delegation that created it (the local id
// names the node of an after_node stop; the delegation lets a replayed proposal find what it created). runs already has
// pid and pid_started_at (0001), the columns the startup sweep of 3.14 needs.
const SQL = `
CREATE TABLE workflows (
  workflow_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  root_task_id TEXT REFERENCES tasks(task_id),
  goal TEXT NOT NULL CHECK (length(trim(goal)) > 0),
  state TEXT NOT NULL CHECK (state IN ('running','awaiting_human','completed','failed','stopped')),
  autonomy TEXT NOT NULL CHECK (json_valid(autonomy)),
  limits TEXT NOT NULL CHECK (json_valid(limits)),
  orchestrator_model TEXT NOT NULL CHECK (length(trim(orchestrator_model)) > 0),
  agents_created INTEGER NOT NULL DEFAULT 0 CHECK (agents_created >= 0),
  stop_reason TEXT,
  base_branch TEXT,
  base_sha TEXT,
  simulated INTEGER NOT NULL DEFAULT 0 CHECK (simulated IN (0,1)),
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  CHECK ((state IN ('completed','failed','stopped')) = (ended_at IS NOT NULL))
) STRICT;
CREATE INDEX ix_workflows_project ON workflows (project_id, created_at);

CREATE TABLE delegations (
  delegation_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
  parent_task_id TEXT REFERENCES tasks(task_id),
  proposed_by_run_id TEXT REFERENCES runs(run_id),
  tool TEXT NOT NULL CHECK (tool IN ('haril_delegate','haril_assign','haril_request_audit')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  memo TEXT CHECK (memo IS NULL OR length(memo) <= 2000),
  created_at INTEGER NOT NULL,
  UNIQUE (workflow_id, thread_id, payload_hash)
) STRICT;
CREATE TRIGGER delegations_no_update BEFORE UPDATE ON delegations BEGIN SELECT RAISE(ABORT, 'delegations is append-only'); END;
CREATE TRIGGER delegations_no_delete BEFORE DELETE ON delegations BEGIN SELECT RAISE(ABORT, 'delegations is append-only'); END;

ALTER TABLE tasks ADD COLUMN workflow_id TEXT REFERENCES workflows(workflow_id);
ALTER TABLE tasks ADD COLUMN layer INTEGER CHECK (layer IS NULL OR layer BETWEEN 1 AND 3);
ALTER TABLE tasks ADD COLUMN role TEXT CHECK (role IS NULL OR role IN ('orchestrator','delegator','executor','auditor'));
ALTER TABLE tasks ADD COLUMN thread_id TEXT CHECK (thread_id IS NULL OR length(trim(thread_id)) > 0);
ALTER TABLE tasks ADD COLUMN difficulty TEXT CHECK (difficulty IS NULL OR difficulty IN ('trivial','easy','medium','hard','expert'));
ALTER TABLE tasks ADD COLUMN difficulty_reason TEXT;
ALTER TABLE tasks ADD COLUMN model_pinned INTEGER NOT NULL DEFAULT 0 CHECK (model_pinned IN (0,1));
ALTER TABLE tasks ADD COLUMN next_check_at INTEGER;
ALTER TABLE tasks ADD COLUMN local_id TEXT;
ALTER TABLE tasks ADD COLUMN delegation_id TEXT REFERENCES delegations(delegation_id);
CREATE INDEX ix_tasks_workflow ON tasks (workflow_id, created_seq) WHERE workflow_id IS NOT NULL;
CREATE INDEX ix_tasks_thread ON tasks (thread_id, created_seq) WHERE thread_id IS NOT NULL;

CREATE TABLE audits (
  audit_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  subject_task_id TEXT REFERENCES tasks(task_id),
  auditor_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  scope TEXT NOT NULL CHECK (scope IN ('task','workflow')),
  verdict TEXT NOT NULL CHECK (verdict IN ('approved','rejected')),
  reasons TEXT NOT NULL CHECK (json_valid(reasons)),
  rework_action TEXT CHECK (rework_action IS NULL OR rework_action IN ('accept','retry','escalate','fail','ignore')),
  created_at INTEGER NOT NULL,
  CHECK ((scope = 'task') = (subject_task_id IS NOT NULL))
) STRICT;
CREATE INDEX ix_audits_workflow ON audits (workflow_id, created_at);
CREATE TRIGGER audits_no_update BEFORE UPDATE ON audits BEGIN SELECT RAISE(ABORT, 'audits is append-only'); END;
CREATE TRIGGER audits_no_delete BEFORE DELETE ON audits BEGIN SELECT RAISE(ABORT, 'audits is append-only'); END;

CREATE TABLE model_cooldowns (
  model TEXT PRIMARY KEY CHECK (length(trim(model)) > 0),
  until INTEGER NOT NULL,
  reason TEXT NOT NULL
) STRICT;

CREATE TABLE quota_samples (
  sample_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  credential_ref TEXT,
  window TEXT NOT NULL CHECK (window IN ('5h','7d')),
  used_pct REAL CHECK (used_pct IS NULL OR used_pct >= 0),
  resets_at INTEGER,
  sampled_at INTEGER NOT NULL,
  source TEXT NOT NULL
) STRICT;
CREATE INDEX ix_quota_samples_provider ON quota_samples (provider, sampled_at);

CREATE TABLE orders (
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  order_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('accion','consulta','plan','delegacion','cli')),
  source TEXT NOT NULL CHECK (source IN ('chat','cli','workflow')),
  workflow_id TEXT,
  project_id TEXT,
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
  text_chars INTEGER NOT NULL CHECK (text_chars >= 0),
  preview TEXT CHECK (preview IS NULL OR length(preview) <= 200),
  idempotency_key TEXT UNIQUE,
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash TEXT NOT NULL CHECK (length(hash) = 64)
) STRICT;
CREATE INDEX ix_orders_ts ON orders (ts);
CREATE TRIGGER orders_no_update BEFORE UPDATE ON orders BEGIN SELECT RAISE(ABORT, 'orders is append-only'); END;
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'orders is append-only'); END;

CREATE TABLE usage_log (
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  usage_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  order_id TEXT REFERENCES orders(order_id),
  kind TEXT NOT NULL CHECK (kind IN ('chat','agent_run')),
  session_id TEXT,
  project_id TEXT,
  workflow_id TEXT,
  task_id TEXT,
  run_id TEXT,
  thread_id TEXT,
  layer INTEGER CHECK (layer IS NULL OR layer BETWEEN 1 AND 3),
  role TEXT CHECK (role IS NULL OR role IN ('orchestrator','delegator','executor','auditor')),
  mode TEXT CHECK (mode IS NULL OR mode IN ('accion','consulta','plan','delegacion','cli')),
  provider TEXT,
  model_requested TEXT,
  model_served TEXT,
  model_pinned INTEGER NOT NULL DEFAULT 0 CHECK (model_pinned IN (0,1)),
  tokens_in INTEGER CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out INTEGER CHECK (tokens_out IS NULL OR tokens_out >= 0),
  tokens_cached INTEGER CHECK (tokens_cached IS NULL OR tokens_cached >= 0),
  tokens_reasoning INTEGER CHECK (tokens_reasoning IS NULL OR tokens_reasoning >= 0),
  cost_micros INTEGER CHECK (cost_micros IS NULL OR cost_micros >= 0),
  unreconciled INTEGER NOT NULL DEFAULT 0 CHECK (unreconciled IN (0,1)),
  started_at INTEGER,
  ended_at INTEGER,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  difficulty_est TEXT CHECK (difficulty_est IS NULL OR difficulty_est IN ('trivial','easy','medium','hard','expert')),
  difficulty_reason TEXT,
  outcome TEXT,
  audit_verdict TEXT CHECK (audit_verdict IS NULL OR audit_verdict IN ('approved','rejected')),
  retries INTEGER CHECK (retries IS NULL OR retries >= 0),
  simulated INTEGER NOT NULL DEFAULT 0 CHECK (simulated IN (0,1)),
  idempotency_key TEXT UNIQUE,
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash TEXT NOT NULL CHECK (length(hash) = 64)
) STRICT;
CREATE INDEX ix_usage_log_ts ON usage_log (ts);
CREATE INDEX ix_usage_log_workflow ON usage_log (workflow_id, seq) WHERE workflow_id IS NOT NULL;
CREATE TRIGGER usage_log_no_update BEFORE UPDATE ON usage_log BEGIN SELECT RAISE(ABORT, 'usage_log is append-only'); END;
CREATE TRIGGER usage_log_no_delete BEFORE DELETE ON usage_log BEGIN SELECT RAISE(ABORT, 'usage_log is append-only'); END;

CREATE VIEW model_stats AS
SELECT
  u.model_served AS model,
  u.difficulty_est AS difficulty,
  COUNT(*) AS runs,
  SUM(CASE WHEN a.verdict = 'approved' THEN 1 ELSE 0 END) AS approved,
  SUM(CASE WHEN a.verdict = 'rejected' THEN 1 ELSE 0 END) AS rejected,
  SUM(COALESCE(u.retries, 0)) AS retries,
  SUM(u.tokens_in) AS tokens_in,
  SUM(u.tokens_out) AS tokens_out,
  SUM(u.duration_ms) AS duration_ms
FROM usage_log u
LEFT JOIN audits a ON a.subject_task_id = u.task_id AND a.scope = 'task'
WHERE u.kind = 'agent_run' AND u.role = 'executor' AND u.simulated = 0
  AND u.model_served IS NOT NULL AND u.difficulty_est IS NOT NULL
GROUP BY u.model_served, u.difficulty_est;
`;

export const MIGRATION_0007: Migration = {
  version: 7,
  name: "delegation",
  kind: "additive",
  sql: SQL,
};
