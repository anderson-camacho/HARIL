import type { Migration } from "./types.js";

// Schema 0009 (docs/modos-y-delegacion.md 4.5): model_stats counts each executor run once. The 0007 view joined every
// task-scope audit of a run's task, so a task judged twice counted its run, tokens and time twice. The view now joins
// one verdict per subject task, the newest, which is also the one that decided its rework. recordAudit refuses a second
// task-scope audit of the same turn from this release on; the newest-verdict rule keeps older databases correct. Only
// the view changes, so the migration is additive.
const SQL = `
DROP VIEW model_stats;
CREATE VIEW model_stats AS
SELECT
  u.model_served AS model,
  u.difficulty_est AS difficulty,
  COUNT(*) AS runs,
  SUM(CASE WHEN a.verdict = 'approved' THEN 1 ELSE 0 END) AS approved,
  SUM(CASE WHEN a.verdict = 'rejected' THEN 1 ELSE 0 END) AS rejected,
  SUM(COALESCE(u.retries, 0)) AS retries,
  SUM(u.tokens_in) AS tokens_in,
  SUM(u.tokens_out) AS tokens_out,
  SUM(u.duration_ms) AS duration_ms
FROM usage_log u
LEFT JOIN (
  SELECT a1.subject_task_id AS subject_task_id, a1.verdict AS verdict
  FROM audits a1
  WHERE a1.scope = 'task'
    AND a1.rowid = (SELECT MAX(a2.rowid) FROM audits a2 WHERE a2.scope = 'task' AND a2.subject_task_id = a1.subject_task_id)
) a ON a.subject_task_id = u.task_id
WHERE u.kind = 'agent_run' AND u.role = 'executor' AND u.simulated = 0
  AND u.model_served IS NOT NULL AND u.difficulty_est IS NOT NULL
GROUP BY u.model_served, u.difficulty_est;
`;

export const MIGRATION_0009: Migration = {
  version: 9,
  name: "model_stats_once",
  kind: "additive",
  sql: SQL,
};
