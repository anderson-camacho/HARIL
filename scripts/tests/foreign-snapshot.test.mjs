import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  diffForeignSnapshots,
  foreignRoots,
  snapshotForeignInstalls,
} from "../lib/foreign-snapshot.mjs";

// Metadata-only snapshot of other tools' installs (M3-T2, AR-G7). Every test uses temporary roots and an
// injected PATH reader, so nothing here reads the real user profile or the registry.

const FIXED_TIME = new Date("2026-10-16T00:00:00Z");

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "haril-foreign-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeAt(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, FIXED_TIME, FIXED_TIME);
}

const noPath = () => "C:\\Windows;C:\\Tools";

test("snapshot records relative path, type, size and mtime, honouring the depth cap", () => {
  const { dir, cleanup } = sandbox();
  try {
    const root = join(dir, "pi");
    writeAt(join(root, "settings.json"), "{}");
    writeAt(join(root, "a", "b", "c", "deep.txt"), "x");
    writeAt(join(root, "a", "b", "c", "d", "too-deep.txt"), "x");

    const snapshot = snapshotForeignInstalls({
      roots: [{ name: "~/.pi", path: root }],
      readUserPath: noPath,
      maxDepth: 3,
    });
    const entries = snapshot.roots.get("~/.pi").entries;

    assert.equal(snapshot.roots.get("~/.pi").exists, true);
    assert.deepEqual(
      { type: entries.get("settings.json").type, size: entries.get("settings.json").size },
      { type: "file", size: 2 },
    );
    assert.equal(entries.get("settings.json").mtimeMs, FIXED_TIME.getTime());
    // Keys use forward slashes on every platform. Depth 1 is a child of the root, so depth 3 is "a/b/c".
    assert.equal(entries.get("a/b/c")?.type, "dir");
    assert.equal(
      entries.has("a/b/c/deep.txt"),
      false,
      "entries below the depth cap must not be recorded",
    );
    assert.equal(
      [...entries.keys()].some((key) => key.endsWith("too-deep.txt")),
      false,
    );
  } finally {
    cleanup();
  }
});

test("snapshot marks a missing root as absent and caps the number of entries", () => {
  const { dir, cleanup } = sandbox();
  try {
    const big = join(dir, "big");
    for (let index = 0; index < 5; index++) writeAt(join(big, `f${index}.txt`), "x");

    const snapshot = snapshotForeignInstalls({
      roots: [
        { name: "~/.absent", path: join(dir, "absent") },
        { name: "~/.big", path: big },
      ],
      readUserPath: noPath,
      maxEntries: 3,
    });

    assert.equal(snapshot.roots.get("~/.absent").exists, false);
    assert.equal(snapshot.roots.get("~/.absent").entries.size, 0);
    assert.equal(snapshot.roots.get("~/.big").entries.size, 3);
    assert.equal(snapshot.roots.get("~/.big").truncated, true);
  } finally {
    cleanup();
  }
});

test("a file with the same size and mtime but different content is not reported", () => {
  const { dir, cleanup } = sandbox();
  try {
    const root = join(dir, "claude");
    writeAt(join(root, "token.json"), "aaaa");
    const roots = [{ name: "~/.claude", path: root }];
    const before = snapshotForeignInstalls({ roots, readUserPath: noPath });

    writeAt(join(root, "token.json"), "bbbb");
    const after = snapshotForeignInstalls({ roots, readUserPath: noPath });

    assert.deepEqual(diffForeignSnapshots(before, after), { added: [], removed: [], changed: [] });
  } finally {
    cleanup();
  }
});

test("diff reports added, removed and changed entries, including a root that appears", () => {
  const { dir, cleanup } = sandbox();
  try {
    const root = join(dir, "codex");
    writeAt(join(root, "keep.txt"), "1");
    writeAt(join(root, "gone.txt"), "1");
    writeAt(join(root, "grow.txt"), "1");
    const roots = [
      { name: "~/.codex", path: root },
      { name: "~/.npmrc", path: join(dir, ".npmrc") },
    ];
    const before = snapshotForeignInstalls({ roots, readUserPath: noPath });

    rmSync(join(root, "gone.txt"));
    writeAt(join(root, "grow.txt"), "1234567");
    writeAt(join(root, "new.txt"), "1");
    writeAt(join(dir, ".npmrc"), "registry=x");
    const after = snapshotForeignInstalls({ roots, readUserPath: noPath });

    const diff = diffForeignSnapshots(before, after);
    assert.deepEqual(diff.removed, ["~/.codex/gone.txt"]);
    assert.deepEqual(diff.changed, ["~/.codex/grow.txt"]);
    assert.deepEqual(diff.added.sort(), ["~/.codex/new.txt", "~/.npmrc"]);
  } finally {
    cleanup();
  }
});

test("a change to the user PATH is reported without printing its value", () => {
  const roots = [];
  let value = "C:\\one";
  const before = snapshotForeignInstalls({ roots, readUserPath: () => value });
  value = "C:\\one;C:\\haril\\bin";
  const after = snapshotForeignInstalls({ roots, readUserPath: () => value });

  const diff = diffForeignSnapshots(before, after);
  assert.deepEqual(diff.changed, ["HKCU Path"]);
  assert.equal(JSON.stringify(after).includes("haril"), false, "the PATH value must not be stored");
});

test("foreignRoots lists the six roots of the criteria on win32 and omits the AppData one elsewhere", () => {
  const win = foreignRoots({
    homeDir: "C:\\Users\\tester",
    env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
    platform: "win32",
  });
  assert.deepEqual(
    win.map((root) => root.name),
    ["~/.pi", "~/.engram", "~/.claude", "~/.codex", "~/.npmrc", "%APPDATA%\\npm"],
  );

  const posix = foreignRoots({ homeDir: "/home/tester", env: {}, platform: "linux" });
  assert.equal(
    posix.some((root) => root.name === "%APPDATA%\\npm"),
    false,
  );
});

test("an ignored subtree is not recorded, so writes by the host itself do not count", () => {
  const { dir, cleanup } = sandbox();
  try {
    const root = join(dir, "claude");
    writeAt(join(root, "settings.json"), "{}");
    writeAt(join(root, "backups", "one.json"), "1");
    const withIgnore = [{ name: "~/.claude", path: root, ignore: ["backups"] }];
    const before = snapshotForeignInstalls({ roots: withIgnore, readUserPath: noPath });

    writeAt(join(root, "backups", "two.json"), "2");
    const after = snapshotForeignInstalls({ roots: withIgnore, readUserPath: noPath });

    const entries = after.roots.get("~/.claude").entries;
    assert.equal(
      [...entries.keys()].some((key) => key.startsWith("backups")),
      false,
    );
    assert.deepEqual(diffForeignSnapshots(before, after), { added: [], removed: [], changed: [] });
  } finally {
    cleanup();
  }
});

test("live tool state (transcripts, log databases, global state) is ignored, while config changes still count", () => {
  const { dir, cleanup } = sandbox();
  try {
    const claude = join(dir, "claude");
    const codex = join(dir, "codex");
    writeAt(join(claude, "settings.json"), "{}");
    writeAt(join(claude, "projects", "repo", "session.jsonl"), "1");
    writeAt(join(codex, "config.toml"), "a");
    writeAt(join(codex, "logs_2.sqlite-wal"), "1");
    writeAt(join(codex, ".codex-global-state.json"), "1");
    writeAt(join(codex, "sqlite", "codex-dev.db"), "1");
    writeAt(join(codex, "models_cache.json"), "{}");
    const roots = foreignRoots({ homeDir: dir, env: {}, platform: "linux" })
      .filter((root) => root.name === "~/.claude" || root.name === "~/.codex")
      .map((root) => ({ ...root, path: root.name === "~/.claude" ? claude : codex }));
    const before = snapshotForeignInstalls({ roots, readUserPath: noPath });

    writeAt(join(claude, "projects", "repo", "session.jsonl"), "12");
    writeAt(join(claude, "file-history", "session-1", "edit.json"), "1");
    writeAt(join(claude, "sessions", "one.json"), "1");
    writeAt(join(claude, "session-env", "one", "env"), "1");
    writeAt(join(claude, "shell-snapshots", "snapshot.sh"), "1");
    writeAt(join(claude, "state", "one.json"), "1");
    writeAt(join(claude, "cache", "one.json"), "1");
    writeAt(join(claude, "history.jsonl"), "1");
    writeAt(join(codex, "logs_2.sqlite-wal"), "12");
    writeAt(join(codex, "logs_2.sqlite-shm"), "1");
    writeAt(join(codex, ".codex-global-state.json.bak"), "1");
    writeAt(join(codex, "sqlite", "codex-dev.db-wal"), "1");
    writeAt(join(codex, "models_cache.json"), '{"refreshed":true}');
    assert.deepEqual(
      diffForeignSnapshots(before, snapshotForeignInstalls({ roots, readUserPath: noPath })),
      { added: [], removed: [], changed: [] },
    );

    writeAt(join(codex, "config.toml"), "changed");
    const diff = diffForeignSnapshots(
      before,
      snapshotForeignInstalls({ roots, readUserPath: noPath }),
    );
    assert.deepEqual(diff.changed, ["~/.codex/config.toml"]);
  } finally {
    cleanup();
  }
});
