import assert from "node:assert/strict";
import { test } from "node:test";
import { main as bump } from "../bump-version.mjs";
import { main } from "../check-version.mjs";
import { changelogVersions, PLACEHOLDER, topChangelogEntry } from "../lib/version-files.mjs";
import {
  capture,
  changelog,
  gitSandbox,
  readAt,
  sandbox,
  versionsReadme,
  writeAt,
  writeVersionTree,
} from "./version-fixture.mjs";

// scripts/check-version.mjs: public changes since the base need a bump, equal version strings, a filled top
// changelog entry and versions/README.md naming the version. Every repository here is temporary.

function check(root, env = {}) {
  const io = capture();
  const code = main([], { root, env, ...io });
  return { code, text: io.text(), out: io.out.join("\n"), err: io.err.join("\n") };
}

// Bump with the real script and fill the entry the way an author would.
function bumpAndFill(root, kind = "minor") {
  assert.equal(bump([kind], { root, today: "2026-10-18", ...capture() }), 0);
  const log = readAt(root, "versions/v0/CHANGELOG.md").replaceAll(PLACEHOLDER, "Hecho.");
  writeAt(root, "versions/v0/CHANGELOG.md", log);
}

test("passes when nothing public changed since the base", () => {
  const repo = gitSandbox("0.10.0");
  try {
    const result = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(result.code, 0, result.text);
    assert.match(result.out, /no public change since/);
  } finally {
    repo.cleanup();
  }
});

test("fails when a public file changed without a bump", () => {
  const repo = gitSandbox("0.10.0");
  try {
    writeAt(repo.root, "src/code.ts", "export const value = 2;\n");
    repo.commit("change code");
    const result = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(result.code, 1);
    assert.match(result.err, /without a version bump/);
    assert.match(result.err, /bump-version\.mjs/);
  } finally {
    repo.cleanup();
  }
});

test("counts uncommitted changes to tracked files", () => {
  const repo = gitSandbox("0.10.0");
  try {
    writeAt(repo.root, "src/code.ts", "export const value = 3;\n");
    const result = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(result.code, 1, result.text);
  } finally {
    repo.cleanup();
  }
});

test("passes when the change comes with a bump, a filled entry and versions/README.md", () => {
  const repo = gitSandbox("0.10.0");
  try {
    writeAt(repo.root, "src/code.ts", "export const value = 2;\n");
    bumpAndFill(repo.root);
    repo.commit("feature and release");
    const result = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(result.code, 0, result.text);
    assert.match(result.out, /0\.10\.0 -> 0\.11\.0/);
  } finally {
    repo.cleanup();
  }
});

test("ignores changes under docs/ and odd/, which are not public", () => {
  const repo = gitSandbox("0.10.0");
  try {
    writeAt(repo.root, "docs/notes.md", "# Notes\n");
    writeAt(repo.root, "odd/tasks/x.md", "# Tasks\n");
    repo.commit("local docs");
    const result = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(result.code, 0, result.text);
  } finally {
    repo.cleanup();
  }
});

test("fails when the version strings differ", () => {
  const repo = gitSandbox("0.10.0");
  try {
    bumpAndFill(repo.root);
    writeAt(
      repo.root,
      "apps/shell/package.json",
      readAt(repo.root, "apps/shell/package.json").replace("0.11.0", "0.10.0"),
    );
    repo.commit("half bump");
    const result = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(result.code, 1);
    assert.match(result.err, /apps\/shell\/package\.json has 0\.10\.0/);
  } finally {
    repo.cleanup();
  }
});

test("fails while the top changelog entry still has the placeholder", () => {
  const repo = gitSandbox("0.10.0");
  try {
    assert.equal(bump(["minor"], { root: repo.root, today: "2026-10-18", ...capture() }), 0);
    repo.commit("unfilled release");
    const result = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(result.code, 1);
    assert.match(result.err, /TODO\(bump-version\)/);
  } finally {
    repo.cleanup();
  }
});

test("accepts a filled entry that only mentions the marker in its text", () => {
  const repo = gitSandbox("0.10.0");
  try {
    bumpAndFill(repo.root);
    const log = readAt(repo.root, "versions/v0/CHANGELOG.md").replace(
      "### Añadido\n\n- Hecho.",
      `### Añadido\n\n- bump-version.mjs writes \`${PLACEHOLDER}\` markers for the author to fill.`,
    );
    writeAt(repo.root, "versions/v0/CHANGELOG.md", log);
    repo.commit("release that documents the marker");
    const result = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(result.code, 0, result.text);
  } finally {
    repo.cleanup();
  }
});

test("fails when a single marker line is left among filled ones", () => {
  const repo = gitSandbox("0.10.0");
  try {
    bumpAndFill(repo.root);
    const log = readAt(repo.root, "versions/v0/CHANGELOG.md").replace(
      "### Corregido\n\n- Hecho.",
      `### Corregido\n\n- ${PLACEHOLDER}`,
    );
    writeAt(repo.root, "versions/v0/CHANGELOG.md", log);
    repo.commit("release with one marker left");
    const result = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(result.code, 1, result.text);
  } finally {
    repo.cleanup();
  }
});

test("fails when the top changelog entry is not the current version", () => {
  const { root, cleanup } = sandbox();
  try {
    writeVersionTree(root, "0.11.0");
    writeAt(root, "versions/v0/CHANGELOG.md", changelog([{ version: "0.10.0" }]));
    const result = check(root);
    assert.equal(result.code, 1);
    assert.match(result.err, /top entry is 0\.10\.0, not 0\.11\.0/);
  } finally {
    cleanup();
  }
});

test("fails when versions/README.md does not name the current version", () => {
  const { root, cleanup } = sandbox();
  try {
    writeVersionTree(root, "0.11.0");
    writeAt(root, "versions/README.md", versionsReadme("0.10.0"));
    const result = check(root);
    assert.equal(result.code, 1);
    assert.match(result.err, /versions\/README\.md names 0\.10\.0/);
  } finally {
    cleanup();
  }
});

test("uses the merge-base with origin/main when no base is given", () => {
  const repo = gitSandbox("0.10.0");
  try {
    repo.git("update-ref", "refs/remotes/origin/main", repo.base);
    repo.git("switch", "-q", "-c", "feature");
    writeAt(repo.root, "src/code.ts", "export const value = 2;\n");
    repo.commit("change code");
    const failing = check(repo.root);
    assert.equal(failing.code, 1, failing.text);
    assert.match(
      failing.err,
      new RegExp(`merge-base with origin/main \\(${repo.base.slice(0, 7)}`),
    );
    bumpAndFill(repo.root);
    repo.commit("release");
    const passing = check(repo.root);
    assert.equal(passing.code, 0, passing.text);
  } finally {
    repo.cleanup();
  }
});

test("without any base it checks consistency only and says the comparison was skipped", () => {
  const repo = gitSandbox("0.10.0");
  try {
    writeAt(repo.root, "src/code.ts", "export const value = 2;\n");
    repo.commit("change code");
    const result = check(repo.root);
    assert.equal(result.code, 0, result.text);
    assert.match(result.out, /bump comparison skipped/);
    writeAt(repo.root, "apps/haril/src/version.ts", 'export const VERSION = "9.9.9";\n');
    assert.equal(check(repo.root).code, 1);
  } finally {
    repo.cleanup();
  }
});

test("outside a git repository it checks consistency only", () => {
  const { root, cleanup } = sandbox();
  try {
    writeVersionTree(root, "0.10.0");
    const result = check(root);
    assert.equal(result.code, 0, result.text);
    assert.match(result.out, /bump comparison skipped/);
  } finally {
    cleanup();
  }
});

test("fails on a HARIL_VERSION_BASE that does not resolve", () => {
  const repo = gitSandbox("0.10.0");
  try {
    const result = check(repo.root, { HARIL_VERSION_BASE: "no-such-ref" });
    assert.equal(result.code, 1);
    assert.match(result.err, /HARIL_VERSION_BASE "no-such-ref" does not name a commit/);
  } finally {
    repo.cleanup();
  }
});

test("rejects arguments it does not know", () => {
  const io = capture();
  assert.equal(main(["--fix"], { root: ".", env: {}, ...io }), 2);
  assert.match(io.err.join("\n"), /usage: check-version\.mjs/);
});

test("counts a public file moved into docs/ as a public change (no rename detection)", () => {
  const repo = gitSandbox("0.10.0");
  try {
    writeAt(repo.root, "docs/README.md", "# Docs\n");
    repo.git("mv", "src/code.ts", "docs/code.ts");
    repo.commit("hide code in docs");
    const result = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(result.code, 1, result.text);
    assert.match(result.err, /without a version bump/);
    assert.match(result.err, /src\/code\.ts/);
  } finally {
    repo.cleanup();
  }
});

test("fails when the base's top changelog entry was relabeled instead of kept below the new one", () => {
  const repo = gitSandbox("0.10.0");
  try {
    writeAt(repo.root, "src/code.ts", "export const value = 2;\n");
    // Every version string at 0.11.0, and the changelog's 0.10.0 entry renamed to 0.11.0 (no new entry above it).
    writeVersionTree(repo.root, "0.11.0");
    writeAt(repo.root, "src/code.ts", "export const value = 2;\n");
    repo.commit("relabeled release");
    const result = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(result.code, 1, result.text);
    assert.match(result.err, /0\.10\.0 entry of the base .* is gone/);
  } finally {
    repo.cleanup();
  }
});

test("in CI, a missing base is a failure instead of a skipped comparison", () => {
  const repo = gitSandbox("0.10.0");
  try {
    writeAt(repo.root, "src/code.ts", "export const value = 2;\n");
    repo.commit("change code");
    const result = check(repo.root, { CI: "true" });
    assert.equal(result.code, 1, result.text);
    assert.match(result.err, /no base to compare with in CI/);
    assert.equal(check(repo.root, {}).code, 0);
  } finally {
    repo.cleanup();
  }
});

test("HARIL_VERSION_CHECK=consistency checks only the consistency, for pushes of work in progress", () => {
  const repo = gitSandbox("0.10.0");
  try {
    writeAt(repo.root, "src/code.ts", "export const value = 2;\n");
    repo.commit("work in progress");
    const env = { HARIL_VERSION_CHECK: "consistency", HARIL_VERSION_BASE: repo.base };
    const result = check(repo.root, env);
    assert.equal(result.code, 0, result.text);
    assert.match(result.out, /consistency only \(HARIL_VERSION_CHECK=consistency\)/);
    assert.equal(check(repo.root, { HARIL_VERSION_CHECK: "consistency", CI: "true" }).code, 0);
    assert.equal(
      check(repo.root, { HARIL_VERSION_CHECK: "full", HARIL_VERSION_BASE: repo.base }).code,
      1,
    );
    writeAt(
      repo.root,
      "apps/shell/package.json",
      readAt(repo.root, "apps/shell/package.json").replace("0.10.0", "0.9.0"),
    );
    assert.equal(check(repo.root, env).code, 1);
  } finally {
    repo.cleanup();
  }
});

test("rejects an unknown HARIL_VERSION_CHECK mode", () => {
  const repo = gitSandbox("0.10.0");
  try {
    const result = check(repo.root, { HARIL_VERSION_CHECK: "lenient" });
    assert.equal(result.code, 1);
    assert.match(result.err, /HARIL_VERSION_CHECK must be "full" or "consistency"/);
  } finally {
    repo.cleanup();
  }
});

test("a heading inside a code fence, or a dummy heading without the base's text, does not keep the base's entry", () => {
  const repo = gitSandbox("0.10.0");
  try {
    // The 0.10.0 entry relabeled as 0.11.0, with "## 0.10.0" only inside a code fence of the new entry.
    writeVersionTree(repo.root, "0.11.0");
    const relabeled = readAt(repo.root, "versions/v0/CHANGELOG.md");
    const fence = "```";
    writeAt(
      repo.root,
      "versions/v0/CHANGELOG.md",
      relabeled.replace(
        "- Algo de 0.11.0.\n",
        `- Algo de 0.11.0.\n\n${fence}\n## 0.10.0\n${fence}\n`,
      ),
    );
    repo.commit("fenced heading");
    const fenced = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(fenced.code, 1, fenced.text);
    assert.match(fenced.err, /0\.10\.0 entry of the base .* is gone/);
    // A real heading below the new entry, but not the base's entry text.
    writeAt(
      repo.root,
      "versions/v0/CHANGELOG.md",
      relabeled.replace("## 0.1.0", "## 0.10.0\n\n- Otra cosa.\n\n---\n\n## 0.1.0"),
    );
    repo.commit("dummy heading");
    const dummy = check(repo.root, { HARIL_VERSION_BASE: repo.base });
    assert.equal(dummy.code, 1, dummy.text);
    assert.match(dummy.err, /0\.10\.0 entry of the base .* is gone/);
  } finally {
    repo.cleanup();
  }
});

test("headings inside code fences are not changelog entries", () => {
  const fence = "~~~";
  const text = `# Log\n\n${fence}md\n## 9.9.9\n${fence}\n\n## 0.2.0\n\n- Real.\n`;
  assert.deepEqual(changelogVersions(text), ["0.2.0"]);
  assert.equal(topChangelogEntry(text)?.version, "0.2.0");
});
