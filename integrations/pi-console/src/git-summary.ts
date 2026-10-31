import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The change counts the bar's git segment shows (powerline line): how many paths are staged, modified and untracked.
// They come from git's own porcelain, run without a shell, one `git status` at a time under a time limit, and live in a
// small cache so the footer's render never waits for git (the render asks the cache, which answers at once with what
// it has and refreshes in the background).
//
// Trust: git runs what a repository's own config names (a filter driver, for one). The console reads git only in the
// folder the user opened Pi in, the same trust that folder's shell prompt and editor already give it; core.fsmonitor is
// turned off and the index lock is never taken, so a read cannot start a file-system monitor or get in the way of the
// user's own git. Any failure (no git, not a repository, a time-out, an output past the cap) is "no counts".

export interface GitSummary {
  readonly staged: number;
  readonly modified: number;
  readonly untracked: number;
}

const TIMEOUT_MS = 3_000;
// The porcelain output of a large tree stays far below this; past it the read gives up rather than buffer more.
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TTL_MS = 5_000;
// After a read that failed (a time-out, git missing, an output past the cap) the next one waits this long, not the
// normal time to live: a status slower than TIMEOUT_MS would otherwise be started again every few seconds and the runs
// would pile up. A successful read goes back to TTL_MS, and a branch change reads at once whatever the delay.
const RETRY_AFTER_FAILURE_MS = 30_000;
// The folders the cache remembers; the console asks for one, so this only bounds a session that changes folder.
const MAX_FOLDERS = 8;

// The variables that point git at a repository, an index or objects other than the ones under the folder (the list of
// `git rev-parse --local-env-vars`), copied from integrations/git/src/status.ts because the console imports no other
// workspace. A parent git (a hook, an alias) or the user may have set them; without them, -C <folder> alone decides
// which repository is read.
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

// The letters of `git status --porcelain=v1` that mean a path changed in a column: modified, added, deleted, renamed,
// copied and type-changed. U (unmerged) is handled apart.
const CHANGED = "MADRCT";

// The counts in the output of `git status --porcelain=v1 -z --no-renames`: entries end in a NUL and read `XY path`, X
// the index column and Y the work-tree column. A path counts as staged when X changed it, as modified when Y did, and as
// untracked when both are `?`. An unmerged path (a U, or both added or both deleted) counts once, as modified: it needs
// the user's attention, and it is neither staged nor a plain change. Ignored paths (`!!`) and anything that is not an
// entry of that shape count for nothing.
export function parseGitStatus(output: string): GitSummary {
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  for (const entry of output.split("\0")) {
    if (entry.length < 3 || entry[2] !== " ") continue;
    const index = entry[0] ?? " ";
    const tree = entry[1] ?? " ";
    if (index === "?" && tree === "?") {
      untracked += 1;
    } else if (
      index === "U" ||
      tree === "U" ||
      (index === "A" && tree === "A") ||
      (index === "D" && tree === "D")
    ) {
      modified += 1;
    } else {
      if (CHANGED.includes(index)) staged += 1;
      if (CHANGED.includes(tree)) modified += 1;
    }
  }
  return { staged, modified, untracked };
}

interface ReadGitSummaryOptions {
  // The git program to run. Tests point it at a missing file; the default finds git on PATH.
  readonly program?: string;
  readonly timeoutMs?: number;
  // The longest output read before the run is given up; the porcelain of a large tree stays far below the default.
  readonly maxOutputBytes?: number;
  // The environment git starts from, less REPOSITORY_ENV. Defaults to this process's.
  readonly env?: NodeJS.ProcessEnv;
}

// Settings that keep this read from running anything of the user's: the same Git LFS filters the writing side
// neutralises (integrations/git/src/run.ts). A status that has to hash a file would otherwise start git-lfs for it.
// Counting is all that is asked, so a path tracked by LFS whose stat changed may read as modified.
const LFS_SETTINGS = [
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
];

// The folder git is started from. On Windows an executable named without a path is searched in the folder the process
// starts from before PATH, so starting git from the project folder would run a git.exe planted there. The system folder
// is not writable by the user; elsewhere the folder has no say in where git is found, and the temp folder will do.
function neutralFolder(): string {
  if (process.platform === "win32") {
    const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    if (existsSync(system)) return system;
  }
  return tmpdir();
}

// How long taskkill gets before the launcher is killed without it.
const TASKKILL_TIMEOUT_MS = 2_000;

// Ends a process and everything it started. On Git for Windows `cmd\git.exe` is a launcher whose child does the work,
// and killing the launcher alone leaves that child running. taskkill /T finds the tree through the parent ids, so it
// has to run while the launcher is still alive: `done` is called when it ends (or fails to start), and only then is the
// launcher killed. The absolute path keeps a taskkill.exe on PATH, or in a project folder, from being run. Best effort:
// its own errors are ignored.
function taskkillTree(pid: number, done: () => void): void {
  try {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    execFile(
      taskkill,
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, shell: false, timeout: TASKKILL_TIMEOUT_MS },
      () => done(),
    );
  } catch {
    done();
  }
}

export interface RunLimits {
  readonly timeoutMs: number;
  readonly maxBuffer: number;
  readonly env?: NodeJS.ProcessEnv;
  // The folder the program starts from.
  readonly cwd?: string;
  // What tests replace: the platform whose way of ending a program that ran out of time is used, and the tree kill.
  readonly platform?: NodeJS.Platform;
  readonly killTree?: (pid: number, done: () => void) => void;
}

// Runs a program without a shell and answers its standard output, or undefined when it failed, timed out, wrote more
// than `maxBuffer` or could not start. Its standard input is closed at once, so nothing it asks for can wait on us.
// A program that runs out of time is ended by execFile (the program only), except on Windows, where the time limit is
// our own timer: the tree is killed first (taskkillTree) and the program itself after, as a fallback. It never rejects.
export function runWithLimits(
  program: string,
  args: readonly string[],
  limits: RunLimits,
): Promise<string | undefined> {
  const ownTimer = (limits.platform ?? process.platform) === "win32";
  return new Promise((done) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const child = execFile(
        program,
        [...args],
        {
          encoding: "utf8",
          ...(ownTimer ? {} : { timeout: limits.timeoutMs }),
          maxBuffer: limits.maxBuffer,
          windowsHide: true,
          shell: false,
          env: limits.env,
          cwd: limits.cwd,
        },
        (error, stdout) => {
          clearTimeout(timer);
          done(error === null ? stdout : undefined);
        },
      );
      child.stdin?.end();
      if (ownTimer) {
        timer = setTimeout(() => {
          const killItself = (): void => {
            try {
              child.kill();
            } catch {
              // Already gone.
            }
          };
          try {
            if (child.pid === undefined) killItself();
            else (limits.killTree ?? taskkillTree)(child.pid, killItself);
          } catch {
            killItself();
          }
        }, limits.timeoutMs);
      }
    } catch {
      clearTimeout(timer);
      done(undefined);
    }
  });
}

// The counts of the work tree at `folder`, or undefined when git could not say: no git program, not a repository, a
// time-out or an output past the cap. It never rejects.
export async function readGitSummary(
  folder: string,
  options: ReadGitSummaryOptions = {},
): Promise<GitSummary | undefined> {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter(
      ([name]) => !REPOSITORY_ENV.has(name.toUpperCase()),
    ),
  );
  // Git never asks for credentials on a terminal, and never downloads LFS objects.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_LFS_SKIP_SMUDGE = "1";
  const output = await runWithLimits(
    options.program ?? "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      ...LFS_SETTINGS,
      "-C",
      resolve(folder),
      "status",
      "--porcelain=v1",
      "-z",
      // Untracked paths count even where status.showUntrackedFiles hides them; an untracked folder is one entry.
      "--untracked-files=normal",
      "--no-renames",
    ],
    {
      timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
      maxBuffer: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
      env,
      cwd: neutralFolder(),
    },
  );
  return output === undefined ? undefined : parseGitStatus(output);
}

export interface GitSummaryCache {
  // What is known about `cwd` now (undefined when nothing yet, or when git failed), at once and without waiting for
  // git. When the answer is older than the time to live, or absent, a read starts after the caller has returned.
  peek(cwd: string): GitSummary | undefined;
  // The answers are old (the branch changed): the next peek reads again whatever the time to live, and a read in flight
  // is followed by one more.
  invalidate(): void;
  // Nothing is reported after this.
  dispose(): void;
}

interface GitSummaryCacheOptions {
  readonly read?: (cwd: string) => Promise<GitSummary | undefined>;
  readonly ttlMs?: number;
  // How long to wait before reading again after a read that gave no answer; defaults to RETRY_AFTER_FAILURE_MS.
  readonly retryAfterFailureMs?: number;
  readonly now?: () => number;
  // A read ended with an answer that differs from the one peek gave before: the bar should be drawn again.
  readonly onChange: () => void;
}

interface Entry {
  summary: GitSummary | undefined;
  // When the last read ended; -Infinity before the first, or after an invalidation.
  at: number;
  // The last read gave no answer: the next one waits for the longer delay.
  failed: boolean;
  running: boolean;
  // An invalidation came while the read was running: its answer may be old, so one more read follows.
  dirty: boolean;
}

function same(a: GitSummary | undefined, b: GitSummary | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.staged === b.staged && a.modified === b.modified && a.untracked === b.untracked;
}

export function createGitSummaryCache(options: GitSummaryCacheOptions): GitSummaryCache {
  const read = options.read ?? readGitSummary;
  const ttlMs = options.ttlMs ?? TTL_MS;
  const retryMs = options.retryAfterFailureMs ?? RETRY_AFTER_FAILURE_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let disposed = false;

  async function run(cwd: string, entry: Entry): Promise<void> {
    let answer: GitSummary | undefined;
    try {
      answer = await read(cwd);
    } catch {
      answer = undefined;
    }
    entry.at = now();
    entry.failed = answer === undefined;
    entry.running = false;
    const changed = !same(entry.summary, answer);
    entry.summary = answer;
    if (disposed) return;
    if (entry.dirty) {
      entry.dirty = false;
      start(cwd, entry);
    }
    // The repaint is the caller's: whatever it throws stays out of a promise nobody awaits (an unhandled rejection
    // ends a Node process).
    if (changed) {
      try {
        options.onChange();
      } catch {
        // The answer is kept; the next ask paints it.
      }
    }
  }

  // The read begins from a microtask, so it never runs inside the render that asked for it. `running` is set at once:
  // every ask until then, and until the read ends, is the same read.
  function start(cwd: string, entry: Entry): void {
    entry.running = true;
    queueMicrotask(() => {
      run(cwd, entry).catch(() => undefined);
    });
  }

  function entryFor(cwd: string): Entry {
    const known = entries.get(cwd);
    if (known !== undefined) return known;
    const entry: Entry = {
      summary: undefined,
      at: Number.NEGATIVE_INFINITY,
      failed: false,
      running: false,
      dirty: false,
    };
    entries.set(cwd, entry);
    for (const [name, item] of entries) {
      if (entries.size <= MAX_FOLDERS) break;
      if (!item.running && item !== entry) entries.delete(name);
    }
    return entry;
  }

  return {
    peek(cwd) {
      if (disposed) return undefined;
      const entry = entryFor(cwd);
      if (!entry.running && now() - entry.at >= (entry.failed ? retryMs : ttlMs)) start(cwd, entry);
      return entry.summary;
    },
    invalidate() {
      for (const entry of entries.values()) {
        if (entry.running) entry.dirty = true;
        else entry.at = Number.NEGATIVE_INFINITY;
      }
    },
    dispose() {
      disposed = true;
      entries.clear();
    },
  };
}
