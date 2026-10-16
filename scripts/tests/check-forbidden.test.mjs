import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkForbidden } from "../check-forbidden.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test("clean fixture passes", () => {
  assert.deepEqual(checkForbidden(fixture("clean")), []);
});

test("eval, new Function and non-literal dynamic import are rejected; literal import passes", () => {
  const violations = checkForbidden(fixture("forbidden-violation"));
  assert.deepEqual(
    violations.map((violation) => [violation.file, violation.line]),
    [
      ["apps/haril/src/index.ts", 3],
      ["apps/haril/src/index.ts", 4],
      ["apps/haril/src/index.ts", 6],
    ],
  );
});

test("real repository has zero forbidden-construct violations", () => {
  assert.deepEqual(checkForbidden(REPO_ROOT), []);
});
