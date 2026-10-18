import { existsSync, realpathSync } from "node:fs";
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { branchCommit } from "./repository.js";
import {
  detailOf,
  type GitOptions,
  type GitResult,
  isSafeBranchName,
  linesOf,
  runGit,
} from "./run.js";

// One git worktree per executor (docs/modos-y-delegacion.md 3.10.2, spike S4): `git worktree add -b <branch> <path>
// <base>` from the commit the workflow fixed, never from another branch (P13). Creation is idempotent, so a runtime that
// restarts finds and reuses the worktree it made; a folder left behind by a removal git never saw is cleared first.
// Removal follows S4: `git worktree remove --force --force`; when a file or a process still holds the folder (Windows
// refuses to delete it), the folder is deleted with retries, `git worktree prune` drops git's record, and the removal is
// checked again, up to a retry budget. A branch can be checked out in one worktree only (S4), which is why every
// executor gets a branch of its own.

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  // The short branch name ("haril/wf/task/t1"); null for a detached worktree.
  readonly branch: string | null;
  readonly prunable: boolean;
  readonly locked: boolean;
}

export interface NewWorktree {
  readonly path: string;
  readonly branch: string;
  // The commit (or ref) a new branch starts from; an existing branch keeps its own commits.
  readonly base: string;
}

export type WorktreeResult =
  | { readonly ok: true; readonly reused: boolean }
  | { readonly ok: false; readonly detail: string };

// git for Windows refuses a worktree whose own folder path is longer than about 240 characters ("'$GIT_DIR' too big"),
// even with core.longpaths, which only lifts the limit for the files inside it. Measured with git 2.55: 195 characters
// work, 245 fail. The caller keeps worktree folders short (hashed names under the data directory).
export const WORKTREE_PATH_MAX_LENGTH = 200;

export interface RemoveOptions extends GitOptions {
  // How many times the folder is deleted again while something holds it, and how long to wait in between.
  readonly retries?: number;
  readonly retryDelayMs?: number;
}

// A path as the file system names it: links resolved and, on Windows, 8.3 short names (C:\Users\RUNNER~1) expanded. A
// path that does not exist (a worktree folder deleted behind git's back) is resolved through its deepest existing
// folder, so it still compares equal to the real path git recorded for it.
function realPath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

function samePath(left: string, right: string): boolean {
  const canonical = (path: string): string => {
    const normalized = realPath(path)
      .replace(/[\\/]+$/, "")
      .replace(/\\/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return canonical(left) === canonical(right);
}

export interface WorktreeIdentity {
  // The worktree's own git folder (<repository>/.git/worktrees/<name>).
  readonly gitDir: string;
  // The bytes of the worktree's .git pointer file ("gitdir: <gitDir>"), as git wrote them.
  readonly pointer: string;
}

// A linked worktree's own git folder, found from the main repository: the admin folder whose gitdir file names this
// worktree's .git. It is never read from the worktree's .git pointer file, which a command run in the worktree could
// rewrite; that file is only checked to point there, and its bytes kept so later runs can tell it changed. Undefined when
// the repository knows no such worktree or the pointer file is not a plain file pointing there.
export async function worktreeIdentity(
  root: string,
  path: string,
  options: GitOptions = {},
): Promise<WorktreeIdentity | undefined> {
  // The main repository's own folder, whatever worktree options came with the call.
  const { gitDir: _gitDir, workTree: _workTree, ...repository } = options;
  const common = await runGit(
    root,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    repository,
  );
  if (!common.ok) return undefined;
  const admin = join(common.stdout.trim(), "worktrees");
  const names = await readdir(admin).catch(() => [] as string[]);
  for (const name of names) {
    const back = await readFile(join(admin, name, "gitdir"), "utf8").catch(() => undefined);
    if (back === undefined || !samePath(dirname(back.trim()), path)) continue;
    const gitDir = join(admin, name);
    const pointerPath = join(path, ".git");
    const stats = await lstat(pointerPath).catch(() => undefined);
    if (stats === undefined || !stats.isFile()) return undefined;
    const pointer = await readFile(pointerPath, "utf8").catch(() => undefined);
    const target = /^gitdir: (.+?)\s*$/.exec(pointer ?? "")?.[1];
    if (pointer === undefined || target === undefined) return undefined;
    return samePath(resolve(path, target), gitDir) ? { gitDir, pointer } : undefined;
  }
  return undefined;
}

// Whether the worktree's .git pointer file still holds exactly `pointer`. When it does not, it is put back (a link or a
// folder in its place is removed first) and the answer is "restored", or "unrestorable" when that failed.
export async function checkPointer(
  path: string,
  pointer: string,
): Promise<"intact" | "restored" | "unrestorable"> {
  const pointerPath = join(path, ".git");
  const stats = await lstat(pointerPath).catch(() => undefined);
  if (stats?.isFile() === true) {
    const current = await readFile(pointerPath, "utf8").catch(() => undefined);
    if (current === pointer) return "intact";
  }
  try {
    if (stats !== undefined) await rm(pointerPath, { recursive: true, force: true });
    await writeFile(pointerPath, pointer, { encoding: "utf8", flag: "wx" });
    return "restored";
  } catch {
    return "unrestorable";
  }
}

// Every worktree of the repository, the main one first, from `git worktree list --porcelain`; undefined when git fails.
export async function listWorktrees(
  root: string,
  options: GitOptions = {},
): Promise<WorktreeEntry[] | undefined> {
  const result = await runGit(root, ["worktree", "list", "--porcelain"], options);
  if (!result.ok) return undefined;
  const entries: WorktreeEntry[] = [];
  let current: {
    path: string;
    head: string | null;
    branch: string | null;
    prunable: boolean;
    locked: boolean;
  } | null = null;
  for (const line of [...result.stdout.split(/\r?\n/), ""]) {
    if (line === "") {
      if (current !== null) entries.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), head: null, branch: null, prunable: false, locked: false };
    } else if (current !== null && line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (current !== null && line.startsWith("branch ")) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (current !== null && line.startsWith("prunable")) {
      current.prunable = true;
    } else if (current !== null && line.startsWith("locked")) {
      current.locked = true;
    }
  }
  return entries;
}

export async function addWorktree(
  root: string,
  worktree: NewWorktree,
  options: GitOptions = {},
): Promise<WorktreeResult> {
  if (!isSafeBranchName(worktree.branch)) {
    return { ok: false, detail: `"${worktree.branch}" is not a branch name HARIL creates` };
  }
  if (resolve(worktree.path).length > WORKTREE_PATH_MAX_LENGTH) {
    return {
      ok: false,
      detail: `the worktree folder path is too long for git (over ${WORKTREE_PATH_MAX_LENGTH} characters): use a shorter data directory`,
    };
  }
  const listed = await listWorktrees(root, options);
  if (listed === undefined) return { ok: false, detail: "git worktree list failed" };
  const known = listed.find((entry) => samePath(entry.path, worktree.path));
  if (known !== undefined && !known.prunable && existsSync(worktree.path)) {
    return known.branch === worktree.branch
      ? { ok: true, reused: true }
      : { ok: false, detail: `${worktree.path} already holds another worktree` };
  }
  if (known !== undefined || existsSync(worktree.path)) {
    // A record without its folder, or a folder without its record: both go before the worktree is made again.
    await rm(worktree.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => undefined,
    );
    await runGit(root, ["worktree", "prune", "--expire", "now"], options);
  }
  const exists = (await branchCommit(root, worktree.branch, options)) !== undefined;
  const args = exists
    ? ["worktree", "add", "--quiet", worktree.path, worktree.branch]
    : ["worktree", "add", "--quiet", "-b", worktree.branch, worktree.path, worktree.base];
  const added = await runGit(root, args, options);
  if (added.ok) return { ok: true, reused: false };
  // git still holds a record of this path whose folder is gone (it spelled the path in a way the check above did not
  // match): that record is pruned and the add tried once more. Never `add -f`, which would also take a branch checked
  // out elsewhere. Told by git's message or, whatever its language, by a listed entry for the path with no folder.
  if (
    !existsSync(worktree.path) &&
    (await registeredButMissing(root, worktree.path, added, options))
  ) {
    await runGit(root, ["worktree", "prune", "--expire", "now"], options);
    const again = await runGit(root, args, options);
    if (again.ok) return { ok: true, reused: false };
    return { ok: false, detail: detailOf(again) };
  }
  return { ok: false, detail: detailOf(added) };
}

// Whether a failed `git worktree add` met a record of `path` whose folder is missing: git said so, or its list holds a
// prunable entry for that path.
async function registeredButMissing(
  root: string,
  path: string,
  failed: GitResult,
  options: GitOptions,
): Promise<boolean> {
  if (/missing but already registered worktree/i.test(failed.stderr)) return true;
  const listed = await listWorktrees(root, options);
  return (
    listed?.some(
      (entry) => samePath(entry.path, path) && (entry.prunable || !existsSync(entry.path)),
    ) ?? false
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function removeWorktree(
  root: string,
  path: string,
  options: RemoveOptions = {},
): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
  const retries = options.retries ?? 10;
  const delay = options.retryDelayMs ?? 300;
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(delay);
    const removed = await runGit(root, ["worktree", "remove", "--force", "--force", path], options);
    if (!removed.ok) {
      last = detailOf(removed);
      await rm(path, { recursive: true, force: true }).catch((error: unknown) => {
        last = error instanceof Error ? error.message : String(error);
      });
      await runGit(root, ["worktree", "prune"], options);
    }
    const listed = await listWorktrees(root, options);
    const stillKnown = listed?.some((entry) => samePath(entry.path, path)) ?? true;
    if (!stillKnown && !existsSync(path)) return { ok: true };
  }
  return { ok: false, detail: last === "" ? `${path} could not be removed` : last.slice(0, 300) };
}

// Deletes one of HARIL's local branches (git branch -D); false when git refuses (it is checked out somewhere, or it does
// not exist) and for any branch outside haril/, which HARIL never deletes.
export async function deleteBranch(
  root: string,
  branch: string,
  options: GitOptions = {},
): Promise<boolean> {
  if (!isSafeBranchName(branch) || !branch.startsWith("haril/")) return false;
  return (await runGit(root, ["branch", "-D", "--", branch], options)).ok;
}

// The local branches under a prefix ("haril/<workflow>/"), short names.
export async function branchesUnder(
  root: string,
  prefix: string,
  options: GitOptions = {},
): Promise<string[]> {
  const result = await runGit(
    root,
    ["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}`],
    options,
  );
  return result.ok ? linesOf(result.stdout) : [];
}
