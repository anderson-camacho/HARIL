import type { DelegationLimits } from "@haril/core";
import { visibleText } from "@haril/core";
import type { Store, WorktreeRecord } from "@haril/core/ports";
import {
  abortMerge,
  finishMerge,
  type GitOptions,
  isAncestor,
  mergeBranch,
  mergeCheck,
  mergeInProgress,
} from "@haril/git";
import type { Task, WorkflowView } from "./workflow-view.js";
import {
  type TurnWorkspace,
  type WorkspaceReply,
  type Workspaces,
  worktreeGit,
} from "./worktrees.js";

// Integration by the delegator (docs/modos-y-delegacion.md 3.10.3, R-D13, P12; phase F8). In its continuation, a
// delegator merges each approved step into the workflow's integration branch with haril_merge {localId}. The host:
//   1. finds the step among the delegator's own children and checks it was approved;
//   2. pre-checks the merge with `git merge-tree --write-tree` (S4), touching no worktree;
//   3. runs `git merge --no-ff` in the integration worktree. A clean merge is recorded (the step's worktree and branch
//      then go away); a conflict comes back as data: the conflicting files, left with their markers;
//   4. the delegator resolves those files with its own write and edit (confined to them), then haril_merge_continue
//      commits the resolution, refused while a marker remains; haril_merge_abort gives the merge up.
// The base branch is never touched and nothing is pushed: the integration branch is the result the user reviews.

interface PendingMerge {
  readonly localId: string;
  readonly branch: string;
  readonly worktreeId: string;
  readonly files: readonly string[];
}

interface IntegrationContext {
  readonly store: Store;
  readonly epoch: number;
  readonly view: WorkflowView;
  // The delegator turn that merges.
  readonly task: Task;
  readonly workspace: TurnWorkspace;
  readonly limits: DelegationLimits;
  readonly workspaces: Workspaces;
  readonly git?: GitOptions;
}

export interface Integration {
  merge(context: IntegrationContext, localId: string): Promise<WorkspaceReply>;
  mergeContinue(context: IntegrationContext): Promise<WorkspaceReply>;
  mergeAbort(context: IntegrationContext): Promise<WorkspaceReply>;
  // The merge a workflow left waiting for its conflicts, if any.
  pending(workflowId: string): PendingMerge | null;
  // Forgets the waiting merge of a workflow: the turn that made it ended, and its worktree was put back.
  clear(workflowId: string): void;
}

function refuse(reason: string): WorkspaceReply {
  return { ok: false, reason };
}

// The worktree record of an executor thread.
function executorRecord(
  store: Store,
  workflowId: string,
  threadId: string,
): WorktreeRecord | undefined {
  return store.worktrees
    .list({ workflowId, kind: "executor" })
    .find((record) => record.threadId === threadId);
}

// A delegator's approved steps whose branch holds work not merged into the integration branch yet, by local id.
export function unmergedSteps(
  store: Store,
  view: WorkflowView,
  delegatorThreadId: string,
  limits: DelegationLimits,
): string[] {
  const out: string[] = [];
  for (const child of view.childThreads(delegatorThreadId)) {
    if (view.rework(child, limits).phase !== "approved") continue;
    const record = executorRecord(store, view.workflow.workflowId, child);
    if (record === undefined || record.headSha === null || record.mergedAt !== null) continue;
    out.push(view.turns(child)[0]?.localId ?? child);
  }
  return out;
}

export function createIntegration(): Integration {
  const pending = new Map<string, PendingMerge>();

  const stepOf = (context: IntegrationContext, localId: string) => {
    const { view, task } = context;
    return view
      .childThreads(task.threadId)
      .find((thread) => view.turns(thread)[0]?.localId === localId);
  };

  const recordMerged = async (
    context: IntegrationContext,
    record: WorktreeRecord,
    sha: string,
  ): Promise<void> => {
    const { store, epoch, workspace } = context;
    store.worktrees.markMerged(epoch, record.worktreeId, sha);
    store.worktrees.setHead(epoch, workspace.worktreeId, sha);
    // Clean up after integration: the step's worktree and its branch, whose work the integration branch now holds.
    const merged = store.worktrees.get(record.worktreeId);
    if (merged !== undefined && merged.state === "active") {
      await context.workspaces.retireExecutor(store, epoch, merged, workspace.repo);
    }
  };

  const merge: Integration["merge"] = (context, localId) => {
    const { store, view, workspace, limits } = context;
    const git = context.git ?? context.workspaces.settings.git ?? {};
    // The integration worktree's own git folder, named on every run there.
    const own = worktreeGit(git, workspace);
    const workflowId = view.workflow.workflowId;
    if (workspace.kind !== "integration") {
      return Promise.resolve(refuse("haril_merge runs only in the integration worktree"));
    }
    const thread = stepOf(context, localId);
    if (thread === undefined) {
      return Promise.resolve(refuse(`"${localId}" is not one of your steps`));
    }
    if (view.rework(thread, limits).phase !== "approved") {
      return Promise.resolve(
        refuse(`step "${localId}" is not approved; only approved work is merged`),
      );
    }
    const record = executorRecord(store, workflowId, thread);
    if (record === undefined || record.headSha === null) {
      return Promise.resolve({
        ok: true,
        localId,
        conflicts: [],
        note: "the step wrote nothing; there is nothing to merge",
      });
    }
    if (record.mergedAt !== null) {
      return Promise.resolve({ ok: true, localId, conflicts: [], note: "already merged" });
    }
    const waiting = pending.get(workflowId);
    if (waiting !== undefined) {
      return Promise.resolve(
        refuse(
          `the merge of "${waiting.localId}" waits for its conflicts (${waiting.files.join(", ")}): resolve them and call haril_merge_continue, or haril_merge_abort`,
        ),
      );
    }
    return context.workspaces.withRepository(workspace.repo, async () => {
      if (await mergeInProgress(workspace.root, own)) {
        return refuse(
          "a merge is already in progress in the integration worktree; call haril_merge_abort first",
        );
      }
      if ((await isAncestor(workspace.repo, record.branch, workspace.branch, git)) === true) {
        await recordMerged(context, record, record.headSha as string);
        return { ok: true, localId, conflicts: [], note: "already merged" };
      }
      const check = await mergeCheck(workspace.repo, workspace.branch, record.branch, git);
      if (!check.ok)
        return refuse(`the merge of "${localId}" could not be checked: ${check.detail}`);
      const message = `haril: merge ${visibleText(view.label(thread)).slice(0, 120)} into the integration branch`;
      const result = await mergeBranch(workspace.root, record.branch, message, own);
      if (!result.ok) return refuse(`the merge of "${localId}" failed: ${result.detail}`);
      if (result.merged) {
        await recordMerged(context, record, result.sha);
        return { ok: true, localId, commit: result.sha, conflicts: [] };
      }
      const files = [...result.conflicts];
      pending.set(workflowId, {
        localId,
        branch: record.branch,
        worktreeId: record.worktreeId,
        files,
      });
      return {
        ok: true,
        localId,
        conflicts: files,
        note: "the merge conflicts: fix each file with edit or write (keep both sides' intent, remove every conflict marker), then call haril_merge_continue {}; or haril_merge_abort {}",
      };
    });
  };

  const mergeContinue: Integration["mergeContinue"] = (context) => {
    const { store, view, workspace } = context;
    const git = context.git ?? context.workspaces.settings.git ?? {};
    // The integration worktree's own git folder, named on every run there.
    const own = worktreeGit(git, workspace);
    const waiting = pending.get(view.workflow.workflowId);
    if (waiting === undefined) return Promise.resolve(refuse("no merge waits for its conflicts"));
    return context.workspaces.withRepository(workspace.repo, async () => {
      const message = `haril: merge ${waiting.localId} into the integration branch, conflicts resolved by the delegator`;
      const finished = await finishMerge(workspace.root, waiting.files, message, own);
      if (!finished.ok) {
        return refuse(
          finished.unresolved.length > 0
            ? `the conflicts are not resolved yet: ${finished.unresolved.join(", ")} still ${finished.unresolved.length === 1 ? "holds" : "hold"} conflict markers or unmerged changes`
            : `the merge could not be committed: ${finished.detail}`,
        );
      }
      pending.delete(view.workflow.workflowId);
      const record = store.worktrees.get(waiting.worktreeId);
      if (record !== undefined) await recordMerged(context, record, finished.sha);
      return { ok: true, localId: waiting.localId, commit: finished.sha };
    });
  };

  const mergeAbort: Integration["mergeAbort"] = (context) => {
    const { view, workspace } = context;
    const git = context.git ?? context.workspaces.settings.git ?? {};
    // The integration worktree's own git folder, named on every run there.
    const own = worktreeGit(git, workspace);
    return context.workspaces.withRepository(workspace.repo, async () => {
      const waiting = pending.get(view.workflow.workflowId);
      pending.delete(view.workflow.workflowId);
      if (!(await mergeInProgress(workspace.root, own))) {
        return waiting === undefined
          ? refuse("no merge is in progress")
          : { ok: true, aborted: waiting.localId };
      }
      const aborted = await abortMerge(workspace.root, own);
      return aborted
        ? { ok: true, aborted: waiting?.localId ?? null }
        : refuse("git merge --abort failed");
    });
  };

  return {
    merge,
    mergeContinue,
    mergeAbort,
    pending: (workflowId) => pending.get(workflowId) ?? null,
    clear: (workflowId) => {
      pending.delete(workflowId);
    },
  };
}
