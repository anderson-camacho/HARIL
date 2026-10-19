import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventRecord, Store, WorkflowRecord, WorkflowTaskRecord } from "@haril/core/ports";

// Match the supported project test runners, never a merely allowed command such as `node --version`.
export function projectTestCommand(
  root: string,
  command: string,
  args: readonly string[],
): string | null {
  const invocation = [command, ...args].join(" ");
  if (
    ["npm test", "npm run test", "pnpm test", "pnpm run test", "yarn test"].includes(invocation)
  ) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        scripts?: { test?: unknown };
      };
      return typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim() !== ""
        ? invocation
        : null;
    } catch {
      return null;
    }
  }
  if (invocation === "go test ./..." && existsSync(join(root, "go.mod"))) return invocation;
  if (invocation === "cargo test" && existsSync(join(root, "Cargo.toml"))) return invocation;
  return null;
}

type EvidenceStore = { readonly events: Pick<Store["events"], "list"> };
type Turn = Pick<WorkflowTaskRecord, "taskId" | "attempt" | "auditedTaskId" | "role">;

export interface ExecutorEvidence {
  readonly ok: true;
  readonly executorTaskId: string;
  readonly executorRunId: string;
  readonly commit: string;
  readonly paths: readonly string[];
  readonly testRunId: string;
  readonly testCommand: string;
}

type EvidenceResult = ExecutorEvidence | { readonly ok: false; readonly reason: string };

function hostEvent(event: EventRecord, type: string, taskId: string, runId: string): boolean {
  return (
    event.type === type &&
    event.actorKind === "system" &&
    event.taskId === taskId &&
    event.runId === runId
  );
}

function claimedRun(events: readonly EventRecord[], task: Turn): string | null {
  const claim = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "task.claimed" &&
        event.actorKind === "system" &&
        event.taskId === task.taskId &&
        event.payload.attempt === task.attempt &&
        typeof event.runId === "string",
    );
  return claim?.runId ?? null;
}

export function executorEvidence(
  store: EvidenceStore,
  executor: Turn,
  auditor: Turn,
): EvidenceResult {
  const executorEvents = store.events.list({ taskId: executor.taskId });
  const executorRunId = claimedRun(executorEvents, executor);
  const missing = (detail: string): EvidenceResult => ({
    ok: false,
    reason: `executor ${executor.taskId}: ${detail}; produce a changed commit and run the project's test command through haril_run in the auditor's turn`,
  });
  if (executorRunId === null) return missing("no host-recorded attempt");
  const commit = executorEvents.find(
    (event) =>
      hostEvent(event, "worktree.committed", executor.taskId, executorRunId) &&
      event.payload.attempt === executor.attempt &&
      typeof event.payload.sha === "string" &&
      event.payload.sha.length > 0 &&
      Array.isArray(event.payload.paths) &&
      event.payload.paths.length > 0 &&
      event.payload.paths.every((path) => typeof path === "string" && path.length > 0),
  );
  if (commit === undefined) return missing("no attempt-scoped changed files and verified commit");
  const auditorEvents = store.events.list({ taskId: auditor.taskId });
  const testRunId = claimedRun(auditorEvents, auditor);
  const test =
    testRunId === null
      ? undefined
      : auditorEvents.find(
          (event) =>
            hostEvent(event, "workspace.command", auditor.taskId, testRunId) &&
            event.payload.projectTest === true &&
            event.payload.exitCode === 0 &&
            event.payload.timedOut === false &&
            typeof event.payload.testCommand === "string",
        );
  if (test === undefined)
    return missing("no successful host-recorded project test for the audited commit");
  return {
    ok: true,
    executorTaskId: executor.taskId,
    executorRunId,
    commit: commit.payload.sha as string,
    paths: commit.payload.paths as string[],
    testRunId: testRunId as string,
    testCommand: test.payload.testCommand as string,
  };
}

export type WorkflowEvidence =
  | { readonly ok: true; readonly mode: "consultation"; readonly executors: readonly [] }
  | {
      readonly ok: true;
      readonly mode: "implementation";
      readonly executors: readonly ExecutorEvidence[];
    }
  | { readonly ok: false; readonly reason: string };

export function workflowEvidence(
  store: EvidenceStore,
  workflow: Pick<WorkflowRecord, "baseBranch" | "baseSha">,
  tasks: readonly Turn[],
  audits: readonly {
    readonly subjectTaskId: string | null;
    readonly auditorTaskId?: string;
    readonly verdict: string;
  }[],
): WorkflowEvidence {
  if (workflow.baseBranch === null && workflow.baseSha === null) {
    return { ok: true, mode: "consultation", executors: [] };
  }
  if (workflow.baseBranch === null || workflow.baseSha === null) {
    return { ok: false, reason: "implementation has an incomplete writing base" };
  }
  const approved = audits.filter(
    (audit) => audit.verdict === "approved" && audit.subjectTaskId !== null,
  );
  if (approved.length === 0) {
    return {
      ok: false,
      reason:
        "implementation has no approved executor with host-observed changed files and a project test",
    };
  }
  const evidence: ExecutorEvidence[] = [];
  for (const audit of approved) {
    const executor = tasks.find(
      (task) => task.taskId === audit.subjectTaskId && task.role === "executor",
    );
    const auditor = tasks.find(
      (task) =>
        task.taskId === audit.auditorTaskId &&
        task.role === "auditor" &&
        task.auditedTaskId === executor?.taskId,
    );
    if (executor === undefined || auditor === undefined) {
      return { ok: false, reason: `approved executor ${audit.subjectTaskId} has no bound auditor` };
    }
    const observed = executorEvidence(store, executor, auditor);
    if (!observed.ok) return observed;
    evidence.push(observed);
  }
  return { ok: true, mode: "implementation", executors: evidence };
}

export function evidenceStatus(evidence: Extract<WorkflowEvidence, { ok: true }>): string {
  if (evidence.mode === "consultation")
    return "read-only consultation; no implementation or tests claimed";
  return `implementation: ${evidence.executors.map((item) => `${item.commit.slice(0, 12)} [${item.paths.join(", ")}] test ${item.testCommand} (run ${item.testRunId})`).join("; ")}`;
}
