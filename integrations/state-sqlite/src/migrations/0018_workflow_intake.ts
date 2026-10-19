import type { Migration } from "./types.js";

// Existing workflows retain NULL; every newly applied workflow.start must provide a complete intake snapshot.
const SQL = `
ALTER TABLE workflows ADD COLUMN intake TEXT CHECK (intake IS NULL OR json_valid(intake));
`;

export const MIGRATION_0018: Migration = {
  version: 18,
  name: "workflow_intake",
  kind: "additive",
  sql: SQL,
};
