import assert from "node:assert/strict";
import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main, nextVersion } from "../bump-version.mjs";
import { PLACEHOLDER } from "../lib/version-files.mjs";
import { capture, readAt, sandbox, writeAt, writeVersionTree } from "./version-fixture.mjs";

// scripts/bump-version.mjs (the user's permanent rule: every delivered change bumps the version and adds its
// CHANGELOG entry, newest on top). Every test runs on a temporary tree.

test("nextVersion: patch, minor, major and an explicit version", () => {
  assert.equal(nextVersion("0.10.0", "patch"), "0.10.1");
  assert.equal(nextVersion("0.10.3", "minor"), "0.11.0");
  assert.equal(nextVersion("0.10.3", "major"), "1.0.0");
  assert.equal(nextVersion("0.10.0", "0.12.0"), "0.12.0");
  assert.throws(() => nextVersion("0.10.0", "0.10.0"), /greater than 0\.10\.0/);
  assert.throws(() => nextVersion("0.10.0", "0.9.9"), /greater than/);
  assert.throws(() => nextVersion("0.10.0", "banana"), /patch, minor, major or x\.y\.z/);
});

test("a minor bump updates every version string, the changelog and versions/README.md", () => {
  const { root, cleanup } = sandbox();
  try {
    writeVersionTree(root, "0.10.0");
    const io = capture();
    assert.equal(main(["minor"], { root, today: "2026-10-18", ...io }), 0, io.text());

    for (const path of [
      "package.json",
      "apps/haril/package.json",
      "apps/bootstrap/package.json",
      "apps/shell/package.json",
    ]) {
      assert.equal(JSON.parse(readAt(root, path)).version, "0.11.0", path);
    }
    assert.match(
      readAt(root, "apps/haril/src/version.ts"),
      /^export const VERSION = "0\.11\.0";$/m,
    );
    assert.match(readAt(root, "README.md"), /^Versión actual: \*\*0\.11\.0\*\*\. El estado/m);

    const versions = readAt(root, "versions/README.md");
    assert.match(versions, /^- \*\*Versión actual:\*\* 0\.11\.0\.$/m);
    assert.match(versions, /^- \[v0\]\(v0\/CHANGELOG\.md\): versiones 0\.1\.0 a 0\.11\.0\.$/m);
    assert.match(versions, /^- \*\*Estado:\*\* algo que el autor describe\.$/m);

    const log = readAt(root, "versions/v0/CHANGELOG.md");
    const top = log.indexOf("## 0.11.0");
    assert.ok(top > 0 && top < log.indexOf("## 0.10.0"), "new entry above the previous one");
    assert.match(
      log,
      /## 0\.11\.0\n\n- \*\*Fecha:\*\* 2026-10-18\n- \*\*Estado:\*\* TODO\(bump-version\)/,
    );
    assert.ok(log.slice(top, log.indexOf("## 0.10.0")).includes("\n---\n\n"), "entry separator");
    assert.ok(log.includes(PLACEHOLDER));
    assert.match(io.out.join("\n"), /0\.10\.0 -> 0\.11\.0/);
    assert.match(io.out.join("\n"), /TODO\(bump-version\)/);
  } finally {
    cleanup();
  }
});

test("line endings are preserved file by file", () => {
  const { root, cleanup } = sandbox();
  try {
    writeVersionTree(root, "0.10.0");
    const crlf = (text) => text.replace(/\n/g, "\r\n");
    writeAt(root, "README.md", crlf(readAt(root, "README.md")));
    writeAt(root, "versions/v0/CHANGELOG.md", crlf(readAt(root, "versions/v0/CHANGELOG.md")));
    const io = capture();
    assert.equal(main(["patch"], { root, today: "2026-10-18", ...io }), 0, io.text());

    const readme = readAt(root, "README.md");
    assert.match(readme, /Versión actual: \*\*0\.10\.1\*\*/);
    assert.equal(readme.replace(/\r\n/g, "").includes("\n"), false, "README.md keeps CRLF only");
    const log = readAt(root, "versions/v0/CHANGELOG.md");
    assert.match(log, /## 0\.10\.1\r\n\r\n- \*\*Fecha:\*\* 2026-10-18\r\n/);
    assert.equal(log.replace(/\r\n/g, "").includes("\n"), false, "CHANGELOG keeps CRLF only");
    assert.equal(readAt(root, "package.json").includes("\r"), false, "LF files stay LF");
  } finally {
    cleanup();
  }
});

test("a major bump starts the changelog of the new major and lists its folder", () => {
  const { root, cleanup } = sandbox();
  try {
    writeVersionTree(root, "0.10.0");
    const io = capture();
    assert.equal(main(["major"], { root, today: "2026-10-18", ...io }), 0, io.text());
    assert.ok(existsSync(join(root, "versions/v1/CHANGELOG.md")));
    const log = readAt(root, "versions/v1/CHANGELOG.md");
    assert.match(log, /^# Changelog de HARIL, versión mayor 1\n/);
    assert.match(log, /\n---\n\n## 1\.0\.0\n\n- \*\*Fecha:\*\* 2026-10-18\n/);
    const versions = readAt(root, "versions/README.md");
    assert.match(versions, /^- \*\*Versión actual:\*\* 1\.0\.0\.$/m);
    assert.ok(
      versions.indexOf("- [v1](v1/CHANGELOG.md): versiones 1.0.0 a 1.0.0.") <
        versions.indexOf("- [v0](v0/CHANGELOG.md): versiones 0.1.0 a 0.10.0."),
      "newest major first, older range untouched",
    );
  } finally {
    cleanup();
  }
});

test("refuses a version whose changelog entry already exists, and changes nothing", () => {
  const { root, cleanup } = sandbox();
  try {
    writeVersionTree(root, "0.10.0", { previous: ["0.11.0"] });
    const before = readAt(root, "package.json");
    const io = capture();
    assert.equal(main(["minor"], { root, today: "2026-10-18", ...io }), 1);
    assert.match(io.err.join("\n"), /already has an entry for 0\.11\.0/);
    assert.equal(readAt(root, "package.json"), before);
  } finally {
    cleanup();
  }
});

test("refuses when a version string cannot be found, and changes nothing", () => {
  const { root, cleanup } = sandbox();
  try {
    writeVersionTree(root, "0.10.0");
    writeAt(root, "apps/haril/src/version.ts", "export const NOT_THE_VERSION = 1;\n");
    const before = readAt(root, "package.json");
    const io = capture();
    assert.equal(main(["patch"], { root, today: "2026-10-18", ...io }), 1);
    assert.match(io.err.join("\n"), /apps\/haril\/src\/version\.ts/);
    assert.equal(readAt(root, "package.json"), before);
  } finally {
    cleanup();
  }
});

test("prints its usage and exits 2 without an argument or with a bad one", () => {
  const io = capture();
  assert.equal(main([], { root: ".", ...io }), 2);
  assert.match(io.err.join("\n"), /usage: bump-version\.mjs <patch\|minor\|major\|x\.y\.z>/);
  assert.equal(main(["minor", "--date", "yesterday"], { root: ".", ...capture() }), 2);
});

test("a failure before the renames leaves every file untouched and no temporary file behind", () => {
  const { root, cleanup } = sandbox();
  try {
    writeVersionTree(root, "0.10.0");
    const paths = [
      "package.json",
      "apps/haril/package.json",
      "apps/bootstrap/package.json",
      "apps/shell/package.json",
      "apps/haril/src/version.ts",
      "README.md",
      "versions/README.md",
      "versions/v0/CHANGELOG.md",
    ];
    const before = Object.fromEntries(paths.map((path) => [path, readAt(root, path)]));
    let writes = 0;
    const io = capture();
    const code = main(["minor"], {
      root,
      today: "2026-10-18",
      ...io,
      fs: {
        writeTemp: (path, content) => {
          writes += 1;
          if (writes === 3) throw new Error("disk full (injected)");
          writeFileSync(path, content, "utf8");
        },
      },
    });
    assert.equal(code, 1, io.text());
    assert.match(io.err.join("\n"), /disk full \(injected\).*nothing changed/);
    for (const path of paths) assert.equal(readAt(root, path), before[path], path);
    const leftovers = listFiles(root).filter((path) => path.includes(".bump-"));
    assert.deepEqual(leftovers, []);
  } finally {
    cleanup();
  }
});

test("writes every file through a temporary file next to it, renamed at the end", () => {
  const { root, cleanup } = sandbox();
  try {
    writeVersionTree(root, "0.10.0");
    const renamed = [];
    const io = capture();
    const code = main(["patch"], {
      root,
      today: "2026-10-18",
      ...io,
      fs: {
        rename: (from, to) => {
          assert.ok(existsSync(from), from);
          assert.equal(dirname(from), dirname(to));
          renamed.push(to);
          renameSync(from, to);
        },
      },
    });
    assert.equal(code, 0, io.text());
    assert.equal(renamed.length, 8);
    assert.equal(JSON.parse(readAt(root, "package.json")).version, "0.10.1");
  } finally {
    cleanup();
  }
});

function listFiles(root, relative = "") {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    return entry.isDirectory() ? listFiles(root, path) : [path];
  });
}
