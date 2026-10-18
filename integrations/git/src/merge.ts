import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detailOf, type GitOptions, isSafeBranchName, linesOf, recordsOf, runGit } from "./run.js";

// Integration (docs/modos-y-delegacion.md 3.10.3, spike S4): a delegator merges its executors' branches into the
// workflow's integration branch with `git merge --no-ff`. Before it, `git merge-tree --write-tree --name-only` answers
// whether the merge conflicts and which files, touching no worktree (S4: exit 1 and the file list on a conflict). A
// conflicting merge is left in progress in the integration worktree, with its conflict markers, for the delegator to
// resolve; finishMerge commits the resolution only once no file it names holds a marker and git reports nothing
// unmerged, and abortMerge gives the merge up (git merge --abort leaves the branch as it was). Nothing here touches the
// base branch or a remote.

export type MergeCheck =
  | { readonly ok: true; readonly clean: true }
  | { readonly ok: true; readonly clean: false; readonly conflicts: readonly string[] }
  | { readonly ok: false; readonly detail: string };

export type MergeResult =
  | { readonly ok: true; readonly merged: true; readonly sha: string }
  | { readonly ok: true; readonly merged: false; readonly conflicts: readonly string[] }
  | { readonly ok: false; readonly detail: string };

export type FinishResult =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly detail: string; readonly unresolved: readonly string[] };

// The lines that open and close a conflict, as git writes them: seven < or > and a space before the side's label. A
// line of seven = alone is no marker (a Markdown heading is underlined that way): the "=======" between the sides only
// ever stands inside an opening and a closing line, which this already finds.
const OPEN_OR_CLOSE = /^(<{7}|>{7}) /m;

// Whether a text still holds a conflict: a "<<<<<<< " or ">>>>>>> " line (a whole conflict has both).
export function hasConflictMarkers(text: string): boolean {
  return OPEN_OR_CLOSE.test(text);
}

function refProblem(ref: string): boolean {
  return !isSafeBranchName(ref) && !/^[0-9a-f]{7,64}$/.test(ref);
}

// Whether merging `theirs` into `ours` would conflict, computed in the object store only.
export async function mergeCheck(
  root: string,
  ours: string,
  theirs: string,
  options: GitOptions = {},
): Promise<MergeCheck> {
  if (refProblem(ours) || refProblem(theirs))
    return { ok: false, detail: "not a branch or commit" };
  const result = await runGit(
    root,
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs],
    options,
  );
  if (result.code === 0) return { ok: true, clean: true };
  if (result.code === 1) {
    // The first line is the tree written; the conflicting paths follow, one per line.
    const conflicts = [...new Set(linesOf(result.stdout).slice(1))];
    return { ok: true, clean: false, conflicts };
  }
  return { ok: false, detail: detailOf(result) };
}

// The paths git reports unmerged in a worktree.
export async function unmergedPaths(
  worktree: string,
  options: GitOptions = {},
): Promise<string[] | undefined> {
  const result = await runGit(worktree, ["diff", "--name-only", "--diff-filter=U", "-z"], options);
  return result.ok ? [...new Set(recordsOf(result.stdout))] : undefined;
}

export async function mergeInProgress(
  worktree: string,
  options: GitOptions = {},
): Promise<boolean> {
  return (await runGit(worktree, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], options)).ok;
}

// Merges `branch` into the branch checked out in `worktree` with a merge commit. On a conflict the merge stays in
// progress, and the answer lists the conflicting paths.
export async function mergeBranch(
  worktree: string,
  branch: string,
  message: string,
  options: GitOptions = {},
): Promise<MergeResult> {
  if (refProblem(branch)) return { ok: false, detail: "not a branch or commit" };
  const merged = await runGit(
    worktree,
    ["merge", "--no-ff", "--no-verify", "--no-edit", "--quiet", "-m", message, branch],
    options,
  );
  if (merged.ok) {
    const head = await runGit(worktree, ["rev-parse", "HEAD"], options);
    return head.ok
      ? { ok: true, merged: true, sha: head.stdout.trim() }
      : { ok: false, detail: detailOf(head) };
  }
  const conflicts = await unmergedPaths(worktree, options);
  if (
    conflicts !== undefined &&
    conflicts.length > 0 &&
    (await mergeInProgress(worktree, options))
  ) {
    return { ok: true, merged: false, conflicts };
  }
  return { ok: false, detail: detailOf(merged) };
}

// Commits the merge in progress once its conflicts are resolved: `paths` (the conflicting files) are read back and
// staged, and the commit is refused while one of them holds a conflict marker or git still reports a path unmerged.
export async function finishMerge(
  worktree: string,
  paths: readonly string[],
  message: string,
  options: GitOptions = {},
): Promise<FinishResult> {
  if (!(await mergeInProgress(worktree, options))) {
    return { ok: false, detail: "no merge is in progress", unresolved: [] };
  }
  const marked: string[] = [];
  for (const path of paths) {
    // A path deleted on purpose has no text; a path whose text still has a marker is not resolved.
    const text = await readFile(join(worktree, path), "utf8").catch(() => undefined);
    if (text !== undefined && hasConflictMarkers(text)) marked.push(path);
  }
  if (marked.length > 0) {
    return { ok: false, detail: "conflict markers remain", unresolved: marked };
  }
  if (paths.length > 0) {
    const added = await runGit(worktree, ["add", "--all", "--", ...paths], options);
    if (!added.ok) return { ok: false, detail: detailOf(added), unresolved: [...paths] };
  }
  const unresolved = (await unmergedPaths(worktree, options)) ?? [];
  if (unresolved.length > 0) return { ok: false, detail: "paths are still unmerged", unresolved };
  const committed = await runGit(
    worktree,
    ["commit", "--quiet", "--no-verify", "--no-edit", "-m", message],
    options,
  );
  if (!committed.ok) return { ok: false, detail: detailOf(committed), unresolved: [] };
  const head = await runGit(worktree, ["rev-parse", "HEAD"], options);
  return head.ok
    ? { ok: true, sha: head.stdout.trim() }
    : { ok: false, detail: detailOf(head), unresolved: [] };
}

// Gives the merge in progress up: the branch and the worktree go back to the commit before it.
export async function abortMerge(worktree: string, options: GitOptions = {}): Promise<boolean> {
  return (await runGit(worktree, ["merge", "--abort"], options)).ok;
}
