import type { Migration } from "./types.js";

// Schema 0016 (docs/modos-y-delegacion.md 3.10, phase F8, release 0.20.1): an executor branch's last commit HARIL
// verified. The runtime records where a step started (the base commit, with its predecessors' work merged) and each
// commit the end of a successful turn checked; a retry starts there, and a turn that does not succeed puts the branch
// back there, never on a HEAD a command moved. NULL for the integration worktree and for the rows made before.
// Additive: one new nullable column.
const SQL = `
ALTER TABLE worktrees ADD COLUMN verified_sha TEXT;
`;

export const MIGRATION_0016: Migration = {
  version: 16,
  name: "worktree_verified",
  kind: "additive",
  sql: SQL,
};
