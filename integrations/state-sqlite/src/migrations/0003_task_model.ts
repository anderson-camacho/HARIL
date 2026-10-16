import type { Migration } from "./types.js";

// Schema 0003 (M2-T6): the model a real-agent task asks for, read by the claim and shown by `haril task show`.
// Additive: one nullable column on tasks; existing rows keep NULL (no model), which is the simulated agents' case.
const SQL = `
ALTER TABLE tasks ADD COLUMN model TEXT CHECK (model IS NULL OR length(trim(model)) > 0);
`;

export const MIGRATION_0003: Migration = {
  version: 3,
  name: "task_model",
  kind: "additive",
  sql: SQL,
};
