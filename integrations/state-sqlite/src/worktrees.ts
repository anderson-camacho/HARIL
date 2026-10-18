import type { DatabaseSync } from "node:sqlite";
import type {
  AppendEventInput,
  Clock,
  EventRecord,
  Ids,
  RecordWorktreeInput,
  WorktreeRecord,
  WorktreesPort,
} from "@haril/core/ports";
import { StoreError } from "./errors.js";

// The worktrees table (docs/modos-y-delegacion.md 3.10, phase F8; migration 0014): the runtime records each git worktree
// it makes for a workflow that writes, and what happens to its branch. The store only records: git runs in the runtime.
// Each write is one transaction fenced by the runtime epoch, with an event that carries ids and branch names only.

interface WorktreesFacetOptions {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly transaction: <T>(work: () => T) => T;
  readonly appendEvent: (input: AppendEventInput) => EventRecord;
  readonly assertActiveEpoch: (epoch: number) => void;
}

const COLUMNS =
  "worktree_id AS worktreeId, workflow_id AS workflowId, kind, thread_id AS threadId, path, branch, base_sha AS baseSha, head_sha AS headSha, merged_at AS mergedAt, merge_sha AS mergeSha, state, created_at AS createdAt, removed_at AS removedAt";

export function createWorktreesFacet(options: WorktreesFacetOptions): WorktreesPort {
  const { db, clock, ids, transaction, appendEvent, assertActiveEpoch } = options;

  const find = (worktreeId: string): WorktreeRecord | undefined =>
    db.prepare(`SELECT ${COLUMNS} FROM worktrees WHERE worktree_id = ?`).get(worktreeId) as
      | WorktreeRecord
      | undefined;

  const require = (worktreeId: string): WorktreeRecord => {
    const record = find(worktreeId);
    if (record === undefined) {
      throw new StoreError("store.not_found", `no worktree with id "${worktreeId}"`, {
        worktreeId,
      });
    }
    return record;
  };

  const projectOf = (workflowId: string): string => {
    const row = db
      .prepare("SELECT project_id AS projectId FROM workflows WHERE workflow_id = ?")
      .get(workflowId) as { projectId: string } | undefined;
    if (row === undefined) {
      throw new StoreError("store.not_found", `no workflow with id "${workflowId}"`, {
        workflowId,
      });
    }
    return row.projectId;
  };

  const event = (record: WorktreeRecord, type: string, epoch: number, payload: object): void => {
    appendEvent({
      aggregateType: "workflow",
      aggregateId: record.workflowId,
      type,
      actorKind: "system",
      actorId: `runtime:${epoch}`,
      payload: {
        worktreeId: record.worktreeId,
        kind: record.kind,
        branch: record.branch,
        ...payload,
      },
      projectId: projectOf(record.workflowId),
    });
  };

  return {
    record: (epoch, input: RecordWorktreeInput) =>
      transaction(() => {
        assertActiveEpoch(epoch);
        projectOf(input.workflowId);
        const existing = db
          .prepare(
            `SELECT ${COLUMNS} FROM worktrees WHERE workflow_id = ? AND kind = ? AND IFNULL(thread_id, '') = ?`,
          )
          .get(input.workflowId, input.kind, input.threadId ?? "") as WorktreeRecord | undefined;
        if (existing !== undefined) {
          if (existing.state === "active" && existing.path === input.path) return existing;
          db.prepare(
            "UPDATE worktrees SET path = ?, branch = ?, state = 'active', removed_at = NULL WHERE worktree_id = ?",
          ).run(input.path, input.branch, existing.worktreeId);
          const revived = require(existing.worktreeId);
          event(revived, "worktree.created", epoch, { again: true });
          return revived;
        }
        const worktreeId = ids.next();
        db.prepare(
          "INSERT INTO worktrees (worktree_id, workflow_id, kind, thread_id, path, branch, base_sha, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)",
        ).run(
          worktreeId,
          input.workflowId,
          input.kind,
          input.threadId,
          input.path,
          input.branch,
          input.baseSha,
          clock.now(),
        );
        const created = require(worktreeId);
        event(created, "worktree.created", epoch, {});
        return created;
      }),
    setHead: (epoch, worktreeId, headSha) =>
      transaction(() => {
        assertActiveEpoch(epoch);
        require(worktreeId);
        db.prepare("UPDATE worktrees SET head_sha = ? WHERE worktree_id = ?").run(
          headSha,
          worktreeId,
        );
      }),
    markMerged: (epoch, worktreeId, mergeSha) =>
      transaction(() => {
        assertActiveEpoch(epoch);
        const record = require(worktreeId);
        db.prepare("UPDATE worktrees SET merged_at = ?, merge_sha = ? WHERE worktree_id = ?").run(
          clock.now(),
          mergeSha,
          worktreeId,
        );
        event(record, "worktree.merged", epoch, { mergeSha });
      }),
    markRemoved: (epoch, worktreeId) =>
      transaction(() => {
        assertActiveEpoch(epoch);
        const record = require(worktreeId);
        if (record.state === "removed") return;
        db.prepare(
          "UPDATE worktrees SET state = 'removed', removed_at = ? WHERE worktree_id = ?",
        ).run(clock.now(), worktreeId);
        event(record, "worktree.removed", epoch, {});
      }),
    get: find,
    list: (filter = {}) =>
      db
        .prepare(
          `SELECT ${COLUMNS} FROM worktrees WHERE (? IS NULL OR workflow_id = ?) AND (? IS NULL OR kind = ?) AND (? IS NULL OR state = ?) ORDER BY created_at, rowid`,
        )
        .all(
          filter.workflowId ?? null,
          filter.workflowId ?? null,
          filter.kind ?? null,
          filter.kind ?? null,
          filter.state ?? null,
          filter.state ?? null,
        ) as unknown as WorktreeRecord[],
  };
}
