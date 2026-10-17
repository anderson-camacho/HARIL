import { execFile } from "node:child_process";

// The working-tree status the shell shows in its Status box (LD-T6b-1): the branch and how many paths changed. Two
// short git runs, each under a time limit, with no shell in between: the project root is one argument, never parsed.
// Anything that is not a readable work tree (no git, no such path, not a repository, a repository without commits,
// a time-out) answers undefined; the caller shows that it does not know.

const TIMEOUT_MS = 1500;
// The porcelain output of a large tree stays far below this; past it the read gives up rather than buffer more.
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface GitStatus {
  // The checked-out branch, or "HEAD" when it is detached.
  readonly branch: string;
  // Modified, staged, deleted and untracked paths: one per line of `git status --porcelain`.
  readonly changes: number;
}

export interface ReadGitStatusOptions {
  // The git program to run. Tests point it at a missing file; the default finds git on PATH.
  readonly program?: string;
  readonly timeoutMs?: number;
}

export async function readGitStatus(
  rootPath: string,
  options: ReadGitStatusOptions = {},
): Promise<GitStatus | undefined> {
  const program = options.program ?? "git";
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  // --no-optional-locks: a status never takes the index lock, so it cannot get in the way of the user's own git.
  // core.fsmonitor off: a repository's config cannot make this read run a program of its choice.
  const base = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", rootPath];
  const branch = await run(program, [...base, "rev-parse", "--abbrev-ref", "HEAD"], timeoutMs);
  if (branch === undefined || branch.trim() === "") return undefined;
  const status = await run(program, [...base, "status", "--porcelain"], timeoutMs);
  if (status === undefined) return undefined;
  return {
    branch: branch.trim(),
    changes: status.split(/\r?\n/).filter((line) => line !== "").length,
  };
}

// The standard output of one run, or undefined when it failed, timed out or could not start.
function run(
  program: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        program,
        args,
        {
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          shell: false,
        },
        (error, stdout) => resolve(error === null ? stdout : undefined),
      );
    } catch {
      resolve(undefined);
    }
  });
}
