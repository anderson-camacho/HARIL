// Metadata-only snapshot of other tools' installs (M3-T2, AR-G7). It records existence, relative path, type,
// size and mtime of a bounded tree, plus a hash of the user PATH value. It never reads file contents, never
// follows symbolic links and never stores the PATH value itself.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ENTRIES = 2000;
const USER_PATH_LABEL = "HKCU Path";

// The roots named by the M3 criteria. %APPDATA%\npm exists on win32 only.
export function foreignRoots({
  homeDir = homedir(),
  env = process.env,
  platform = process.platform,
} = {}) {
  const roots = [
    { name: "~/.pi", path: join(homeDir, ".pi") },
    { name: "~/.engram", path: join(homeDir, ".engram") },
    // Live tools write their own state while they run, not as an install: Claude Code its backups/ (about once a
    // minute), its session transcripts under projects/ and the per-session state of every running session (file
    // history, session records and environments, shell snapshots, state, cache, prompt history); Codex its internal
    // databases (sqlite/), its log database, its global state and its model catalog cache. Ignoring them keeps the
    // guard about installs; config and binaries still count.
    {
      name: "~/.claude",
      path: join(homeDir, ".claude"),
      ignore: [
        "backups",
        "projects",
        "file-history",
        "sessions",
        "session-env",
        "shell-snapshots",
        "state",
        "cache",
        "history.jsonl",
      ],
    },
    {
      name: "~/.codex",
      path: join(homeDir, ".codex"),
      ignore: [
        "sqlite",
        /^logs_\d+\.sqlite(-wal|-shm)?$/,
        /^\.codex-global-state\.json(\.bak)?$/,
        "models_cache.json",
      ],
    },
    { name: "~/.npmrc", path: join(homeDir, ".npmrc") },
  ];
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(homeDir, "AppData", "Roaming");
    roots.push({ name: "%APPDATA%\\npm", path: join(appData, "npm") });
  }
  return roots;
}

// The user PATH: the HKCU value on win32 (read-only reg query), process PATH elsewhere. Null when unknown.
function readUserPathValue({
  platform = process.platform,
  env = process.env,
  run = spawnSync,
} = {}) {
  if (platform !== "win32") return env.PATH ?? null;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  const result = run(
    join(systemRoot, "System32", "reg.exe"),
    ["query", "HKCU\\Environment", "/v", "Path"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      env: { SystemRoot: systemRoot },
    },
  );
  if (result.error !== undefined || result.status !== 0) return null;
  const match = /^\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(result.stdout ?? "");
  return match === null ? null : match[1].replace(/\r$/, "");
}

export function snapshotForeignInstalls({
  roots = foreignRoots(),
  readUserPath = readUserPathValue,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const snapshot = { roots: new Map(), userPath: null };
  for (const root of roots) {
    snapshot.roots.set(
      root.name,
      snapshotRoot(root.path, { maxDepth, maxEntries, ignore: root.ignore ?? [] }),
    );
  }
  const value = readUserPath();
  snapshot.userPath = value === null ? null : sha256(value);
  return snapshot;
}

// Depth 1 is a child of the root. Entries at depth maxDepth are recorded but not descended into.
function snapshotRoot(path, { maxDepth, maxEntries, ignore = [] }) {
  const result = { exists: false, entries: new Map(), truncated: false };
  const rootMeta = metaOf(path);
  if (rootMeta === null) return result;
  result.exists = true;
  if (!rootMeta.isDirectory) {
    result.entries.set(".", rootMeta.meta);
    return result;
  }

  const visit = (dir, prefix, depth) => {
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (result.entries.size >= maxEntries) {
        result.truncated = true;
        return;
      }
      const relative = prefix === "" ? child.name : `${prefix}/${child.name}`;
      if (
        ignore.some((rule) => (typeof rule === "string" ? rule === relative : rule.test(relative)))
      )
        continue;
      const full = join(dir, child.name);
      const info = metaOf(full);
      if (info === null) continue;
      result.entries.set(relative, info.meta);
      if (info.isDirectory && depth < maxDepth) visit(full, relative, depth + 1);
    }
  };
  visit(path, "", 1);
  return result;
}

function metaOf(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  const type = stat.isSymbolicLink()
    ? "symlink"
    : stat.isDirectory()
      ? "dir"
      : stat.isFile()
        ? "file"
        : "other";
  return {
    isDirectory: stat.isDirectory(),
    meta: { type, size: stat.size, mtimeMs: stat.mtimeMs },
  };
}

// Returns labels of what was added, removed or changed between two snapshots, for printing.
export function diffForeignSnapshots(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  const names = new Set([...before.roots.keys(), ...after.roots.keys()]);

  for (const name of names) {
    const beforeEntries = before.roots.get(name)?.entries ?? new Map();
    const afterEntries = after.roots.get(name)?.entries ?? new Map();
    for (const [relative, meta] of afterEntries) {
      const prior = beforeEntries.get(relative);
      if (prior === undefined) added.push(labelOf(name, relative));
      else if (!sameMeta(prior, meta)) changed.push(labelOf(name, relative));
    }
    for (const relative of beforeEntries.keys()) {
      if (!afterEntries.has(relative)) removed.push(labelOf(name, relative));
    }
  }
  if (before.userPath !== after.userPath) changed.push(USER_PATH_LABEL);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export function isEmptyDiff(diff) {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

function labelOf(name, relative) {
  return relative === "." ? name : `${name}/${relative}`;
}

function sameMeta(a, b) {
  return a.type === b.type && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
