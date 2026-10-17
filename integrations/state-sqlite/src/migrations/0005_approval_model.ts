import type { Migration } from "./types.js";

// Schema 0005 (LD-T7a): the model of the task that proposed a plan. A granted plan gives it to every task it creates,
// so the plan's tasks run with the planner's model. Additive: one nullable column on approvals; existing rows keep
// NULL (no model), which is also the case of a plan proposed at the terminal.
const SQL = `
ALTER TABLE approvals ADD COLUMN model TEXT CHECK (model IS NULL OR length(trim(model)) > 0);
`;

export const MIGRATION_0005: Migration = {
  version: 5,
  name: "approval_model",
  kind: "additive",
  sql: SQL,
};
