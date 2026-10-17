// Test-only child process (INV-01): one of N processes that claim against the same store, with the epoch of the
// runtime that holds the lease, until nothing is ready. It prints each task id after its claim returned.
// Started as: node --import ./register.mjs ./claimer.mjs <dataDir> <epoch>
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { openStore } from "../../src/index.ts";
import { testRules } from "../support.ts";

const [dataDir, epochText] = process.argv.slice(2);
const store = openStore({
  dataDir,
  clock: { now: () => Date.now(), schedule: () => () => undefined },
  ids: { next: () => randomUUID() },
  rules: testRules,
});
try {
  for (;;) {
    const claimed = store.tasks.claimNext(Number(epochText));
    if (claimed === undefined) break;
    writeSync(1, `${claimed.taskId}\n`);
  }
  writeSync(1, "done\n");
} catch (error) {
  writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 3;
} finally {
  store.close();
}
