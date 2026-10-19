import type { Migration } from "./types.js";

// Schema 0017: persist an auditor's subject separately from the structural parent.
const SQL = `
ALTER TABLE tasks ADD COLUMN audited_task_id TEXT REFERENCES tasks(task_id);
UPDATE tasks
SET audited_task_id = parent_task_id
WHERE role = 'auditor'
  AND parent_task_id IN (SELECT task_id FROM tasks WHERE role = 'executor');
UPDATE tasks AS auditor
SET parent_task_id = (
  SELECT subject.parent_task_id FROM tasks AS subject WHERE subject.task_id = auditor.audited_task_id
)
WHERE role = 'auditor' AND audited_task_id IS NOT NULL;
`;

export const MIGRATION_0017: Migration = {
  version: 17,
  name: "audited_task",
  kind: "additive",
  sql: SQL,
};
