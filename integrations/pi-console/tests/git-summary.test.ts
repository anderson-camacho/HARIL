import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGitSummaryCache,
  type GitSummary,
  parseGitStatus,
  readGitSummary,
  runWithLimits,
} from "../src/git-summary.js";

// Every execFile of the module goes through the real one, and the spy keeps what it was called with: the tests below
// read the program, the arguments and the options the reader hands to the operating system.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

// The change counts of the bar's git segment (powerline line): staged, modified and untracked paths, read from git's
// own porcelain without a shell, kept in a small cache so the footer's render never waits for git.

const ZERO: GitSummary = { staged: 0, modified: 0, untracked: 0 };

describe("parseGitStatus", () => {
  it("counts nothing for a clean tree", () => {
    expect(parseGitStatus("")).toEqual(ZERO);
  });

  it("reads the index column as staged, the work-tree column as modified and ?? as untracked", () => {
    const output = [
      "M  staged.ts",
      " M modified.ts",
      "MM both.ts",
      "A  added.ts",
      "D  gone-staged.ts",
      " D gone-modified.ts",
      "?? new.ts",
      "?? new-folder/",
      "",
    ].join("\0");
    expect(parseGitStatus(output)).toEqual({ staged: 4, modified: 3, untracked: 2 });
  });

  it("counts an unmerged path once, as modified", () => {
    const output = [
      "UU both-changed.ts",
      "AA both-added.ts",
      "DD both-deleted.ts",
      "UD theirs.ts",
      "",
    ];
    expect(parseGitStatus(output.join("\0"))).toEqual({ staged: 0, modified: 4, untracked: 0 });
  });

  it("does not count ignored paths or entries that are not a status", () => {
    const output = ["!! ignored.log", "x", "zz not-a-status", "ab c", "   ", ""].join("\0");
    expect(parseGitStatus(output)).toEqual(ZERO);
  });

  it("is not fooled by a path with spaces, quotes or a newline in it", () => {
    const output = [" M with space.ts", '?? "quoted".ts', "M  line\nbreak.ts", ""].join("\0");
    expect(parseGitStatus(output)).toEqual({ staged: 1, modified: 1, untracked: 1 });
  });
});

describe("readGitSummary", () => {
  let root: string;

  function git(...args: string[]): void {
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "core.autocrlf=false",
        ...args,
      ],
      { cwd: root, stdio: "ignore", windowsHide: true },
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "haril-git-summary-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // A parent that is a repository must not be found by the test that expects "not a repository".
  function isolated(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) };
  }

  it("counts the changes of a real work tree", async () => {
    git("init", "--quiet");
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(root, name), "one\n");
    git("add", "a.txt", "b.txt", "c.txt");
    git("commit", "--quiet", "-m", "first");
    writeFileSync(join(root, "a.txt"), "two\n"); // modified
    writeFileSync(join(root, "b.txt"), "two\n");
    git("add", "b.txt"); // staged
    writeFileSync(join(root, "c.txt"), "two\n");
    git("add", "c.txt");
    writeFileSync(join(root, "c.txt"), "three\n"); // staged and modified
    writeFileSync(join(root, "d.txt"), "new\n"); // untracked
    writeFileSync(join(root, "e.txt"), "new\n");
    git("add", "e.txt"); // added
    mkdirSync(join(root, "fresh"));
    writeFileSync(join(root, "fresh", "x.txt"), "new\n"); // an untracked folder counts as one
    expect(await readGitSummary(root, { env: isolated() })).toEqual({
      staged: 3,
      modified: 2,
      untracked: 2,
    });
  });

  it("answers zeros for a clean work tree", async () => {
    git("init", "--quiet");
    expect(await readGitSummary(root, { env: isolated() })).toEqual(ZERO);
  });

  it("answers undefined where git has nothing to say: not a repository, no such folder, no git program", async () => {
    expect(await readGitSummary(root, { env: isolated() })).toBeUndefined();
    expect(await readGitSummary(join(root, "missing"), { env: isolated() })).toBeUndefined();
    expect(
      await readGitSummary(root, { program: join(root, "no-such-git-program"), env: isolated() }),
    ).toBeUndefined();
  });

  // What the reader hands to the operating system: the spy keeps the program, the arguments and the options.
  function lastStart() {
    const spy = vi.mocked(execFile);
    const index = spy.mock.calls.length - 1;
    const [program, args, options] = spy.mock.calls[index] as unknown as [
      string,
      string[],
      { cwd?: string; env: NodeJS.ProcessEnv; shell?: boolean; windowsHide?: boolean },
    ];
    return { program, args, options, child: spy.mock.results[index]?.value as ChildProcess };
  }

  it("starts git with no prompt, no LFS filter and a closed stdin, as the writing side does (integrations/git/src/run.ts)", async () => {
    git("init", "--quiet");
    await readGitSummary(root, { env: { ...isolated(), GIT_TERMINAL_PROMPT: "1" } });
    const { program, args, options, child } = lastStart();
    expect(program).toBe("git");
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(options.env.GIT_LFS_SKIP_SMUDGE).toBe("1");
    for (const setting of [
      "filter.lfs.smudge=",
      "filter.lfs.clean=",
      "filter.lfs.process=",
      "filter.lfs.required=false",
      "core.fsmonitor=false",
    ]) {
      const at = args.indexOf(setting);
      expect(at, setting).toBeGreaterThan(0);
      expect(args[at - 1], setting).toBe("-c");
    }
    expect(child.stdin?.writableEnded).toBe(true);
  });

  it("names the folder as an absolute path and runs git from a neutral folder, never the one it summarises", async () => {
    git("init", "--quiet");
    await readGitSummary(root, { env: isolated() });
    const { args, options } = lastStart();
    expect(options.cwd).toBeDefined();
    expect(isAbsolute(options.cwd ?? "")).toBe(true);
    expect(existsSync(options.cwd ?? "")).toBe(true);
    expect(options.cwd).not.toBe(root);
    expect(options.cwd).not.toBe(process.cwd());
    expect(args[args.indexOf("-C") + 1]).toBe(root);

    await readGitSummary("a-relative-folder", { env: isolated() });
    const relative = lastStart();
    expect(relative.args[relative.args.indexOf("-C") + 1]).toBe(resolve("a-relative-folder"));
  });

  it("answers undefined, and does not throw, when the output is past the cap", async () => {
    git("init", "--quiet");
    for (let index = 0; index < 20; index++) {
      writeFileSync(join(root, `file-${index}.txt`), "x\n");
    }
    expect(await readGitSummary(root, { env: isolated() })).toEqual({
      staged: 0,
      modified: 0,
      untracked: 20,
    });
    expect(await readGitSummary(root, { env: isolated(), maxOutputBytes: 16 })).toBeUndefined();
  });

  it("ignores the variables that point git at another repository", async () => {
    git("init", "--quiet");
    const elsewhere = mkdtempSync(join(tmpdir(), "haril-git-elsewhere-"));
    try {
      const env = { ...isolated(), GIT_DIR: join(elsewhere, "nope"), GIT_WORK_TREE: elsewhere };
      expect(await readGitSummary(root, { env })).toEqual(ZERO);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("runWithLimits", () => {
  const LIMITS = { timeoutMs: 5_000, maxBuffer: 1024 * 1024 };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "haril-run-limits-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A script that writes its pid to `file` and then sleeps; `before` runs first (a parent starts its child there).
  function sleeper(file: string, before = ""): string {
    return `${before}require("node:fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000);`;
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  async function goneWithin(pid: number, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!alive(pid)) return true;
      await new Promise((done) => setTimeout(done, 40));
    }
    return !alive(pid);
  }

  function pidIn(file: string): number {
    return Number(readFileSync(file, "utf8"));
  }

  it("answers the standard output of a command that ends in time", async () => {
    expect(
      await runWithLimits(process.execPath, ["-e", "process.stdout.write('hello')"], LIMITS),
    ).toBe("hello");
  });

  it("answers undefined for a command that fails, and for one that does not exist", async () => {
    expect(
      await runWithLimits(process.execPath, ["-e", "process.exit(3)"], LIMITS),
    ).toBeUndefined();
    expect(await runWithLimits(join(dir, "no-such-program"), [], LIMITS)).toBeUndefined();
  });

  it("answers undefined, and does not throw, when the output is past the cap", async () => {
    const script = "process.stdout.write('x'.repeat(5000))";
    expect(await runWithLimits(process.execPath, ["-e", script], LIMITS)).toHaveLength(5000);
    expect(
      await runWithLimits(process.execPath, ["-e", script], { ...LIMITS, maxBuffer: 100 }),
    ).toBeUndefined();
  });

  it("gives up on a command that outlives the time limit: undefined within about the limit, and the command gone", async () => {
    const file = join(dir, "pid");
    const started = Date.now();
    const answer = await runWithLimits(process.execPath, ["-e", sleeper(file)], {
      ...LIMITS,
      timeoutMs: 1_200,
    });
    const elapsed = Date.now() - started;
    expect(answer).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(1_100);
    expect(elapsed).toBeLessThan(1_200 + 2_500);
    expect(await goneWithin(pidIn(file), 3_000)).toBe(true);
  });

  it("starts the command with the environment and the folder it is given", async () => {
    const script = "process.stdout.write(process.cwd() + '|' + process.env.HARIL_PROBE)";
    const answer = await runWithLimits(process.execPath, ["-e", script], {
      ...LIMITS,
      cwd: dir,
      env: { ...process.env, HARIL_PROBE: "seen" },
    });
    expect(answer?.toLowerCase()).toBe(`${realpathSync(dir)}|seen`.toLowerCase());
  });

  describe("on Windows the time limit takes the descendants down too", () => {
    // Git for Windows starts through a launcher (cmd\git.exe) whose child does the work: killing the launcher alone
    // leaves that child running. The tree kill runs before the launcher is gone, then the launcher is killed anyway.
    it("asks for the tree kill while the command is alive, then ends the command itself", async () => {
      const file = join(dir, "pid");
      const killed: { pid: number; aliveThen: boolean }[] = [];
      const answer = await runWithLimits(process.execPath, ["-e", sleeper(file)], {
        ...LIMITS,
        timeoutMs: 1_200,
        platform: "win32",
        killTree: (pid, done) => {
          killed.push({ pid, aliveThen: alive(pid) });
          setTimeout(done, 30);
        },
      });
      expect(answer).toBeUndefined();
      expect(killed).toEqual([{ pid: pidIn(file), aliveThen: true }]);
      expect(await goneWithin(pidIn(file), 3_000)).toBe(true);
    });

    it("ends the command itself even when the tree kill does nothing", async () => {
      const file = join(dir, "pid");
      const answer = await runWithLimits(process.execPath, ["-e", sleeper(file)], {
        ...LIMITS,
        timeoutMs: 1_200,
        platform: "win32",
        killTree: (_pid, done) => done(),
      });
      expect(answer).toBeUndefined();
      expect(await goneWithin(pidIn(file), 3_000)).toBe(true);
    });

    it("does not ask for it when the command ends in time", async () => {
      const calls: number[] = [];
      const answer = await runWithLimits(process.execPath, ["-e", "process.stdout.write('ok')"], {
        ...LIMITS,
        timeoutMs: 1_200,
        platform: "win32",
        killTree: (pid, done) => {
          calls.push(pid);
          done();
        },
      });
      expect(answer).toBe("ok");
      await new Promise((done) => setTimeout(done, 1_500));
      expect(calls).toEqual([]);
    });

    it("is left to the platform's own time limit elsewhere", async () => {
      const file = join(dir, "pid");
      const calls: number[] = [];
      const answer = await runWithLimits(process.execPath, ["-e", sleeper(file)], {
        ...LIMITS,
        timeoutMs: 1_200,
        platform: "linux",
        killTree: (pid, done) => {
          calls.push(pid);
          done();
        },
      });
      expect(answer).toBeUndefined();
      expect(calls).toEqual([]);
      expect(await goneWithin(pidIn(file), 3_000)).toBe(true);
    });

    // The real thing, with a parent and a child of its own: both must be gone after the time limit. The child is
    // detached, as git.exe behind the launcher is: a Node parent kills its undetached children when it ends (libuv puts
    // them in a job object), which would hide the problem.
    it.runIf(process.platform === "win32")(
      "kills a command's child process with taskkill, not only the command",
      async () => {
        const parentFile = join(dir, "parent-pid");
        const childFile = join(dir, "child-pid");
        const child = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(sleeper(childFile))}], { stdio: "ignore", detached: true });`;
        const answer = await runWithLimits(process.execPath, ["-e", sleeper(parentFile, child)], {
          ...LIMITS,
          timeoutMs: 3_000,
        });
        expect(answer).toBeUndefined();
        try {
          expect(await goneWithin(pidIn(parentFile), 3_000)).toBe(true);
          expect(await goneWithin(pidIn(childFile), 3_000)).toBe(true);
        } finally {
          // A child that survived must not outlive the test.
          for (const file of [parentFile, childFile]) {
            try {
              process.kill(pidIn(file));
            } catch {
              // Already gone.
            }
          }
        }
      },
      20_000,
    );
  });
});

// A reader whose answers the test settles by hand.
function manualReader() {
  const calls: string[] = [];
  const pending: {
    resolve: (value: GitSummary | undefined) => void;
    reject: (e: Error) => void;
  }[] = [];
  return {
    calls,
    pending,
    read(cwd: string): Promise<GitSummary | undefined> {
      calls.push(cwd);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    answer(value: GitSummary | undefined): void {
      pending.shift()?.resolve(value);
    },
    fail(message: string): void {
      pending.shift()?.reject(new Error(message));
    },
  };
}

// One turn of the event loop: the cache starts its read from a microtask and settles it from another.
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index++) await Promise.resolve();
}

describe("the git summary cache", () => {
  const SOME: GitSummary = { staged: 1, modified: 2, untracked: 3 };
  let clock: number;
  let changes: number;

  function cache(reader: ReturnType<typeof manualReader>, ttlMs = 5_000) {
    return createGitSummaryCache({
      read: (cwd) => reader.read(cwd),
      ttlMs,
      now: () => clock,
      onChange: () => {
        changes++;
      },
    });
  }

  beforeEach(() => {
    clock = 1_000;
    changes = 0;
  });

  it("answers at once with nothing and starts its read after the caller returned, never inside it", async () => {
    const reader = manualReader();
    const summaries = cache(reader);
    expect(summaries.peek("/work")).toBeUndefined();
    expect(reader.calls).toEqual([]);
    await settle();
    expect(reader.calls).toEqual(["/work"]);
    reader.answer(SOME);
    await settle();
    expect(summaries.peek("/work")).toEqual(SOME);
    expect(changes).toBe(1);
  });

  it("runs one read for any number of asks while it is in flight", async () => {
    const reader = manualReader();
    const summaries = cache(reader);
    for (let index = 0; index < 10; index++) summaries.peek("/work");
    await settle();
    summaries.peek("/work");
    await settle();
    expect(reader.calls).toEqual(["/work"]);
  });

  it("keeps an answer for the time to live and then refreshes it, showing the old answer meanwhile", async () => {
    const reader = manualReader();
    const summaries = cache(reader, 5_000);
    summaries.peek("/work");
    await settle();
    reader.answer(SOME);
    await settle();
    clock += 4_999;
    expect(summaries.peek("/work")).toEqual(SOME);
    await settle();
    expect(reader.calls).toHaveLength(1);
    clock += 1;
    expect(summaries.peek("/work")).toEqual(SOME);
    await settle();
    expect(reader.calls).toHaveLength(2);
    reader.answer({ staged: 0, modified: 0, untracked: 0 });
    await settle();
    expect(summaries.peek("/work")).toEqual(ZERO);
    expect(changes).toBe(2);
  });

  it("repaints only when the answer differs from the one it had", async () => {
    const reader = manualReader();
    const summaries = cache(reader, 10);
    summaries.peek("/work");
    await settle();
    reader.answer(SOME);
    await settle();
    clock += 10;
    summaries.peek("/work");
    await settle();
    reader.answer({ ...SOME });
    await settle();
    expect(changes).toBe(1);
  });

  it("shows no counts when git fails, and says so once, whether it rejects or throws", async () => {
    const reader = manualReader();
    const summaries = cache(reader, 10);
    summaries.peek("/work");
    await settle();
    reader.answer(SOME);
    await settle();
    clock += 10;
    summaries.peek("/work");
    await settle();
    reader.fail("git is gone");
    await settle();
    expect(summaries.peek("/work")).toBeUndefined();
    expect(changes).toBe(2);
  });

  it("treats a reader that throws before it returns a promise as a failed read", async () => {
    const summaries = createGitSummaryCache({
      read: () => {
        throw new Error("synchronous failure");
      },
      ttlMs: 10,
      now: () => clock,
      onChange: () => {
        changes++;
      },
    });
    expect(summaries.peek("/work")).toBeUndefined();
    await settle();
    expect(summaries.peek("/work")).toBeUndefined();
    expect(changes).toBe(0);
  });

  it("does not hammer a failing git: it tries again only after a longer delay than the time to live", async () => {
    const reader = manualReader();
    const summaries = cache(reader, 5_000);
    summaries.peek("/work");
    await settle();
    reader.answer(undefined);
    await settle();
    for (let index = 0; index < 5; index++) summaries.peek("/work");
    await settle();
    expect(reader.calls).toHaveLength(1);
    // The normal time to live is not enough after a failure: a git slower than its time limit would be started again
    // every few seconds, and the runs would pile up.
    clock += 5_000;
    summaries.peek("/work");
    await settle();
    expect(reader.calls).toHaveLength(1);
    clock += 24_999;
    summaries.peek("/work");
    await settle();
    expect(reader.calls).toHaveLength(1);
    clock += 1;
    summaries.peek("/work");
    await settle();
    expect(reader.calls).toHaveLength(2);
  });

  it("goes back to the normal time to live as soon as a read succeeds", async () => {
    const reader = manualReader();
    const summaries = cache(reader, 5_000);
    summaries.peek("/work");
    await settle();
    reader.answer(undefined);
    await settle();
    clock += 30_000;
    summaries.peek("/work");
    await settle();
    reader.answer(SOME);
    await settle();
    clock += 5_000;
    expect(summaries.peek("/work")).toEqual(SOME);
    await settle();
    expect(reader.calls).toHaveLength(3);
  });

  it("reads at once after a failure when the branch changes, whatever the delay", async () => {
    const reader = manualReader();
    const summaries = cache(reader, 5_000);
    summaries.peek("/work");
    await settle();
    reader.answer(undefined);
    await settle();
    summaries.invalidate();
    summaries.peek("/work");
    await settle();
    expect(reader.calls).toHaveLength(2);
  });

  it("honours the delay it is given", async () => {
    const reader = manualReader();
    const summaries = createGitSummaryCache({
      read: (cwd) => reader.read(cwd),
      ttlMs: 100,
      retryAfterFailureMs: 400,
      now: () => clock,
      onChange: () => undefined,
    });
    summaries.peek("/work");
    await settle();
    reader.fail("down");
    await settle();
    clock += 399;
    summaries.peek("/work");
    await settle();
    expect(reader.calls).toHaveLength(1);
    clock += 1;
    summaries.peek("/work");
    await settle();
    expect(reader.calls).toHaveLength(2);
  });

  it("keeps one entry for each folder", async () => {
    const reader = manualReader();
    const summaries = cache(reader);
    summaries.peek("/one");
    summaries.peek("/two");
    await settle();
    expect(reader.calls).toEqual(["/one", "/two"]);
    reader.answer(SOME);
    reader.answer(ZERO);
    await settle();
    expect(summaries.peek("/one")).toEqual(SOME);
    expect(summaries.peek("/two")).toEqual(ZERO);
  });

  it("invalidate makes the next ask read again at once, whatever the time to live", async () => {
    const reader = manualReader();
    const summaries = cache(reader, 60_000);
    summaries.peek("/work");
    await settle();
    reader.answer(SOME);
    await settle();
    summaries.invalidate();
    expect(summaries.peek("/work")).toEqual(SOME);
    await settle();
    expect(reader.calls).toHaveLength(2);
  });

  it("invalidate during a read reads once more when that read ends, since its answer may be old", async () => {
    const reader = manualReader();
    const summaries = cache(reader, 60_000);
    summaries.peek("/work");
    await settle();
    summaries.invalidate();
    reader.answer(SOME);
    await settle();
    expect(reader.calls).toHaveLength(2);
    reader.answer({ staged: 0, modified: 0, untracked: 9 });
    await settle();
    expect(summaries.peek("/work")).toEqual({ staged: 0, modified: 0, untracked: 9 });
  });

  // A repaint that throws must not become an unhandled rejection (that ends a Node process by default): the read runs
  // from a microtask nobody awaits.
  async function withUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const listener = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      await run();
      // The event is emitted after the microtasks drain, from the next turn of the loop.
      await new Promise((done) => setTimeout(done, 30));
    } finally {
      process.off("unhandledRejection", listener);
    }
    return seen;
  }

  it("is not brought down by an onChange that throws: no unhandled rejection, and the answer is kept", async () => {
    const reader = manualReader();
    const summaries = createGitSummaryCache({
      read: (cwd) => reader.read(cwd),
      ttlMs: 5_000,
      now: () => clock,
      onChange: () => {
        changes++;
        throw new Error("the repaint failed");
      },
    });
    const unhandled = await withUnhandledRejections(async () => {
      summaries.peek("/work");
      await settle();
      reader.answer(SOME);
      await settle();
    });
    expect(unhandled).toEqual([]);
    expect(changes).toBe(1);
    expect(summaries.peek("/work")).toEqual(SOME);
  });

  it("still reads again after an invalidation when onChange throws on the way", async () => {
    const reader = manualReader();
    const summaries = createGitSummaryCache({
      read: (cwd) => reader.read(cwd),
      ttlMs: 60_000,
      now: () => clock,
      onChange: () => {
        throw new Error("the repaint failed");
      },
    });
    const unhandled = await withUnhandledRejections(async () => {
      summaries.peek("/work");
      await settle();
      summaries.invalidate();
      reader.answer(SOME);
      await settle();
      reader.answer({ staged: 0, modified: 0, untracked: 9 });
      await settle();
    });
    expect(unhandled).toEqual([]);
    expect(reader.calls).toHaveLength(2);
    expect(summaries.peek("/work")).toEqual({ staged: 0, modified: 0, untracked: 9 });
  });

  it("says nothing after it is disposed", async () => {
    const reader = manualReader();
    const summaries = cache(reader);
    summaries.peek("/work");
    await settle();
    summaries.dispose();
    reader.answer(SOME);
    await settle();
    expect(changes).toBe(0);
    expect(() => summaries.peek("/work")).not.toThrow();
  });

  it("remembers a bounded number of folders", async () => {
    const reader = manualReader();
    const summaries = cache(reader);
    for (let index = 0; index < 40; index++) {
      summaries.peek(`/work-${index}`);
      await settle();
      reader.answer(SOME);
      await settle();
    }
    // The first folder was forgotten: asking again reads again, with nothing to show meanwhile.
    expect(summaries.peek("/work-0")).toBeUndefined();
    await settle();
    expect(reader.calls.filter((cwd) => cwd === "/work-0")).toHaveLength(2);
  });
});
