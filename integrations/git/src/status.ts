import { execFile } from "node:child_process";

// The working-tree status the shell shows in its Status box (LD-T6b-1): the branch and how many paths changed. Two
// short git runs, each under a time limit, with no shell in between: the project root is one argument, never parsed.
// Anything that is not a readable work tree (no git, no such path, not a repository, a repository without commits,
// a time-out) answers undefined; the caller shows that it does not know.
//
// Trust: git runs what a repository's own config names. A filter.<name>.clean driver in .git/config with a matching
// .gitattributes runs on `git status`, and other settings can name programs too. The shell reads git only for the
// project roots the user registered, the same trust the user's editor gives that repository. HARIL's agents cannot
// write under .git (PathGuard denies the directory, integrations/agent-pi/src/path-guard.ts), so an agent alone
// cannot plant such a driver.

const TIMEOUT_MS = 1500;
// The porcelain output of a large tree stays far below this; past it the read gives up rather than buffer more.
const MAX_OUTPUT_BYTES = 1024 * 1024;
// The variables that point git at a repository, an index or objects other than the ones under the root (the list of
// `git rev-parse --local-env-vars`). A parent git (a hook, an alias) or the user may have set them; without them,
// -C <root> alone decides which repository is read.
const REPOSITORY_ENV = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);

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
  // The environment git starts from, less REPOSITORY_ENV. Defaults to this process's.
  readonly env?: NodeJS.ProcessEnv;
}

export async function readGitStatus(
  rootPath: string,
  options: ReadGitStatusOptions = {},
): Promise<GitStatus | undefined> {
  const program = options.program ?? "git";
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const env = withoutRepositoryEnv(options.env ?? process.env);
  // --no-optional-locks: a status never takes the index lock, so it cannot get in the way of the user's own git.
  // core.fsmonitor off: no file-system monitor hook starts for a read this short. It does not make a repository's
  // config safe to read (see Trust above).
  const base = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", rootPath];
  const branch = await run(program, [...base, "rev-parse", "--abbrev-ref", "HEAD"], timeoutMs, env);
  if (branch === undefined || branch.trim() === "") return undefined;
  // --untracked-files=normal: untracked paths count even where status.showUntrackedFiles hides them.
  const status = await run(
    program,
    [...base, "status", "--porcelain", "--untracked-files=normal"],
    timeoutMs,
    env,
  );
  if (status === undefined) return undefined;
  return {
    branch: branch.trim(),
    changes: status.split(/\r?\n/).filter((line) => line !== "").length,
  };
}

// A copy of `env` without the repository-location variables. Names are compared in upper case: Windows keeps the
// case they were set with.
function withoutRepositoryEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !REPOSITORY_ENV.has(name.toUpperCase())),
  );
}

// The standard output of one run, or undefined when it failed, timed out or could not start.
function run(
  program: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
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
          env,
        },
        (error, stdout) => resolve(error === null ? stdout : undefined),
      );
    } catch {
      resolve(undefined);
    }
  });
}
