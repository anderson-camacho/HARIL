import type { Migration } from "./types.js";

// Schema 0015 (docs/modos-y-delegacion.md 3.10.5 and 3.14, phase F8): the processes of the commands a run started
// through haril_run. The host runs them, not the agent, so they are not in the agent's process tree: each is recorded
// with its pid, its start time and, on Linux, its boot ticks, like the agent's own process on its run, so the emergency
// stop, haril workflow stop and the startup sweep find and kill its verified tree. gone_at marks a process verified gone.
// Additive: one new table and its index.
const SQL = `
CREATE TABLE run_commands (
  command_id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  pid INTEGER NOT NULL CHECK (pid > 0),
  started_at INTEGER NOT NULL,
  start_ticks INTEGER,
  boot_id TEXT,
  gone_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_run_commands_run ON run_commands (run_id, command_id);
`;

export const MIGRATION_0015: Migration = {
  version: 15,
  name: "run_commands",
  kind: "additive",
  sql: SQL,
};
