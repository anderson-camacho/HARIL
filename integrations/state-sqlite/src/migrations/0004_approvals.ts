import type { Migration } from "./types.js";

// Schema 0004 (LD-T3, ARCH 4.3, 9.5, schemas 16): the approvals of a proposed plan. Additive: a new table, so the
// release before it keeps opening the database. `kind` has no CHECK because the contract lets its vocabulary grow.
// A requested approval is the only one without a decision; the partial unique index makes the same plan proposed
// twice in one project a single pending approval.
const SQL = `
CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  subject TEXT NOT NULL CHECK (json_valid(subject)),
  subject_sha256 TEXT NOT NULL CHECK (length(subject_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('requested','granted','denied')),
  requested_at INTEGER NOT NULL,
  requested_by TEXT NOT NULL CHECK (length(trim(requested_by)) > 0),
  decided_at INTEGER,
  decided_by TEXT CHECK (decided_by IS NULL OR length(trim(decided_by)) > 0),
  reason TEXT,
  applied_at INTEGER,
  CHECK (
    (status = 'requested' AND decided_at IS NULL AND decided_by IS NULL)
    OR (status <> 'requested' AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CHECK (applied_at IS NULL OR status <> 'requested')
) STRICT;
CREATE UNIQUE INDEX ux_approvals_pending_subject ON approvals (project_id, kind, subject_sha256) WHERE status = 'requested';
CREATE INDEX ix_approvals_unapplied ON approvals (decided_at) WHERE status <> 'requested' AND applied_at IS NULL;
`;

export const MIGRATION_0004: Migration = {
  version: 4,
  name: "approvals",
  kind: "additive",
  sql: SQL,
};
