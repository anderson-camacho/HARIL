// The git worktrees of workflows that write (docs/modos-y-delegacion.md 3.10, phase F8): one per executor thread, on a
// branch of its own started from the workflow's base commit, and one integration worktree per workflow on its
// integration branch. The runtime records each worktree it creates, so a restart reuses it, the snapshot names the
// branches, and the startup sweep removes the worktrees of workflows that ended. The store only records; the runtime
// makes and removes the worktrees with git. Every write is fenced by the runtime epoch.

export type WorktreeKind = "executor" | "integration";
export type WorktreeState = "active" | "removed";

export interface WorktreeRecord {
  readonly worktreeId: string;
  readonly workflowId: string;
  readonly kind: WorktreeKind;
  // The executor thread; null for the integration worktree.
  readonly threadId: string | null;
  // Absolute path of the worktree folder.
  readonly path: string;
  readonly branch: string;
  // The commit the branch started from (the workflow's base_sha).
  readonly baseSha: string;
  // The last commit HARIL recorded on the branch: an executor's committed work, or the integration's last merge. null
  // while the branch holds nothing beyond its base.
  readonly headSha: string | null;
  // An executor branch's last commit HARIL verified: where the step started (the base commit, with its predecessors'
  // work merged), then each commit the end of a successful turn checked. Every turn of the step starts there and a turn
  // that does not succeed puts the branch back there, so a commit a command made never survives into a retry. null for
  // the integration worktree and for a record made before 0.20.1 (migration 0016).
  readonly verifiedSha: string | null;
  // An executor branch merged into the integration branch: when, and the merge commit.
  readonly mergedAt: number | null;
  readonly mergeSha: string | null;
  readonly state: WorktreeState;
  readonly createdAt: number;
  readonly removedAt: number | null;
}

export interface RecordWorktreeInput {
  readonly workflowId: string;
  readonly kind: WorktreeKind;
  readonly threadId: string | null;
  readonly path: string;
  readonly branch: string;
  readonly baseSha: string;
}

export interface WorktreeFilter {
  readonly workflowId?: string;
  readonly kind?: WorktreeKind;
  readonly state?: WorktreeState;
}

export interface WorktreesPort {
  // One record per workflow, kind and thread: recording it again returns the same record, active again (a worktree
  // removed and made anew keeps its record). store.not_found for an unknown workflow.
  record(epoch: number, input: RecordWorktreeInput): WorktreeRecord;
  setHead(epoch: number, worktreeId: string, headSha: string): void;
  setVerified(epoch: number, worktreeId: string, verifiedSha: string): void;
  markMerged(epoch: number, worktreeId: string, mergeSha: string): void;
  markRemoved(epoch: number, worktreeId: string): void;
  get(worktreeId: string): WorktreeRecord | undefined;
  // Oldest first.
  list(filter?: WorktreeFilter): readonly WorktreeRecord[];
}
