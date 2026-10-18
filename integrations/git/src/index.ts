// Public surface of @haril/git: the working-tree status the shell reads (LD-T6b-1), and the writing side of the
// three-layer delegation (phase F8, docs/modos-y-delegacion.md 3.10): the repository and its base branch, one worktree
// and branch per executor, the commit of an executor's work, and the integration merges with their conflicts. No
// function contacts a remote: HARIL never fetches, pulls or pushes.
export { changedPaths, commitPaths, discardChanges } from "./changes.js";
export {
  abortMerge,
  type FinishResult,
  finishMerge,
  hasConflictMarkers,
  type MergeCheck,
  type MergeResult,
  mergeBranch,
  mergeCheck,
  mergeInProgress,
  unmergedPaths,
} from "./merge.js";
export {
  type BaseBranch,
  branchCommit,
  detectBaseBranch,
  headBranch,
  headCommit,
  inspectRepository,
  isAncestor,
  type RepositoryCheck,
} from "./repository.js";
export { type GitOptions, type GitResult, HARIL_AUTHOR, isSafeBranchName } from "./run.js";
export { type GitStatus, type ReadGitStatusOptions, readGitStatus } from "./status.js";
export {
  addWorktree,
  branchesUnder,
  checkPointer,
  deleteBranch,
  listWorktrees,
  type NewWorktree,
  type RemoveOptions,
  removeWorktree,
  WORKTREE_PATH_MAX_LENGTH,
  type WorktreeEntry,
  type WorktreeIdentity,
  type WorktreeResult,
  worktreeIdentity,
} from "./worktrees.js";
