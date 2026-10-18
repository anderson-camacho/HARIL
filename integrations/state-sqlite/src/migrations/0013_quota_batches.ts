import type { Migration } from "./types.js";

// Schema 0013 (docs/modos-y-delegacion.md 3.11, 4.2; ADR-0021 S1, S2, P25; phase F6): what a quota reading needs beyond
// the 0007 columns. batch_id groups the rows of one sampling, so "the newest reading of a provider" is one batch; the
// account's kind (claude, antigravity...) and its model prefix (S2: the prefix routes a request to that account) let the
// runtime map a model to its account; note says why a window is missing ("sin dato"). Additive: four nullable columns
// and an index.
const SQL = `
ALTER TABLE quota_samples ADD COLUMN batch_id TEXT;
ALTER TABLE quota_samples ADD COLUMN account_kind TEXT;
ALTER TABLE quota_samples ADD COLUMN account_prefix TEXT;
ALTER TABLE quota_samples ADD COLUMN note TEXT;
CREATE INDEX ix_quota_samples_batch ON quota_samples (provider, batch_id);
`;

export const MIGRATION_0013: Migration = {
  version: 13,
  name: "quota_batches",
  kind: "additive",
  sql: SQL,
};
