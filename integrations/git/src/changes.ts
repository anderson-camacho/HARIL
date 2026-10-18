import { detailOf, type GitOptions, isSafeBranchName, recordsOf, runGit } from "./run.js";

// What an executor's turn changed in its worktree, and its commit (docs/modos-y-delegacion.md 3.10, phase F8). The host
// commits only the changed paths inside the step's write surface (the Core decides which), then discards everything else
// a command left behind, so the branch holds exactly what the step wrote. Paths are relative to the worktree, with "/"
// separators, as git reports them.

// Paths `git add` takes per run, so a long list never passes the command-line limit of Windows.
const PATHS_PER_RUN = 100;

// Every changed path of the worktree: modified, added, deleted, untracked (each file of an untracked folder). For a
// rename both paths count. Undefined when git fails.
export async function changedPaths(
  worktree: string,
  options: GitOptions = {},
): Promise<string[] | undefined> {
  const result = await runGit(
    worktree,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    options,
  );
  if (!result.ok) return undefined;
  const paths = new Set<string>();
  for (const record of recordsOf(result.stdout)) {
    // "XY path": two status letters and a space.
    if (record.length > 3) paths.add(record.slice(3));
  }
  return [...paths];
}

// Stages `paths` and commits them with `message`; a commit with nothing staged is no commit (sha null). Whatever was
// staged before (a command may have staged other files) is unstaged first, so only `paths` go in. Never runs a hook
// (run.ts) and never asks for a message.
export async function commitPaths(
  worktree: string,
  paths: readonly string[],
  message: string,
  options: GitOptions = {},
): Promise<
  | { readonly ok: true; readonly sha: string | null }
  | { readonly ok: false; readonly detail: string }
> {
  const unstaged = await runGit(worktree, ["reset", "--quiet"], options);
  if (!unstaged.ok) return { ok: false, detail: detailOf(unstaged) };
  for (let start = 0; start < paths.length; start += PATHS_PER_RUN) {
    const chunk = paths.slice(start, start + PATHS_PER_RUN);
    const added = await runGit(worktree, ["add", "--all", "--", ...chunk], options);
    if (!added.ok) return { ok: false, detail: detailOf(added) };
  }
  const staged = await runGit(worktree, ["diff", "--cached", "--quiet"], options);
  if (staged.code === 0) return { ok: true, sha: null };
  if (staged.code !== 1) return { ok: false, detail: detailOf(staged) };
  const committed = await runGit(
    worktree,
    ["commit", "--quiet", "--no-verify", "--no-edit", "-m", message],
    options,
  );
  if (!committed.ok) return { ok: false, detail: detailOf(committed) };
  const head = await runGit(worktree, ["rev-parse", "HEAD"], options);
  return head.ok ? { ok: true, sha: head.stdout.trim() } : { ok: false, detail: detailOf(head) };
}

// The paths the commits after `base` changed, up to HEAD (both paths of a rename); undefined when git fails.
export async function pathsChangedSince(
  worktree: string,
  base: string,
  options: GitOptions = {},
): Promise<string[] | undefined> {
  if (!/^[0-9a-f]{7,64}$/.test(base)) return undefined;
  const result = await runGit(
    worktree,
    ["diff", "--name-only", "-z", "--no-renames", base, "HEAD", "--"],
    options,
  );
  return result.ok ? [...new Set(recordsOf(result.stdout))] : undefined;
}

// Puts a worktree's branch back on `sha`: HEAD names `branch` again (a command may have checked out another branch,
// detached HEAD or deleted the branch), the branch points at `sha`, and the worktree holds exactly that commit (tracked
// changes reset, untracked files removed, a merge in progress dropped). No other branch moves, whatever HEAD named
// before: HEAD is pointed at `branch` first, and only then reset. True once git shows HEAD on `branch` at `sha`.
export async function restoreBranch(
  worktree: string,
  branch: string,
  sha: string,
  options: GitOptions = {},
): Promise<boolean> {
  if (!isSafeBranchName(branch) || !/^[0-9a-f]{40,64}$/.test(sha)) return false;
  const pointed = await runGit(worktree, ["symbolic-ref", "HEAD", `refs/heads/${branch}`], options);
  if (!pointed.ok) return false;
  const reset = await runGit(worktree, ["reset", "--quiet", "--hard", sha], options);
  const clean = await runGit(worktree, ["clean", "-d", "--force", "--quiet"], options);
  if (!reset.ok || !clean.ok) return false;
  const head = await runGit(
    worktree,
    ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    options,
  );
  return head.ok && head.stdout.trim() === sha;
}

// Whether the repository tracks `path` (in the worktree's index: a conflicted file of a merge counts).
export async function isTracked(
  worktree: string,
  path: string,
  options: GitOptions = {},
): Promise<boolean> {
  return (await runGit(worktree, ["ls-files", "--error-unmatch", "--", path], options)).ok;
}

// Puts the worktree back to its last commit: tracked changes reset, untracked files and folders removed (ignored files,
// such as installed dependencies, stay). True when both steps worked.
export async function discardChanges(worktree: string, options: GitOptions = {}): Promise<boolean> {
  const reset = await runGit(worktree, ["reset", "--quiet", "--hard", "HEAD"], options);
  const clean = await runGit(worktree, ["clean", "-d", "--force", "--quiet"], options);
  return reset.ok && clean.ok;
}
