import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkLayers } from "../check-layers.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const byRule = (violations, rule) => violations.filter((violation) => violation.rule === rule);

test("clean fixture passes every layer rule", () => {
  assert.deepEqual(checkLayers(fixture("clean")), []);
});

test("R1: @earendil-works/* outside agent-pi and agent-pi-bridge is rejected", () => {
  const r1 = byRule(checkLayers(fixture("r1-earendil")), "R1");
  assert.equal(r1.length, 2);
  assert.deepEqual(r1.map((violation) => violation.file).sort(), [
    "apps/haril/src/index.ts",
    "integrations/git/src/index.ts",
  ]);
});

test("R1 exception: pi-tui is only importable from apps/shell; other Pi packages stay forbidden there", () => {
  const r1 = byRule(checkLayers(fixture("r1-pi-tui-shell")), "R1");
  assert.deepEqual(r1.map((violation) => violation.file).sort(), [
    "apps/haril/src/index.ts",
    "apps/shell/src/index.ts",
  ]);
  assert.match(
    r1.find((violation) => violation.file === "apps/shell/src/index.ts").message,
    /pi-coding-agent/,
  );
});

test("R2: importing another workspace src/ path is rejected (bare and relative)", () => {
  const r2 = byRule(checkLayers(fixture("r2-src-import")), "R2");
  assert.equal(r2.length, 2);
  assert.ok(r2.every((violation) => violation.file === "integrations/git/src/index.ts"));
});

test("R3: a workspace: dependency cycle is rejected once", () => {
  const r3 = byRule(checkLayers(fixture("r3-cycle")), "R3");
  assert.equal(r3.length, 1);
  assert.match(r3[0].message, /@haril\/git/);
  assert.match(r3[0].message, /@haril\/os/);
});

test("R4: contracts and core may not import node builtins (prefixed or bare)", () => {
  const r4 = byRule(checkLayers(fixture("r4-node-in-core")), "R4");
  assert.equal(r4.length, 3);
});

test("R6: agent-pi-bridge may not import core or node:child_process", () => {
  const r6 = byRule(checkLayers(fixture("r6-bridge-core")), "R6");
  assert.equal(r6.length, 2);
});

test("R8: win32/posix variants are only importable from integrations/os", () => {
  const r8 = byRule(checkLayers(fixture("r8-win32")), "R8");
  assert.equal(r8.length, 2);
  assert.ok(r8.every((violation) => violation.file === "apps/haril/src/index.ts"));
});

test("R9: gateway broker may not import gateway providers", () => {
  const r9 = byRule(checkLayers(fixture("r9-broker-providers")), "R9");
  assert.equal(r9.length, 1);
  assert.equal(r9[0].file, "integrations/gateway/src/broker/index.ts");
});

test("R10: executor and orchestrator importing each other is a cycle in both directions", () => {
  const r10 = byRule(checkLayers(fixture("r10-cycle")), "R10");
  assert.equal(r10.length, 2);
});

test("R10: kernel (layer 0) importing router (layer 2) is rejected", () => {
  const r10 = byRule(checkLayers(fixture("r10-kernel-router")), "R10");
  assert.equal(r10.length, 1);
  assert.equal(r10[0].file, "packages/core/src/kernel/index.ts");
});

test("integration importing a VALUE from core is rejected, type-only imports pass", () => {
  const matrix = byRule(checkLayers(fixture("integration-value-core")), "MATRIX");
  assert.deepEqual(matrix.map((violation) => violation.file).sort(), [
    "integrations/git/src/index.ts",
    "integrations/git/src/mixed.ts",
  ]);
});

test("guard: a tree with zero scanned edges fails", () => {
  const guard = byRule(checkLayers(fixture("empty-tree")), "GUARD");
  assert.ok(guard.length >= 1);
});

test("guard: a workspace directory without a layer assignment fails", () => {
  const guard = byRule(checkLayers(fixture("unlayered")), "GUARD");
  assert.equal(guard.length, 1);
  assert.match(guard[0].message, /packages\/misc/);
});

test("AR-G2b corpus: import-shaped text in comments, strings and templates is not an edge", () => {
  assert.deepEqual(checkLayers(fixture("corpus")), []);
});

test("real repository has zero layer violations", () => {
  assert.deepEqual(checkLayers(REPO_ROOT), []);
});
