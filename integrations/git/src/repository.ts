import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { detailOf, type GitOptions, isSafeBranchName, runGit } from "./run.js";

// The repository a writing workflow works on and the branch its worktrees start from (docs/modos-y-delegacion.md 3.10,
// P13: every branch starts from main, never from another branch). A project root must be the top level of a repository
// with at least one commit: worktrees are made of the whole repository, so a project inside a larger repository (or a
// folder git only finds by walking up to an unrelated parent repository) stays read-only.
//
// The base branch is `main`. A project whose default branch is named otherwise is detected, in this order: the branch the
// remote's HEAD names locally (refs/remotes/origin/HEAD -> origin/<name>, as `git clone` records it), the branch
// init.defaultBranch names, then `master`; each counts only when it exists as a local branch. A branch the user asks
// for by name is used only when it exists. Nothing here contacts a remote: origin/HEAD is read as git last recorded it.

export type RepositoryCheck =
  | { readonly ok: true; readonly topLevel: string }
  | {
      readonly ok: false;
      readonly reason: "git_missing" | "not_a_repository" | "not_top_level" | "no_commits";
      readonly detail: string;
    };

export type BaseBranch =
  | {
      readonly ok: true;
      readonly branch: string;
      readonly sha: string;
      readonly source: "requested" | "main" | "origin_head" | "init_default" | "master";
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_branch" | "no_base_branch" | "unreadable";
      readonly detail: string;
    };

function canonical(path: string): string {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    real = resolve(path);
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

export async function inspectRepository(
  root: string,
  options: GitOptions = {},
): Promise<RepositoryCheck> {
  const top = await runGit(root, ["rev-parse", "--show-toplevel"], options);
  if (top.code === null && top.stdout === "") {
    return { ok: false, reason: "git_missing", detail: detailOf(top) };
  }
  if (!top.ok) return { ok: false, reason: "not_a_repository", detail: detailOf(top) };
  const topLevel = top.stdout.trim();
  if (canonical(topLevel) !== canonical(root)) {
    return {
      ok: false,
      reason: "not_top_level",
      detail: "the project root is not the top level of its git repository",
    };
  }
  const head = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], options);
  if (!head.ok) {
    return { ok: false, reason: "no_commits", detail: "the repository has no commit yet" };
  }
  return { ok: true, topLevel };
}

// The commit a local branch points to, or undefined when it does not exist.
export async function branchCommit(
  root: string,
  branch: string,
  options: GitOptions = {},
): Promise<string | undefined> {
  if (!isSafeBranchName(branch)) return undefined;
  const result = await runGit(
    root,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
    options,
  );
  const sha = result.stdout.trim();
  return result.ok && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
}

export async function detectBaseBranch(
  root: string,
  requested: string | null,
  options: GitOptions = {},
): Promise<BaseBranch> {
  if (requested !== null) {
    if (!isSafeBranchName(requested)) {
      return { ok: false, reason: "invalid_branch", detail: `"${requested}" is not a branch name` };
    }
    const sha = await branchCommit(root, requested, options);
    return sha === undefined
      ? { ok: false, reason: "no_base_branch", detail: `no local branch "${requested}"` }
      : { ok: true, branch: requested, sha, source: "requested" };
  }
  const candidates: { branch: string; source: Extract<BaseBranch, { ok: true }>["source"] }[] = [
    { branch: "main", source: "main" },
  ];
  const originHead = await runGit(
    root,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    options,
  );
  const remoteDefault = originHead.ok ? originHead.stdout.trim().replace(/^origin\//, "") : "";
  if (remoteDefault !== "") candidates.push({ branch: remoteDefault, source: "origin_head" });
  const initDefault = await runGit(root, ["config", "--get", "init.defaultBranch"], options);
  const configured = initDefault.ok ? initDefault.stdout.trim() : "";
  if (configured !== "") candidates.push({ branch: configured, source: "init_default" });
  candidates.push({ branch: "master", source: "master" });
  for (const candidate of candidates) {
    const sha = await branchCommit(root, candidate.branch, options);
    if (sha !== undefined)
      return { ok: true, branch: candidate.branch, sha, source: candidate.source };
  }
  return {
    ok: false,
    reason: "no_base_branch",
    detail: "no local main branch (nor the remote's default, init.defaultBranch or master)",
  };
}

// The commit checked out in a worktree, or undefined.
export async function headCommit(
  cwd: string,
  options: GitOptions = {},
): Promise<string | undefined> {
  const result = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], options);
  const sha = result.stdout.trim();
  return result.ok && sha !== "" ? sha : undefined;
}

// Whether `ancestor` is reachable from `descendant` (both refs or commits); undefined when git cannot tell.
export async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
  options: GitOptions = {},
): Promise<boolean | undefined> {
  const ref = (value: string): boolean => isSafeBranchName(value) || /^[0-9a-f]{7,64}$/.test(value);
  if (!ref(ancestor) || !ref(descendant)) return undefined;
  const result = await runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant], options);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return undefined;
}
