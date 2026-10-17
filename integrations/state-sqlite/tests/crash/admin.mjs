// Test-only child process (INV-01): a CLI-style admin writer. It enqueues task.create commands while the claimers
// run, the way `haril task add` does; only the runtime applies them. It prints "done" after the last enqueue.
// Started as: node --import ./register.mjs ./admin.mjs <dataDir> <projectId> <count>
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { openStore } from "../../src/index.ts";
import { testRules } from "../support.ts";

const [dataDir, projectId, countText] = process.argv.slice(2);
const store = openStore({
  dataDir,
  clock: { now: () => Date.now(), schedule: () => () => undefined },
  ids: { next: () => randomUUID() },
  rules: testRules,
});
try {
  for (let n = 0; n < Number(countText); n += 1) {
    const key = randomUUID();
    store.commands.enqueue({
      type: "task.create",
      projectId,
      args: {
        goal: `admin ${n}`,
        dependsOn: [],
        agent: "fake:succeed",
        maxAttempts: 1,
        timeoutMs: 1000,
      },
      idempotencyKey: key,
      requestHash: key,
    });
  }
  writeSync(1, "done\n");
} catch (error) {
  writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 3;
} finally {
  store.close();
}
