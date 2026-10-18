import type { Migration } from "./types.js";

// Schema 0010 (docs/modos-y-delegacion.md 3.5, 3.8, 4.5; phase F2): what the runtime of a workflow reads back after a
// restart. delegations.payload keeps the applied proposal as the agent sent it (its acceptance criteria, tests, files and
// dependencies), so an auditor turn, a relaunch or a reformulation that starts after a restart still knows the
// assignment; the payload hash keeps deduplicating replays. workflows.order_id names the order (4.5) behind a workflow
// started from the CLI, so every agent_run row of the workflow points at it. Additive: two nullable columns.
const SQL = `
ALTER TABLE delegations ADD COLUMN payload TEXT CHECK (payload IS NULL OR json_valid(payload));
ALTER TABLE workflows ADD COLUMN order_id TEXT;
`;

export const MIGRATION_0010: Migration = {
  version: 10,
  name: "delegation_runtime",
  kind: "additive",
  sql: SQL,
};
