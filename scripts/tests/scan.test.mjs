import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scanSource, stripSource } from "../lib/scan.mjs";

const summary = (source) =>
  scanSource(source).edges.map((edge) => [edge.specifier, edge.kind, edge.typeOnly]);

test("stripSource hides import-shaped text in comments, strings and templates", () => {
  const source = [
    "// import a from 'x'",
    '/* import b from "y" */',
    "const s = \"import c from 'z'\";",
    "const t = `import d from 'w'`;",
    "",
  ].join("\n");
  assert.deepEqual(scanSource(source).edges, []);
  assert.equal(stripSource(source).code.length, source.length);
});

test("template substitutions stay code and are scanned", () => {
  const substitution = "$" + "{import('dyn')}";
  const edges = scanSource(["const t = `", substitution, "`;"].join("")).edges;
  assert.deepEqual(edges, [
    { kind: "dynamic", specifier: "dyn", typeOnly: false, literal: true, line: 1, offset: 13 },
  ]);
});

test("static, side-effect, export and type-only forms are classified", () => {
  const source = [
    "import a, { b as c } from 'one';",
    "import 'two';",
    "export * from 'three';",
    "export { d } from 'four';",
    "import type { E } from 'five';",
    "import { type F, type G } from 'six';",
    "import { H, type I } from 'seven';",
    "export type { J } from 'eight';",
  ].join("\n");
  assert.deepEqual(summary(source), [
    ["one", "import", false],
    ["two", "import", false],
    ["three", "export", false],
    ["four", "export", false],
    ["five", "import", true],
    ["six", "import", true],
    ["seven", "import", false],
    ["eight", "export", true],
  ]);
});

test("multi-line import reports the line where the statement starts", () => {
  const source = "const q = 1;\nimport {\n  a,\n  b,\n} from 'multi';\n";
  const [edge] = scanSource(source).edges;
  assert.equal(edge.specifier, "multi");
  assert.equal(edge.line, 2);
});

test("dynamic imports: literal is recorded, anything else is non-literal", () => {
  const source = [
    "import(name);",
    "import('a' + b);",
    "import('lit');",
    "import(`tpl`);",
    "import(/* c */ 'after-comment');",
  ].join("\n");
  assert.deepEqual(
    scanSource(source).edges.map((edge) => [edge.specifier, edge.literal]),
    [
      [null, false],
      [null, false],
      ["lit", true],
      [null, false],
      ["after-comment", true],
    ],
  );
});

test("regex literals and division do not confuse the stripper", () => {
  const source = [
    "const r = /'/;",
    'const r2 = /import z from "no"/g;',
    "const d = a / b / c;",
    "import x from 'after-regex';",
  ].join("\n");
  assert.deepEqual(summary(source), [["after-regex", "import", false]]);
});

test("identifiers that only look like imports are not edges", () => {
  const source = [
    "foo.import('x');",
    "const importer = 1;",
    "export const reimport = 'import a from \"b\"';",
  ].join("\n");
  assert.deepEqual(scanSource(source).edges, []);
});

test("AR-G2b corpus: only the real edges are reported, in source order", () => {
  const corpus = readFileSync(
    fileURLToPath(new URL("./fixtures/corpus/integrations/git/src/index.ts", import.meta.url)),
    "utf8",
  );
  assert.deepEqual(summary(corpus), [
    ["@haril/core", "import", true],
    ["@haril/contracts", "export", false],
    ["@haril/contracts", "export", false],
    ["@haril/contracts", "export", true],
    ["@haril/contracts", "import", false],
    ["@haril/contracts", "dynamic", false],
  ]);
});
