import { execFile } from "node:child_process";

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
  // The environment git starts from, less REPOSITORY_ENV. Defaults to this process's.
  readonly env?: NodeJS.ProcessEnv;
}

// The counts of the work tree at `cwd`, or undefined when git could not say: no git program, not a repository, a
// time-out or an output past the cap. It never rejects.
export function readGitSummary(
  cwd: string,
  options: ReadGitSummaryOptions = {},
): Promise<GitSummary | undefined> {
  const env = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter(
      ([name]) => !REPOSITORY_ENV.has(name.toUpperCase()),
    ),
  );
  return new Promise((resolve) => {
    try {
      execFile(
        options.program ?? "git",
        [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-C",
          cwd,
          "status",
          "--porcelain=v1",
          "-z",
          // Untracked paths count even where status.showUntrackedFiles hides them; an untracked folder is one entry.
          "--untracked-files=normal",
          "--no-renames",
        ],
        {
          encoding: "utf8",
          timeout: options.timeoutMs ?? TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          shell: false,
          env,
        },
        (error, stdout) => resolve(error === null ? parseGitStatus(stdout) : undefined),
      );
    } catch {
      resolve(undefined);
    }
  });
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
  readonly now?: () => number;
  // A read ended with an answer that differs from the one peek gave before: the bar should be drawn again.
  readonly onChange: () => void;
}

interface Entry {
  summary: GitSummary | undefined;
  // When the last read ended; -Infinity before the first, or after an invalidation.
  at: number;
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
    entry.running = false;
    const changed = !same(entry.summary, answer);
    entry.summary = answer;
    if (disposed) return;
    if (entry.dirty) {
      entry.dirty = false;
      start(cwd, entry);
    }
    if (changed) options.onChange();
  }

  // The read begins from a microtask, so it never runs inside the render that asked for it. `running` is set at once:
  // every ask until then, and until the read ends, is the same read.
  function start(cwd: string, entry: Entry): void {
    entry.running = true;
    queueMicrotask(() => void run(cwd, entry));
  }

  function entryFor(cwd: string): Entry {
    const known = entries.get(cwd);
    if (known !== undefined) return known;
    const entry: Entry = {
      summary: undefined,
      at: Number.NEGATIVE_INFINITY,
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
      if (!entry.running && now() - entry.at >= ttlMs) start(cwd, entry);
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
