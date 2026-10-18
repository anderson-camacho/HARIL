import type { Migration } from "./types.js";

// Schema 0012 (docs/modos-y-delegacion.md 3.14): a Linux process's start in clock ticks since the boot, with the boot's
// id, kept with the run beside its wall-clock start. On Linux the wall-clock start of a running process is rebuilt as
// "now minus its age", so an NTP or WSL2 clock step made a live agent look like a reused pid; the ticks and the boot id
// never move with the clock. Additive: two nullable columns, filled only on Linux.
const SQL = `
ALTER TABLE runs ADD COLUMN pid_start_ticks INTEGER CHECK (pid_start_ticks IS NULL OR pid_start_ticks >= 0);
ALTER TABLE runs ADD COLUMN pid_boot_id TEXT;
`;

export const MIGRATION_0012: Migration = {
  version: 12,
  name: "process_identity",
  kind: "additive",
  sql: SQL,
};
