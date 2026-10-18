import { detailOf, type GitOptions, recordsOf, runGit } from "./run.js";

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

// Stages `paths` and commits them with `message`; a commit with nothing staged is no commit (sha null). Never runs a
// hook (run.ts) and never asks for a message.
export async function commitPaths(
  worktree: string,
  paths: readonly string[],
  message: string,
  options: GitOptions = {},
): Promise<
  | { readonly ok: true; readonly sha: string | null }
  | { readonly ok: false; readonly detail: string }
> {
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

// Puts the worktree back to its last commit: tracked changes reset, untracked files and folders removed (ignored files,
// such as installed dependencies, stay). True when both steps worked.
export async function discardChanges(worktree: string, options: GitOptions = {}): Promise<boolean> {
  const reset = await runGit(worktree, ["reset", "--quiet", "--hard", "HEAD"], options);
  const clean = await runGit(worktree, ["clean", "-d", "--force", "--quiet"], options);
  return reset.ok && clean.ok;
}
