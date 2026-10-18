#!/usr/bin/env node
// Bumps HARIL's version everywhere at once (the user's permanent rule: every delivered change bumps the version and
// adds its CHANGELOG entry, newest on top). Usage: bump-version.mjs <patch|minor|major|x.y.z> [--date YYYY-MM-DD]
// It rewrites every version string (root, apps/haril, apps/bootstrap and apps/shell package.json, apps/haril's
// version.ts and the README line "Versión actual"), inserts a dated entry at the top of versions/v<major>/CHANGELOG.md
// with TODO(bump-version) markers for the author to fill, and updates "Estado actual" in versions/README.md. Line
// endings are kept per file. No network, no git: check-version.mjs verifies the result.
// Writes are all or nothing as far as the filesystem allows: every new content is computed first, written to a
// temporary file next to its target, and only then are the temporary files renamed over their targets. A failure
// before the renames removes the temporary files and leaves the tree untouched; a failure during the renames restores
// the renamed targets from backups taken just before, so the tree also ends as it was.

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  changelogPath,
  compareVersions,
  fileExists,
  PLACEHOLDER,
  parseVersion,
  readDocument,
  readVersionStrings,
  replaceVersionString,
  serializeDocument,
  setVersionInVersionsReadme,
  VERSION_FILES,
  VERSIONS_README,
  versionInVersionsReadme,
} from "./lib/version-files.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: bump-version.mjs <patch|minor|major|x.y.z> [--date YYYY-MM-DD]";
const KINDS = new Set(["patch", "minor", "major"]);

export function nextVersion(current, kind) {
  const parts = parseVersion(current);
  if (parts === null) throw new Error(`current version "${current}" is not x.y.z`);
  const [major, minor, patch] = parts;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "major") return `${major + 1}.0.0`;
  if (parseVersion(kind) === null) throw new Error("the bump is patch, minor, major or x.y.z");
  if (compareVersions(kind, current) <= 0) {
    throw new Error(`the new version must be greater than ${current}; got ${kind}`);
  }
  return kind;
}

function localToday() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function entryText(version, date) {
  return [
    `## ${version}`,
    "",
    `- **Fecha:** ${date}`,
    `- **Estado:** ${PLACEHOLDER}`,
    "",
    "### Añadido",
    "",
    `- ${PLACEHOLDER}`,
    "",
    "### Cambiado",
    "",
    `- ${PLACEHOLDER}`,
    "",
    "### Corregido",
    "",
    `- ${PLACEHOLDER}`,
    "",
    "### Verificación",
    "",
    `- ${PLACEHOLDER}`,
    "",
  ].join("\n");
}

function newChangelog(major, entry) {
  return [
    `# Changelog de HARIL, versión mayor ${major}`,
    "",
    "Las versiones van de la más reciente a la más antigua. Cada entrada indica la versión, la fecha, el estado y los cambios agrupados en Añadido, Cambiado y Corregido, y cómo se verificó.",
    "",
    "---",
    "",
    entry,
  ].join("\n");
}

function parseArgs(argv) {
  const positional = [];
  let date = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--date") {
      date = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("-")) {
      return null;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) return null;
  const [kind] = positional;
  if (!KINDS.has(kind) && parseVersion(kind) === null) return null;
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { kind, date };
}

const REAL_FS = {
  writeTemp: (path, content) => writeFileSync(path, content, { encoding: "utf8", flag: "wx" }),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
  backup: (from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL),
  exists: (path) => existsSync(path),
};

// Every [relative path, document] pair, through temporary files renamed at the end. Throws with the tree untouched when
// a temporary file cannot be written. Before the renames, every existing target is copied to a backup next to it; when
// a rename fails, the targets already renamed are restored from their backups (a target that did not exist is removed)
// and every temporary file and backup is deleted, so the tree ends exactly as before. Only a failed restore leaves its
// backup in place, and the error names it.
function writeAll(root, writes, fs) {
  const staged = [];
  try {
    for (const [path, document] of writes) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.bump-${process.pid}.tmp`;
      const backup = `${target}.bump-${process.pid}.bak`;
      staged.push({ temp, target, backup, existed: fs.exists(target), backedUp: false });
      fs.writeTemp(temp, serializeDocument(document));
    }
    for (const item of staged) {
      if (!item.existed) continue;
      fs.backup(item.target, item.backup);
      item.backedUp = true;
    }
  } catch (error) {
    for (const { temp, backup, backedUp } of staged) {
      fs.remove(temp);
      if (backedUp) fs.remove(backup);
    }
    throw error;
  }
  let renamed = 0;
  try {
    for (const { temp, target } of staged) {
      fs.rename(temp, target);
      renamed += 1;
    }
  } catch (error) {
    const kept = rollBack(staged, renamed, fs);
    const failure = new Error(
      kept.length === 0
        ? `renaming ${staged[renamed].target} failed after ${renamed} of ${staged.length} files (${error.message}); the ${renamed} renamed files were restored; nothing changed`
        : `renaming ${staged[renamed].target} failed after ${renamed} of ${staged.length} files (${error.message}), and restoring failed too; the old contents are kept in ${kept.join(", ")}`,
    );
    failure.partial = true;
    throw failure;
  }
  for (const { backup, backedUp } of staged) if (backedUp) fs.remove(backup);
}

// Puts back the first `renamed` targets and deletes every temporary file and backup. Returns the backups it could not
// restore, which stay on disk.
function rollBack(staged, renamed, fs) {
  const kept = [];
  staged.forEach((item, index) => {
    fs.remove(item.temp);
    if (index < renamed) {
      try {
        if (item.existed) fs.rename(item.backup, item.target);
        else fs.remove(item.target);
        return;
      } catch {
        kept.push(item.backup);
        return;
      }
    }
    if (item.backedUp) fs.remove(item.backup);
  });
  return kept;
}

export function main(
  argv = [],
  {
    root = REPO_ROOT,
    stdout = console.log,
    stderr = console.error,
    today = localToday(),
    fs = {},
  } = {},
) {
  const args = parseArgs(argv);
  if (args === null) {
    stderr(USAGE);
    return 2;
  }
  const date = args.date ?? today;

  const strings = readVersionStrings(root);
  const missing = strings.filter((entry) => entry.version === null).map((entry) => entry.path);
  if (missing.length > 0) {
    stderr(`bump-version: no version string found in ${missing.join(", ")}; nothing changed`);
    return 1;
  }
  const current = strings[0].version;
  for (const entry of strings) {
    if (entry.version !== current) {
      stderr(`bump-version: ${entry.path} had ${entry.version}; it is set to the new version too`);
    }
  }

  let target;
  try {
    target = nextVersion(current, args.kind);
  } catch (error) {
    stderr(`bump-version: ${error.message}`);
    return 1;
  }

  if (!fileExists(root, VERSIONS_README)) {
    stderr(`bump-version: ${VERSIONS_README} is missing; nothing changed`);
    return 1;
  }
  const versionsReadme = readDocument(root, VERSIONS_README);
  if (versionInVersionsReadme(versionsReadme.text) === null) {
    stderr(`bump-version: ${VERSIONS_README} has no "**Versión actual:**" line; nothing changed`);
    return 1;
  }

  const [major] = parseVersion(target);
  const logPath = changelogPath(major);
  const entry = entryText(target, date);
  let log;
  if (fileExists(root, logPath)) {
    log = readDocument(root, logPath);
    if (new RegExp(`^## ${target.replaceAll(".", "\\.")}\\s*$`, "m").test(log.text)) {
      stderr(`bump-version: ${logPath} already has an entry for ${target}; nothing changed`);
      return 1;
    }
    const first = log.text.search(/^## /m);
    log.text =
      first === -1
        ? `${log.text.replace(/\n*$/, "\n")}\n---\n\n${entry}`
        : `${log.text.slice(0, first)}${entry}\n---\n\n${log.text.slice(first)}`;
  } else {
    log = { text: newChangelog(major, entry), eol: versionsReadme.eol, bom: "" };
  }

  // Everything is computed before anything is written, so a refusal above leaves the tree untouched.
  const writes = VERSION_FILES.map(({ path, pattern }) => {
    const document = readDocument(root, path);
    return [path, { ...document, text: replaceVersionString(document.text, pattern, target) }];
  });
  writes.push([
    VERSIONS_README,
    { ...versionsReadme, text: setVersionInVersionsReadme(versionsReadme.text, target) },
  ]);
  writes.push([logPath, log]);
  try {
    writeAll(root, writes, { ...REAL_FS, ...fs });
  } catch (error) {
    stderr(`bump-version: ${error.message}${error.partial === true ? "" : "; nothing changed"}`);
    return 1;
  }

  stdout(`bump-version: ${current} -> ${target}`);
  for (const [path] of writes) stdout(`  updated ${path}`);
  stdout(
    `Fill in the ${target} entry of ${logPath} (every ${PLACEHOLDER}) and the status of ${VERSIONS_README}; check-version fails until the markers are gone.`,
  );
  return 0;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = main(process.argv.slice(2));
}
