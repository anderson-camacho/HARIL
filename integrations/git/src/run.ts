import { execFile } from "node:child_process";

// One git run for the writing side of HARIL (docs/modos-y-delegacion.md 3.10, phase F8): execFile with no shell, the
// repository named by -C, a time limit and an output limit. Every run carries the settings spike S4 found necessary or
// that keep HARIL's own git work predictable:
//   - core.longpaths=true: a worktree path past 260 characters works on Windows (S4: 339 characters failed without it);
//   - core.hooksPath to the null device: no hook of the repository runs for a worktree, a commit or a merge HARIL makes
//     (post-checkout, pre-commit, post-merge...), so a project's hook can neither fail nor slow an agent's commit;
//   - commit.gpgsign=false and gc.auto=0: nothing asks for a passphrase, and no garbage collection starts mid-workflow;
//   - core.quotePath=false: paths with non-ASCII characters come back as they are, not as octal escapes;
//   - a fixed identity: HARIL's commits and merges say who made them.
// The variables that point git at another repository, index or object store are removed (the list of
// `git rev-parse --local-env-vars`), GIT_TERMINAL_PROMPT=0 keeps git from asking for credentials, and the process never
// reads stdin. HARIL never fetches, pulls or pushes: no function here contacts a remote.

export interface GitOptions {
  // The git program; defaults to git on PATH.
  readonly program?: string;
  // The environment git starts from, less the repository variables. Defaults to this process's.
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  // A linked worktree's own git folder and its work tree, both absolute. Given together, every run names them
  // (--git-dir, --work-tree), so git never reads the worktree's .git pointer file, which a command in the worktree could
  // rewrite to point at another repository.
  readonly gitDir?: string;
  readonly workTree?: string;
}

export interface GitResult {
  readonly ok: boolean;
  // The exit code; null when git did not start, timed out or was killed.
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const HARIL_AUTHOR = { name: "HARIL", email: "haril@users.noreply.invalid" } as const;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
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

const SETTINGS = [
  "-c",
  "core.longpaths=true",
  "-c",
  `core.hooksPath=${NULL_DEVICE}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "gc.auto=0",
  "-c",
  `user.name=${HARIL_AUTHOR.name}`,
  "-c",
  `user.email=${HARIL_AUTHOR.email}`,
];

function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(base).filter(([name]) => !REPOSITORY_ENV.has(name.toUpperCase())),
  );
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function targetOf(options: GitOptions): string[] {
  return options.gitDir !== undefined && options.workTree !== undefined
    ? [`--git-dir=${options.gitDir}`, `--work-tree=${options.workTree}`]
    : [];
}

// Runs `git -C <cwd> <args>` and resolves with its result; never throws.
export function runGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        options.program ?? "git",
        [...SETTINGS, "-C", cwd, ...targetOf(options), ...args],
        {
          encoding: "utf8",
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          shell: false,
          env: gitEnv(options.env ?? process.env),
        },
        (error, stdout, stderr) => {
          const code =
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === "number"
                ? ((error as { code: number }).code as number)
                : null;
          resolve({ ok: error === null, code, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
      child.stdin?.end();
    } catch (error) {
      resolve({
        ok: false,
        code: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

// A branch name HARIL may hand to git: ASCII letters, digits, "-", "_", "." and "/", never starting with "-" (it would
// read as an option), never "..", never a segment starting with "." or ending with ".lock" (git's own rules).
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

export function isSafeBranchName(name: string): boolean {
  if (!BRANCH.test(name) || name.includes("..") || name.endsWith("/") || name.includes("//")) {
    return false;
  }
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

// The first line of a run's error output, for a reason a person can read; never a path's content.
export function detailOf(result: GitResult): string {
  const line = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find((text) => text !== "");
  return (line ?? `git exited with code ${result.code ?? "none"}`).slice(0, 300);
}

// Lines of a run's output, without the empty ones.
export function linesOf(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== "");
}

// NUL-separated records of a -z run, without the empty ones.
export function recordsOf(text: string): string[] {
  return text.split("\0").filter((record) => record !== "");
}
