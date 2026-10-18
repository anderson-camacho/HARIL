// Where HARIL's version lives and how to read and rewrite it without touching anything else. Shared by
// scripts/bump-version.mjs and scripts/check-version.mjs (the user's permanent rule: every delivered change bumps the
// version and adds its CHANGELOG entry, newest on top). Files keep their own line endings.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

export function writeDocument(root, relative, document) {
  mkdirSync(dirname(join(root, relative)), { recursive: true });
  writeFileSync(join(root, relative), serializeDocument(document), "utf8");
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

// The first entry of a changelog: its version and its text up to the next separator or heading.
export function topChangelogEntry(text) {
  const heading = /^## (\S+)\s*$/m.exec(text);
  if (heading === null) return null;
  const start = heading.index + heading[0].length;
  const rest = text.slice(start);
  const end = rest.search(/^(---\s*$|## )/m);
  return { version: heading[1], body: end === -1 ? rest : rest.slice(0, end) };
}

// Every entry heading of a changelog, newest first.
export function changelogVersions(text) {
  return [...text.matchAll(/^## (\S+)\s*$/gm)].map((match) => match[1]);
}

// A document as the text writeDocument would store, so a caller can write it elsewhere first (bump-version's temporary
// files).
export function serializeDocument(document) {
  const body = document.eol === "\r\n" ? document.text.replace(/\n/g, "\r\n") : document.text;
  return document.bom + body;
}
