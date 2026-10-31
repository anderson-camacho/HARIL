import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGitSummaryCache,
  type GitSummary,
  parseGitStatus,
  readGitSummary,
} from "../src/git-summary.js";

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

    const throwing = createGitSummaryCache({
      read: () => {
        throw new Error("synchronous failure");
      },
      ttlMs: 10,
      now: () => clock,
      onChange: () => {
        changes++;
      },
    });
    expect(() => throwing.peek("/work")).not.toThrow();
    await settle();
    expect(throwing.peek("/work")).toBeUndefined();
  });

  it("does not hammer a failing git: it tries again only after the time to live", async () => {
    const reader = manualReader();
    const summaries = cache(reader, 5_000);
    summaries.peek("/work");
    await settle();
    reader.answer(undefined);
    await settle();
    for (let index = 0; index < 5; index++) summaries.peek("/work");
    await settle();
    expect(reader.calls).toHaveLength(1);
    clock += 5_000;
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
