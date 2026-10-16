import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main, readPins, renderSection, replaceSection } from "../generate-compat.mjs";

// Generated version table of docs/COMPATIBILITY.md (M3-T5, criterion 14). Every test runs on a temporary copy
// of the manifests and the document, so nothing here reads or writes the real repository.

const BEGIN = "<!-- BEGIN GENERATED: versions -->";
const END = "<!-- END GENERATED: versions -->";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "haril-compat-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeAt(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function fixtureRoot(root, overrides = {}) {
  const devDependencies = {
    typescript: "7.0.2",
    vitest: "5.0.4",
    "@biomejs/biome": "2.5.15",
    knip: "6.41.0",
    tsdown: "0.23.1",
    ...overrides.devDependencies,
  };
  writeAt(
    root,
    "package.json",
    JSON.stringify({ packageManager: "pnpm@12.11.2", devDependencies }, null, 2),
  );
  writeAt(
    root,
    "packages/contracts/package.json",
    JSON.stringify({ dependencies: { typebox: "1.3.27" } }, null, 2),
  );
  writeAt(
    root,
    "apps/bootstrap/src/constants.ts",
    [
      "// Pinned runtime versions.",
      'export const NODE_VERSION = "24.22.0";',
      'export const NODE_DIST_BASE = "https://nodejs.org/dist/";',
      'export const PI_PACKAGE = "@earendil-works/pi-coding-agent";',
      'export const PI_VERSION = "1.2.0";',
      "",
    ].join("\n"),
  );
  writeAt(
    root,
    "docs/COMPATIBILITY.md",
    `# Title\n\nIntro text.\n\n${BEGIN}\nstale table\n${END}\n\n## Rest\n\nKept as is.\n`,
  );
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
}

test("readPins returns the nine pinned components in document order", () => {
  const sb = sandbox();
  try {
    fixtureRoot(sb.root);
    const pins = readPins(sb.root);
    assert.deepEqual(
      pins.map((pin) => [pin.component, pin.version]),
      [
        ["Node", "24.22.0"],
        ["Pi", "1.2.0"],
        ["pnpm", "12.11.2"],
        ["TypeScript", "7.0.2"],
        ["typebox", "1.3.27"],
        ["Vitest", "5.0.4"],
        ["Biome", "2.5.15"],
        ["knip", "6.41.0"],
        ["tsdown", "0.23.1"],
      ],
    );
  } finally {
    sb.cleanup();
  }
});

test("readPins fails loudly when a bootstrap constant is missing", () => {
  const sb = sandbox();
  try {
    fixtureRoot(sb.root);
    writeAt(sb.root, "apps/bootstrap/src/constants.ts", 'export const PI_VERSION = "1.2.0";\n');
    assert.throws(() => readPins(sb.root), /NODE_VERSION/);
  } finally {
    sb.cleanup();
  }
});

test("readPins rejects a range instead of an exact pin", () => {
  const sb = sandbox();
  try {
    fixtureRoot(sb.root, { devDependencies: { vitest: "^5.0.4" } });
    assert.throws(() => readPins(sb.root), /vitest.*exact/);
  } finally {
    sb.cleanup();
  }
});

test("renderSection writes a Spanish table between the markers", () => {
  const sb = sandbox();
  try {
    fixtureRoot(sb.root);
    const section = renderSection(readPins(sb.root));
    assert.ok(section.startsWith(BEGIN));
    assert.ok(section.trimEnd().endsWith(END));
    assert.match(section, /\| Componente \| Versión fijada \| Origen \| Verificado \|/);
    assert.match(section, /\| Node \| 24\.22\.0 \| .* \| no, pendiente del usuario \|/);
    assert.match(section, /\| Pi \| 1\.2\.0 \| .* \| no, pendiente del usuario \|/);
    assert.match(section, /\| Vitest \| 5\.0\.4 \| .* \| sí, en CI \|/);
  } finally {
    sb.cleanup();
  }
});

test("replaceSection keeps every byte outside the markers and fails without them", () => {
  const doc = `A\n${BEGIN}\nold\n${END}\nB\n`;
  const next = replaceSection(doc, `${BEGIN}\nnew\n${END}`);
  assert.equal(next, `A\n${BEGIN}\nnew\n${END}\nB\n`);
  assert.throws(() => replaceSection("no markers here\n", `${BEGIN}\n${END}`), /marker/);
});

test("generate writes the section and check then passes", () => {
  const sb = sandbox();
  try {
    fixtureRoot(sb.root);
    const generate = capture();
    assert.equal(main([], { root: sb.root, stdout: generate.stdout, stderr: generate.stderr }), 0);
    const doc = readFileSync(join(sb.root, "docs/COMPATIBILITY.md"), "utf8");
    assert.ok(doc.includes("| Vitest | 5.0.4 |"));
    assert.ok(doc.includes("## Rest\n\nKept as is.\n"));
    assert.ok(!doc.includes("stale table"));

    const check = capture();
    assert.equal(
      main(["--check"], { root: sb.root, stdout: check.stdout, stderr: check.stderr }),
      0,
    );
  } finally {
    sb.cleanup();
  }
});

test("check exits 1 with a hint when a pin changed after generation", () => {
  const sb = sandbox();
  try {
    fixtureRoot(sb.root);
    assert.equal(main([], { root: sb.root, ...capture() }), 0);
    const pkg = JSON.parse(readFileSync(join(sb.root, "package.json"), "utf8"));
    pkg.devDependencies.vitest = "5.0.5";
    writeAt(sb.root, "package.json", JSON.stringify(pkg, null, 2));
    const check = capture();
    assert.equal(
      main(["--check"], { root: sb.root, stdout: check.stdout, stderr: check.stderr }),
      1,
    );
    assert.match(check.err.join("\n"), /stale/);
    assert.match(check.err.join("\n"), /generate:compat/);
  } finally {
    sb.cleanup();
  }
});

test("generate and check fail with exit 1 when the document has no markers", () => {
  const sb = sandbox();
  try {
    fixtureRoot(sb.root);
    writeAt(sb.root, "docs/COMPATIBILITY.md", "# No markers\n");
    const run = capture();
    assert.equal(main([], { root: sb.root, stdout: run.stdout, stderr: run.stderr }), 1);
    assert.equal(readFileSync(join(sb.root, "docs/COMPATIBILITY.md"), "utf8"), "# No markers\n");
  } finally {
    sb.cleanup();
  }
});

test("check passes with a one-line notice when the document is absent (public export)", () => {
  const sb = sandbox();
  try {
    fixtureRoot(sb.root);
    rmSync(join(sb.root, "docs"), { recursive: true, force: true });
    const check = capture();
    assert.equal(
      main(["--check"], { root: sb.root, stdout: check.stdout, stderr: check.stderr }),
      0,
    );
    assert.equal(check.out.length, 1);
    assert.match(check.out[0], /docs\/COMPATIBILITY\.md.*no existe/);
    assert.deepEqual(check.err, []);
  } finally {
    sb.cleanup();
  }
});

test("generate still fails when the document is absent", () => {
  const sb = sandbox();
  try {
    fixtureRoot(sb.root);
    rmSync(join(sb.root, "docs"), { recursive: true, force: true });
    const run = capture();
    assert.equal(main([], { root: sb.root, stdout: run.stdout, stderr: run.stderr }), 1);
    assert.match(run.err.join("\n"), /generate-compat/);
    assert.equal(existsSync(join(sb.root, "docs")), false);
  } finally {
    sb.cleanup();
  }
});
