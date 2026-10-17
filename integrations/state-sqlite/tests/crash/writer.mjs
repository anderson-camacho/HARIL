// Test-only child process: opens the real store on a data directory and creates tasks through the command queue
// until the parent kills it. After every commit returns it prints the task id, so the parent knows what was
// confirmed. It uses writeSync, which is synchronous on every platform, so a printed id is never lost in a buffer.
// Started as: node --import ./register.mjs ./writer.mjs <dataDir> <projectId>
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { openStore } from "../../src/index.ts";
import { testRules } from "../support.ts";

const [dataDir, projectId] = process.argv.slice(2);

const store = openStore({
  dataDir,
  clock: { now: () => Date.now(), schedule: () => () => undefined },
  ids: { next: () => randomUUID() },
  rules: testRules,
  // A lease left by a killed child belongs to a dead pid: take it over at once.
  isPidAlive: () => false,
});
const grant = store.runtime.acquire({
  pid: process.pid,
  nodeVersion: process.version,
  sqliteVersion: store.info().sqliteVersion,
  ttlMs: 600_000,
});
if (!grant.ok) {
  writeSync(2, `lease refused: ${grant.error.message}\n`);
  process.exit(3);
}
const epoch = grant.value.epoch;
writeSync(1, "ready\n");

for (let n = 0; ; n += 1) {
  const key = randomUUID();
  store.commands.enqueue({
    type: "task.create",
    projectId,
    args: {
      goal: `goal ${n}`,
      dependsOn: [],
      agent: "fake:succeed",
      maxAttempts: 1,
      timeoutMs: 1000,
    },
    idempotencyKey: key,
    requestHash: key,
  });
  const applied = store.commands.applyNext(epoch);
  const taskId = applied?.taskIds[0];
  if (applied?.outcome !== "applied" || taskId === undefined) {
    writeSync(2, `command not applied: ${JSON.stringify(applied)}\n`);
    process.exit(4);
  }
  writeSync(1, `${taskId}\n`);
}
