import type { Migration } from "./types.js";

// Schema 0011 (docs/modos-y-delegacion.md 3.14): when a run's recorded process was verified gone. The startup sweep and
// the CLI's emergency stop check every run whose process is not verified gone yet, open or ended, so a run a stop
// cancelled while its kill failed stays visible to the next stop and the next start. Additive: one nullable column.
const SQL = `
ALTER TABLE runs ADD COLUMN pid_gone_at INTEGER;
`;

export const MIGRATION_0011: Migration = {
  version: 11,
  name: "process_gone",
  kind: "additive",
  sql: SQL,
};
