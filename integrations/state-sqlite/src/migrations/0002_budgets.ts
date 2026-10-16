import type { Migration } from "./types.js";

// Schema 0002 (M2-T2, docs/DATA_MODEL.md 5.4 and 5.5, subset): token budgets, the append-only budget ledger
// and virtual keys (ADR-0005 BR-3, BR-5, BR-8). Additive: nothing of schema 0001 changes. Columns that M2 does
// not use yet (currency, period_end, runtime_epoch, max_requests) are left out until their milestone.
const SQL = `
CREATE TABLE budgets (
  budget_id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('project','task','agent','provider')),
  scope_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  unit TEXT NOT NULL CHECK (unit = 'tokens'),
  period_start INTEGER NOT NULL DEFAULT 0,
  hard_limit INTEGER NOT NULL CHECK (hard_limit >= 0),
  spent INTEGER NOT NULL DEFAULT 0 CHECK (spent >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  overrun INTEGER NOT NULL DEFAULT 0 CHECK (overrun >= 0),
  CHECK (spent + reserved <= hard_limit),
  UNIQUE (scope_type, scope_id, unit, period_start)
) STRICT;

CREATE TABLE budget_ledger (
  entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  budget_id TEXT NOT NULL REFERENCES budgets(budget_id),
  reservation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reserve','commit','release','adjust')),
  amount INTEGER NOT NULL CHECK (kind = 'adjust' OR amount >= 0),
  unreconciled INTEGER NOT NULL DEFAULT 0 CHECK (unreconciled IN (0,1)),
  cost_source TEXT NOT NULL,
  route_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  tokens_input INTEGER,
  tokens_output INTEGER,
  model_requested TEXT,
  model_served TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX budget_ledger_by_reservation ON budget_ledger (reservation_id);
CREATE TRIGGER budget_ledger_no_update BEFORE UPDATE ON budget_ledger BEGIN SELECT RAISE(ABORT, 'budget_ledger is append-only'); END;
CREATE TRIGGER budget_ledger_no_delete BEFORE DELETE ON budget_ledger BEGIN SELECT RAISE(ABORT, 'budget_ledger is append-only'); END;

CREATE TABLE virtual_keys (
  key_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  key_hash TEXT NOT NULL UNIQUE,
  route_grant TEXT NOT NULL,
  budget_ids TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX virtual_keys_one_active_per_run ON virtual_keys (run_id) WHERE revoked_at IS NULL;
`;

export const MIGRATION_0002: Migration = {
  version: 2,
  name: "budgets",
  kind: "additive",
  sql: SQL,
};
