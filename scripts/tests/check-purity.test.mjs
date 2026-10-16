import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkPurity } from "../check-purity.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test("clean fixture: forbidden names only in comments and strings pass", () => {
  assert.deepEqual(checkPurity(fixture("clean")), []);
});

test("every listed impure API in core is reported on its own line", () => {
  const violations = checkPurity(fixture("purity-violation"));
  assert.deepEqual(
    violations.map((violation) => [violation.file, violation.line]),
    [
      ["packages/core/src/domain/index.ts", 1],
      ["packages/core/src/domain/index.ts", 2],
      ["packages/core/src/domain/index.ts", 3],
      ["packages/core/src/domain/index.ts", 4],
      ["packages/core/src/domain/index.ts", 5],
      ["packages/core/src/domain/index.ts", 6],
    ],
  );
});

test("real repository has zero purity violations", () => {
  assert.deepEqual(checkPurity(REPO_ROOT), []);
});
