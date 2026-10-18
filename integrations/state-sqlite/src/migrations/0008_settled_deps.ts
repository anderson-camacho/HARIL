import type { Migration } from "./types.js";

// Schema 0008 (docs/modos-y-delegacion.md 3.7, 4.1): a dependency of kind 'settled' is met once its task is completed,
// failed, cancelled or blocked by an earlier failure, so a continuation runs even when one of its children failed and
// the parent decides what to do. SQLite cannot alter a CHECK, so task_dependencies is rebuilt: new table, copy, drop,
// rename, and the reverse index again. Nothing references task_dependencies, so the rebuild keeps every foreign key.
// The copy keeps rowid order, which is the order the dependencies were declared in (readers order by rowid).
// Incompatible: a release before it would write only 'completed' but could not read the rows this one writes. P2 keeps
// the workflow budget as a task-scope budget on the root task, so budgets is not rebuilt.
const SQL = `
CREATE TABLE task_dependencies_0008 (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  kind TEXT NOT NULL DEFAULT 'completed' CHECK (kind IN ('completed','settled')),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
) STRICT;
INSERT INTO task_dependencies_0008 (task_id, depends_on_task_id, kind)
  SELECT task_id, depends_on_task_id, kind FROM task_dependencies ORDER BY rowid;
DROP TABLE task_dependencies;
ALTER TABLE task_dependencies_0008 RENAME TO task_dependencies;
CREATE INDEX ix_task_deps_reverse ON task_dependencies (depends_on_task_id);
`;

export const MIGRATION_0008: Migration = {
  version: 8,
  name: "settled_deps",
  kind: "incompatible",
  sql: SQL,
};
