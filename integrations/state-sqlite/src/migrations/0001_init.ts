import type { Migration } from "./types.js";

// Schema 0001 (M1 subset of docs/DATA_MODEL.md section 5, Store v1 draft). Tables are STRICT.
// Columns marked TODO(DATA_MODEL) are guesses that the M1 tests do not exercise yet.
const SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('additive','incompatible')),
  applied_at INTEGER NOT NULL,
  applied_by_release TEXT NOT NULL
) STRICT;

CREATE TABLE runtime_leases (
  runtime_epoch INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_name TEXT NOT NULL DEFAULT 'root' CHECK (lease_name = 'root'),
  instance_id TEXT NOT NULL UNIQUE,
  pid INTEGER NOT NULL,
  pid_started_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','released','lost')),
  clean_exit INTEGER CHECK (clean_exit IN (0,1)),
  released_at INTEGER,
  node_version TEXT NOT NULL,
  sqlite_version TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_runtime_leases_active ON runtime_leases (lease_name) WHERE status = 'active';

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  owner_epoch INTEGER NOT NULL DEFAULT 0,
  manifest_sha256 TEXT,
  manifest_json TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json)),
  trusted_at INTEGER,
  closed_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(project_id),
  type TEXT NOT NULL,
  args TEXT NOT NULL CHECK (json_valid(args)),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','applied','rejected')),
  enqueued_at INTEGER NOT NULL,
  applied_at INTEGER,
  applied_runtime_epoch INTEGER,
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  reject_reason TEXT
) STRICT;
CREATE INDEX ix_commands_queued ON commands (enqueued_at) WHERE status = 'queued';

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','agent','system')),
  actor_id TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  audit INTEGER NOT NULL DEFAULT 0 CHECK (audit IN (0,1)),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 65536),
  project_id TEXT, task_id TEXT, run_id TEXT, agent_id TEXT
) STRICT;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE INDEX ix_events_aggregate ON events (aggregate_type, aggregate_id, seq);
CREATE INDEX ix_events_project ON events (project_id, seq);
CREATE INDEX ix_events_type ON events (type, seq);

-- TODO(DATA_MODEL): plans columns come from DATA_MODEL section 5.8 candidates; not yet fixed by Store v1.
CREATE TABLE plans (
  plan_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  root_plan_id TEXT REFERENCES plans(plan_id),
  parent_plan_id TEXT REFERENCES plans(plan_id),
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0),
  submitted_by_task_id TEXT REFERENCES tasks(task_id),
  replans_used INTEGER NOT NULL DEFAULT 0 CHECK (replans_used >= 0),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  parent_task_id TEXT REFERENCES tasks(task_id),
  plan_id TEXT REFERENCES plans(plan_id),
  root_plan_id TEXT REFERENCES plans(plan_id),
  goal TEXT NOT NULL,
  description TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),
  kind TEXT NOT NULL CHECK (kind IN ('work','plan','verify','summarize')),
  agent_ref TEXT NOT NULL,
  requires TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(requires)),
  context TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(context)),
  surface_write TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(surface_write)),
  surface_read TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(surface_read)),
  route TEXT CHECK (route IS NULL OR json_valid(route)),
  budget_max_cost_micros INTEGER NOT NULL CHECK (budget_max_cost_micros >= 0),
  budget_max_tokens INTEGER NOT NULL CHECK (budget_max_tokens >= 0),
  budget_max_wall_ms INTEGER NOT NULL CHECK (budget_max_wall_ms >= 0),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending','ready','running','blocked','completed','failed','cancelled')),
  phase TEXT CHECK (phase IN ('executing','verifying','integrating','recovering')),
  block_reason TEXT CHECK (block_reason IN ('awaiting_human','needs_authorization','budget','cooldown',
    'surface_conflict','dep_failed','memory_unavailable','no_route','sandbox_unavailable','block_unavailable')),
  retry_reason TEXT CHECK (retry_reason IN ('transient','orphaned','verify_failed','route_failover')),
  cooldown_until INTEGER,
  acceptance TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acceptance)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  requires_memory INTEGER NOT NULL DEFAULT 0 CHECK (requires_memory IN (0,1)),
  data_class TEXT CHECK (data_class IS NULL OR data_class IN ('public','internal','secret')),
  escalation_level INTEGER NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  verify_retries INTEGER NOT NULL DEFAULT 0 CHECK (verify_retries >= 0),
  denials TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(denials)),
  wall_used_ms INTEGER NOT NULL DEFAULT 0 CHECK (wall_used_ms >= 0),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  attempts_used INTEGER NOT NULL DEFAULT 0,
  claim_epoch INTEGER NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
  claimed_runtime_epoch INTEGER REFERENCES runtime_leases(runtime_epoch),
  infra_restarts INTEGER NOT NULL DEFAULT 0 CHECK (infra_restarts >= 0),
  created_seq INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (attempts_used >= 0 AND attempts_used <= attempt AND attempts_used <= max_attempts),
  CHECK ((state = 'running') = (phase IS NOT NULL)),
  CHECK ((state = 'blocked') = (block_reason IS NOT NULL)),
  CHECK (cooldown_until IS NULL OR block_reason = 'cooldown'),
  CHECK (state <> 'running' OR (claim_epoch > 0 AND claimed_runtime_epoch IS NOT NULL AND route IS NOT NULL)),
  CHECK (state <> 'completed' OR result IS NOT NULL)
) STRICT;
CREATE INDEX ix_tasks_claimable ON tasks (priority DESC, created_seq) WHERE state = 'ready';
CREATE INDEX ix_tasks_project_state ON tasks (project_id, state);
CREATE INDEX ix_tasks_running_epoch ON tasks (claimed_runtime_epoch) WHERE state = 'running';
CREATE INDEX ix_tasks_cooldown ON tasks (cooldown_until) WHERE block_reason = 'cooldown';

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  kind TEXT NOT NULL DEFAULT 'completed' CHECK (kind IN ('completed')),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
) STRICT;
CREATE INDEX ix_task_deps_reverse ON task_dependencies (depends_on_task_id);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  session_id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL, -- TODO(DATA_MODEL): no FK until agents columns are fixed
  status TEXT NOT NULL CHECK (status IN ('prepared','running','settled','completed','failed',
    'cancelled','orphaned','blocked')),
  handshake_at INTEGER,
  runtime_epoch INTEGER NOT NULL REFERENCES runtime_leases(runtime_epoch),
  claim_epoch INTEGER NOT NULL,
  pid INTEGER,
  pid_started_at INTEGER,
  started_at INTEGER,
  ended_at INTEGER,
  exit_code INTEGER,
  end_cause TEXT CHECK (end_cause IS NULL OR end_cause IN ('exit','timeout','cancelled','output_limit')),
  agent_runtime TEXT,
  agent_runtime_version TEXT,
  pi_session_ref TEXT,
  route_requested TEXT,
  route_served TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  created_at INTEGER NOT NULL,
  UNIQUE (task_id, attempt)
) STRICT;
CREATE INDEX ix_runs_active ON runs (runtime_epoch) WHERE status IN ('prepared','running','settled');
CREATE INDEX ix_runs_agent ON runs (agent_id, started_at);
`;

export const MIGRATION_0001: Migration = {
  version: 1,
  name: "0001_init",
  kind: "additive",
  sql: SQL,
};
