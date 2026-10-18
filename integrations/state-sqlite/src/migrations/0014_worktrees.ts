import type { Migration } from "./types.js";

// Schema 0014 (docs/modos-y-delegacion.md 3.10, phase F8): the git worktrees of workflows that write. One row per
// executor thread and one per workflow's integration worktree (thread_id NULL), unique by workflow, kind and thread, so
// recording a worktree again finds its row. head_sha is the last commit HARIL recorded on the branch; merged_at and
// merge_sha say an executor branch was merged into the integration branch. A removed worktree keeps its row (state
// removed) as history, and the snapshot still names its branch. Additive: one new table and its indexes.
const SQL = `
CREATE TABLE worktrees (
  worktree_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  kind TEXT NOT NULL CHECK (kind IN ('executor','integration')),
  thread_id TEXT CHECK (thread_id IS NULL OR length(trim(thread_id)) > 0),
  path TEXT NOT NULL CHECK (length(trim(path)) > 0),
  branch TEXT NOT NULL CHECK (length(trim(branch)) > 0),
  base_sha TEXT NOT NULL CHECK (length(base_sha) BETWEEN 7 AND 64),
  head_sha TEXT,
  merged_at INTEGER,
  merge_sha TEXT,
  state TEXT NOT NULL CHECK (state IN ('active','removed')),
  created_at INTEGER NOT NULL,
  removed_at INTEGER,
  CHECK ((kind = 'integration') = (thread_id IS NULL)),
  CHECK ((state = 'removed') = (removed_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX ux_worktrees_owner ON worktrees (workflow_id, kind, IFNULL(thread_id, ''));
CREATE INDEX ix_worktrees_state ON worktrees (state, created_at);
`;

export const MIGRATION_0014: Migration = {
  version: 14,
  name: "worktrees",
  kind: "additive",
  sql: SQL,
};
