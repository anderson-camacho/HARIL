#!/usr/bin/env node
// Enforces the version rule (the user's permanent rule: every delivered change bumps the version and adds its
// CHANGELOG entry, newest on top; P21: one bump per delivered change, so the comparison is against the base of the
// change, not the previous commit). Usage: check-version.mjs   (exits 1 on any problem)
//
// Always: every version string is equal, the top entry of versions/v<major>/CHANGELOG.md is the current version with
// no TODO(bump-version) left, and versions/README.md names the current version.
// When tracked public files changed against the base: the version is greater than the base's, and the base's top
// changelog entry is still there below the new one (relabeling the old entry as the new version is not a bump). Public
// means tracked and outside docs/ and odd/, which stay local; renames are not detected, so a file moved into docs/
// counts as a public file removed. The base is HARIL_VERSION_BASE when set, else the merge-base of HEAD with
// origin/main. With no base (a fresh clone without a remote, or no git), only the consistency is checked and the output
// says the bump comparison was skipped; in CI (the CI environment variable is set) a missing base is a failure instead.
// Changes include uncommitted edits to tracked files.
//
// HARIL_VERSION_CHECK selects the mode: "full" (the default) as above, or "consistency", which checks only that the
// version strings, the CHANGELOG top entry and versions/README.md agree. CI uses "consistency" on push events, so a
// work-in-progress push passes before its bump, and "full" on pull requests, which are the delivery (P21).

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  changelogEntries,
  changelogPath,
  compareVersions,
  fileExists,
  hasUnfilledPlaceholder,
  PLACEHOLDER,
  parseVersion,
  readDocument,
  readVersionStrings,
  topChangelogEntry,
  VERSIONS_README,
  versionInVersionsReadme,
} from "./lib/version-files.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_ONLY = ["docs/", "odd/"];

// Runs git in the repository root and never lets it climb to a repository above it.
function gitIn(root) {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(resolve(root)) };
  return (...args) => {
    try {
      const stdout = execFileSync("git", args, {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, stdout };
    } catch {
      return { ok: false, stdout: "" };
    }
  };
}

function resolveBase(git, env) {
  const configured = env.HARIL_VERSION_BASE;
  if (configured !== undefined && configured !== "") {
    const sha = git("rev-parse", "--verify", "--quiet", `${configured}^{commit}`);
    if (!sha.ok) {
      return {
        kind: "error",
        message: `HARIL_VERSION_BASE "${configured}" does not name a commit`,
      };
    }
    const value = sha.stdout.trim();
    return { kind: "base", sha: value, label: `HARIL_VERSION_BASE (${value.slice(0, 7)})` };
  }
  if (!git("rev-parse", "--is-inside-work-tree").ok) {
    return { kind: "none", why: "this tree is not a git repository" };
  }
  const mergeBase = git("merge-base", "HEAD", "origin/main");
  if (!mergeBase.ok) return { kind: "none", why: "there is no origin/main to compare with" };
  const value = mergeBase.stdout.trim();
  return { kind: "base", sha: value, label: `merge-base with origin/main (${value.slice(0, 7)})` };
}

function consistencyProblems(root) {
  const problems = [];
  const strings = readVersionStrings(root);
  for (const entry of strings) {
    if (entry.version === null) problems.push(`${entry.path}: no version string found`);
  }
  const current = strings[0].version;
  if (current === null) return { current, problems };
  for (const entry of strings.slice(1)) {
    if (entry.version !== null && entry.version !== current) {
      problems.push(`${entry.path} has ${entry.version}, expected ${current} (package.json)`);
    }
  }

  const [major] = parseVersion(current);
  const logPath = changelogPath(major);
  if (!fileExists(root, logPath)) {
    problems.push(`${logPath} is missing`);
  } else {
    const top = topChangelogEntry(readDocument(root, logPath).text);
    if (top === null) problems.push(`${logPath} has no entry`);
    else if (top.version !== current) {
      problems.push(`${logPath}: top entry is ${top.version}, not ${current}`);
    } else if (hasUnfilledPlaceholder(top.body)) {
      problems.push(`${logPath}: the ${current} entry still has ${PLACEHOLDER}; fill it in`);
    }
  }

  if (!fileExists(root, VERSIONS_README)) {
    problems.push(`${VERSIONS_README} is missing`);
  } else {
    const named = versionInVersionsReadme(readDocument(root, VERSIONS_README).text);
    if (named === null) problems.push(`${VERSIONS_README} does not name the current version`);
    else if (named !== current) problems.push(`${VERSIONS_README} names ${named}, not ${current}`);
  }
  return { current, problems };
}

function baseVersion(git, sha) {
  const manifest = git("show", `${sha}:package.json`);
  if (!manifest.ok) return "0.0.0";
  try {
    const version = JSON.parse(manifest.stdout).version;
    return parseVersion(version) === null ? "0.0.0" : version;
  } catch {
    return "0.0.0";
  }
}

// The base's top changelog entry, when the base has one: a bump adds an entry above it and never relabels it.
function baseTopEntry(git, sha, current) {
  const [currentMajor] = parseVersion(current);
  for (let major = currentMajor; major >= 0; major--) {
    const log = git("show", `${sha}:${changelogPath(major)}`);
    if (!log.ok) continue;
    const top = topChangelogEntry(log.stdout.replace(/\r\n/g, "\n"));
    if (top !== null && parseVersion(top.version) !== null) {
      return { version: top.version, body: top.body, path: changelogPath(major) };
    }
  }
  return null;
}

function keptEntryProblem(root, git, base, current) {
  const top = baseTopEntry(git, base.sha, current);
  if (top === null || top.version === current) {
    return top === null
      ? null
      : `the ${top.version} entry of the base (top of ${top.path} at ${base.label}) is gone: it was relabeled as ${current}; add a new entry above it instead`;
  }
  // Kept means the base's real entry: below the new top entry and with the base's text, so a heading inside a code
  // fence (never an entry) or a dummy heading with other text cannot stand in for it.
  const entries = fileExists(root, top.path)
    ? changelogEntries(readDocument(root, top.path).text)
    : [];
  const kept = entries
    .slice(1)
    .some((entry) => entry.version === top.version && sameText(entry.body, top.body));
  return kept
    ? null
    : `the ${top.version} entry of the base (top of ${top.path} at ${base.label}) is gone; keep it below the new ${current} entry`;
}

// Two entry texts are the same up to line endings and trailing spaces.
function sameText(left, right) {
  const clean = (text) =>
    text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
  return clean(left) === clean(right);
}

function isCi(env) {
  const value = env.CI;
  return value !== undefined && value !== "" && value !== "false" && value !== "0";
}

export function main(
  argv = [],
  { root = REPO_ROOT, env = process.env, stdout = console.log, stderr = console.error } = {},
) {
  if (argv.length > 0) {
    stderr(
      "usage: check-version.mjs   (base: HARIL_VERSION_BASE, else merge-base with origin/main; mode: HARIL_VERSION_CHECK=full|consistency)",
    );
    return 2;
  }
  const { current, problems } = consistencyProblems(root);
  const mode =
    env.HARIL_VERSION_CHECK === undefined || env.HARIL_VERSION_CHECK === ""
      ? "full"
      : env.HARIL_VERSION_CHECK;
  if (mode !== "full" && mode !== "consistency") {
    problems.push(`HARIL_VERSION_CHECK must be "full" or "consistency", not "${mode}"`);
  }
  const git = gitIn(root);
  let summary;

  if (mode !== "full") {
    summary = "consistency only (HARIL_VERSION_CHECK=consistency)";
    return report(problems, current, summary, stdout, stderr);
  }
  const base = resolveBase(git, env);
  if (base.kind === "error") {
    problems.push(base.message);
  } else if (base.kind === "none") {
    if (isCi(env)) {
      problems.push(
        `no base to compare with in CI (${base.why}); check out the full history with origin/main (fetch-depth: 0) or set HARIL_VERSION_BASE`,
      );
    } else {
      summary = `bump comparison skipped: ${base.why}`;
    }
  } else {
    // --no-renames: a public file moved into docs/ or odd/ shows as removed, so it still needs a bump.
    const diff = git("diff", "--name-only", "--no-renames", "-z", base.sha, "--");
    const changed = diff.stdout.split("\0").filter((path) => path !== "");
    const publicFiles = changed.filter((path) => !LOCAL_ONLY.some((dir) => path.startsWith(dir)));
    if (!diff.ok) {
      problems.push(`git diff against ${base.label} failed`);
    } else if (publicFiles.length === 0) {
      summary = `no public change since ${base.label}`;
    } else if (current !== null) {
      const previous = baseVersion(git, base.sha);
      if (compareVersions(current, previous) <= 0) {
        const sample = publicFiles.slice(0, 5).join(", ");
        problems.push(
          `${publicFiles.length} public file(s) changed since ${base.label} without a version bump (still ${current}): ${sample}. Run "node scripts/bump-version.mjs minor" (or patch) and fill in the CHANGELOG entry.`,
        );
      } else {
        const lost = keptEntryProblem(root, git, base, current);
        if (lost !== null) problems.push(lost);
        summary = `${previous} -> ${current} since ${base.label}`;
      }
    }
  }

  return report(problems, current, summary, stdout, stderr);
}

function report(problems, current, summary, stdout, stderr) {
  if (problems.length > 0) {
    for (const problem of problems) stderr(`check-version: ${problem}`);
    stderr(`check-version: ${problems.length} problem(s)`);
    return 1;
  }
  stdout(`check-version: ok, version ${current}; ${summary}`);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = main(process.argv.slice(2));
}
