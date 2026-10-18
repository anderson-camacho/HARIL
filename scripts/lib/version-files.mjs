// Where HARIL's version lives and how to read and rewrite it without touching anything else. Shared by
// scripts/bump-version.mjs and scripts/check-version.mjs (the user's permanent rule: every delivered change bumps the
// version and adds its CHANGELOG entry, newest on top). Files keep their own line endings.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER = "(\\d+\\.\\d+\\.\\d+)";

// Every version string, which must all be equal. The first capture group of each pattern is the version.
export const VERSION_FILES = [
  { path: "package.json", pattern: new RegExp(`^( {2}"version": ")${SEMVER}(")`, "m") },
  { path: "apps/haril/package.json", pattern: new RegExp(`^( {2}"version": ")${SEMVER}(")`, "m") },
  {
    path: "apps/bootstrap/package.json",
    pattern: new RegExp(`^( {2}"version": ")${SEMVER}(")`, "m"),
  },
  { path: "apps/shell/package.json", pattern: new RegExp(`^( {2}"version": ")${SEMVER}(")`, "m") },
  {
    path: "apps/haril/src/version.ts",
    pattern: new RegExp(`^(export const VERSION = ")${SEMVER}(";)$`, "m"),
  },
  { path: "README.md", pattern: new RegExp(`^(Versión actual: \\*\\*)${SEMVER}(\\*\\*)`, "m") },
];

export const VERSIONS_README = "versions/README.md";
const CURRENT_IN_VERSIONS = new RegExp(`^(- \\*\\*Versión actual:\\*\\* )${SEMVER}(\\.)`, "m");
const FOLDER_RANGE = (major) =>
  new RegExp(
    `^(- \\[v${major}\\]\\(v${major}/CHANGELOG\\.md\\): versiones ${SEMVER} a )${SEMVER}(\\.)`,
    "m",
  );

// The marker bump-version writes into a new entry; check-version fails while any is left in the top entry.
export const PLACEHOLDER = "TODO(bump-version)";

// A list item whose whole value is still the marker ("- TODO(bump-version)" or "- **Estado:** TODO(bump-version)").
// Text that only mentions the marker, as a changelog describing this script does, is not a placeholder.
const UNFILLED_LINE = /^\s*- (\*\*[^*\n]+:\*\* )?TODO\(bump-version\)\s*$/m;

export function hasUnfilledPlaceholder(text) {
  return UNFILLED_LINE.test(text);
}

export function changelogPath(major) {
  return `versions/v${major}/CHANGELOG.md`;
}

export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text));
  return match === null ? null : match.slice(1, 4).map(Number);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) throw new Error(`not a version: ${a === null ? left : right}`);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

// A text file as LF text plus what is needed to write it back the same way (line endings and a BOM).
export function readDocument(root, relative) {
  const raw = readFileSync(join(root, relative), "utf8");
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const body = bom === "" ? raw : raw.slice(1);
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  return { text: body.replace(/\r\n/g, "\n"), eol, bom };
}

export function fileExists(root, relative) {
  return existsSync(join(root, relative));
}

// The version each file carries, or null when the file or its version string is missing.
export function readVersionStrings(root) {
  return VERSION_FILES.map(({ path, pattern }) => {
    if (!fileExists(root, path)) return { path, version: null };
    const match = pattern.exec(readDocument(root, path).text);
    return { path, version: match === null ? null : match[2] };
  });
}

export function replaceVersionString(text, pattern, version) {
  return text.replace(pattern, (_all, before, _old, after) => `${before}${version}${after}`);
}

export function versionInVersionsReadme(text) {
  return CURRENT_IN_VERSIONS.exec(text)?.[2] ?? null;
}

export function setVersionInVersionsReadme(text, version) {
  const [major] = parseVersion(version);
  let next = replaceVersionString(text, CURRENT_IN_VERSIONS, version);
  const range = FOLDER_RANGE(major);
  if (range.test(next)) {
    next = next.replace(range, (_all, before, _low, _high, after) => `${before}${version}${after}`);
  } else {
    // A new major: its folder goes first, the newest major on top.
    const line = `- [v${major}](v${major}/CHANGELOG.md): versiones ${version} a ${version}.`;
    next = next.replace(/^- \[v\d+\]\(v\d+\/CHANGELOG\.md\):/m, (first) => `${line}\n${first}`);
  }
  return next;
}

// Every entry of a changelog, newest first: its version and its text up to the next separator or heading. A heading or
// a separator inside a fenced code block (``` or ~~~) is text, not structure, so a quoted "## x.y.z" is no entry.
export function changelogEntries(text) {
  const lines = text.split("\n");
  const entries = [];
  let fence = null;
  let current = null;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker !== null) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
    } else if (fence === null) {
      const heading = /^## (\S+)\s*$/.exec(line);
      if (heading !== null) {
        current = { version: heading[1], lines: [] };
        entries.push(current);
        continue;
      }
      if (/^---\s*$/.test(line)) {
        current = null;
        continue;
      }
    }
    current?.lines.push(line);
  }
  return entries.map((entry) => ({ version: entry.version, body: `\n${entry.lines.join("\n")}` }));
}

// The first entry of a changelog, or null when it has none.
export function topChangelogEntry(text) {
  return changelogEntries(text)[0] ?? null;
}

// Every entry heading of a changelog, newest first.
export function changelogVersions(text) {
  return changelogEntries(text).map((entry) => entry.version);
}

// A document as the text to store: its line endings and BOM as read (bump-version writes it to a temporary file first).
export function serializeDocument(document) {
  const body = document.eol === "\r\n" ? document.text.replace(/\n/g, "\r\n") : document.text;
  return document.bom + body;
}
