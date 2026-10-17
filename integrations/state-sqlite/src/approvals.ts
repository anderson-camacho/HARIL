import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AppendEventInput,
  ApprovalFilter,
  ApprovalRecord,
  ApprovalsPort,
  Clock,
  EventRecord,
  HarilError,
  Ids,
  JsonObject,
  Result,
  StoreRules,
} from "@haril/core/ports";
import { StoreError } from "./errors.js";

// Approvals of a proposed plan (LD-T3, ARCH 4.3, 9.5, schemas 16). Every write runs in the transaction the store hands
// in. The decision is an admin write with no epoch; markApplied is the runtime's write and is fenced by its epoch.

interface ApprovalFacetOptions {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly rules: Pick<StoreRules, "checkPlan" | "canonicalJson">;
  readonly transaction: <T>(work: () => T) => T;
  readonly appendEvent: (input: AppendEventInput) => EventRecord;
  readonly assertActiveEpoch: (epoch: number) => void;
}

const APPROVAL_COLUMNS =
  "approval_id AS approvalId, project_id AS projectId, kind, subject, subject_sha256 AS subjectSha256, status, requested_at AS requestedAt, requested_by AS requestedBy, model, decided_at AS decidedAt, decided_by AS decidedBy, reason, applied_at AS appliedAt";

// The subject is stored as canonical JSON text and parsed on read.
interface ApprovalRow extends Omit<ApprovalRecord, "subject"> {
  readonly subject: string;
}

const PLAN_KIND = "plan";

export function createApprovalsFacet(options: ApprovalFacetOptions): ApprovalsPort {
  const { db, clock, rules, transaction, appendEvent, assertActiveEpoch } = options;

  const findOne = (approvalId: string): ApprovalRecord | undefined => {
    const row = db
      .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE approval_id = ?`)
      .get(approvalId) as unknown as ApprovalRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  };

  const requireOne = (approvalId: string): ApprovalRecord => {
    const approval = findOne(approvalId);
    if (approval === undefined) {
      throw new StoreError("store.not_found", `no approval with id "${approvalId}"`, {
        approvalId,
      });
    }
    return approval;
  };

  return {
    proposePlan(input): Result<{ approval: ApprovalRecord; created: boolean }, HarilError> {
      const check = rules.checkPlan(input.plan);
      if (!check.ok) return { ok: false, error: { code: "plan.invalid", message: check.reason } };
      // LD-T7a: the model of the proposing task, checked like the model of a task.create.
      const model = input.model ?? null;
      if (model !== null && (typeof model !== "string" || model.trim() === "")) {
        return {
          ok: false,
          error: { code: "model.invalid", message: "model must be a non-empty model id" },
        };
      }
      const subject = rules.canonicalJson(check.plan);
      const subjectSha256 = sha256(subject);
      const value = transaction(() => {
        const project = db
          .prepare("SELECT 1 AS found FROM projects WHERE project_id = ?")
          .get(input.projectId);
        if (project === undefined) {
          throw new StoreError("store.not_found", `no project with id "${input.projectId}"`, {
            projectId: input.projectId,
          });
        }
        // The same plan proposed again while it is still requested is the same approval (idempotent per project); it
        // keeps the model of its first proposal.
        const pending = db
          .prepare(
            `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE project_id = ? AND kind = ? AND subject_sha256 = ? AND status = 'requested'`,
          )
          .get(input.projectId, PLAN_KIND, subjectSha256) as unknown as ApprovalRow | undefined;
        if (pending !== undefined) return { approval: toRecord(pending), created: false };

        const approvalId = options.ids.next();
        const now = clock.now();
        db.prepare(
          "INSERT INTO approvals (approval_id, project_id, kind, subject, subject_sha256, status, requested_at, requested_by, model) VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?)",
        ).run(
          approvalId,
          input.projectId,
          PLAN_KIND,
          subject,
          subjectSha256,
          now,
          input.requestedBy,
          model,
        );
        appendEvent({
          aggregateType: "approval",
          aggregateId: approvalId,
          type: "approval.requested",
          actorKind: input.requestedBy === "cli" ? "user" : "agent",
          actorId: input.requestedBy,
          payload: {
            kind: PLAN_KIND,
            subjectSha256,
            taskCount: taskCountOf(check.plan),
            ...(model === null ? {} : { model }),
          },
          projectId: input.projectId,
        });
        return { approval: requireOne(approvalId), created: true };
      });
      return { ok: true, value };
    },

    decide(input) {
      return transaction(() => {
        const current = requireOne(input.approvalId);
        if (current.status !== "requested") {
          throw new StoreError(
            "store.conflict",
            `approval "${input.approvalId}" was already ${current.status}`,
            { approvalId: input.approvalId, status: current.status },
          );
        }
        db.prepare(
          "UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, reason = ? WHERE approval_id = ?",
        ).run(input.outcome, clock.now(), input.decidedBy, input.reason ?? null, input.approvalId);
        appendEvent({
          aggregateType: "approval",
          aggregateId: input.approvalId,
          type: input.outcome === "granted" ? "approval.granted" : "approval.denied",
          actorKind: "user",
          actorId: input.decidedBy,
          payload: {
            kind: current.kind,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
          projectId: current.projectId,
        });
        return requireOne(input.approvalId);
      });
    },

    list(filter?: ApprovalFilter) {
      const rows = db
        .prepare(
          `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR status = ?) AND (? IS NULL OR requested_by IN (SELECT run_id FROM runs WHERE task_id = ?)) ORDER BY requested_at, rowid`,
        )
        .all(
          filter?.projectId ?? null,
          filter?.projectId ?? null,
          filter?.status ?? null,
          filter?.status ?? null,
          filter?.requestedByTask ?? null,
          filter?.requestedByTask ?? null,
        ) as unknown as ApprovalRow[];
      return rows.map(toRecord);
    },

    get: (approvalId) => findOne(approvalId),

    listUnapplied() {
      const rows = db
        .prepare(
          `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE status <> 'requested' AND applied_at IS NULL ORDER BY decided_at, rowid`,
        )
        .all() as unknown as ApprovalRow[];
      return rows.map(toRecord);
    },

    markApplied(approvalId, epoch) {
      return transaction(() => {
        assertActiveEpoch(epoch);
        const current = requireOne(approvalId);
        if (current.status === "requested") {
          throw new StoreError(
            "store.conflict",
            `approval "${approvalId}" has no decision to apply`,
            { approvalId },
          );
        }
        if (current.appliedAt !== null) return false;
        db.prepare("UPDATE approvals SET applied_at = ? WHERE approval_id = ?").run(
          clock.now(),
          approvalId,
        );
        appendEvent({
          aggregateType: "approval",
          aggregateId: approvalId,
          type: "approval.applied",
          actorKind: "system",
          actorId: `runtime:${epoch}`,
          payload: { kind: current.kind, outcome: current.status },
          projectId: current.projectId,
        });
        return true;
      });
    },
  };
}

function toRecord(row: ApprovalRow): ApprovalRecord {
  return { ...row, subject: JSON.parse(row.subject) as JsonObject };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function taskCountOf(plan: unknown): number {
  const tasks = (plan as { tasks?: unknown[] }).tasks;
  return Array.isArray(tasks) ? tasks.length : 0;
}
