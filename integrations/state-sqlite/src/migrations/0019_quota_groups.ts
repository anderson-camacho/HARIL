import type { Migration } from "./types.js";

// Quota by group (feature haril-factory, F5). Existing rows keep NULL: each is an account's worst reading of its window,
// which is still what a model with no known group counts against. group_models holds the models the provider says spend
// that group, as a JSON list; account_plan the plan the gateway names.
const SQL = `
ALTER TABLE quota_samples ADD COLUMN group_name TEXT;
ALTER TABLE quota_samples ADD COLUMN group_models TEXT CHECK (group_models IS NULL OR json_valid(group_models));
ALTER TABLE quota_samples ADD COLUMN account_plan TEXT;
`;

export const MIGRATION_0019: Migration = {
  version: 19,
  name: "quota_groups",
  kind: "additive",
  sql: SQL,
};
