// Test-only child process (INV-15): a second runtime whose clock is offset by a fixed amount. It asks for the lease
// with the process's real pid as holder. When refused it prints "busy <pid>"; when granted it prints "acquired
// <epoch>", reconciles the orphans of the previous holder (as the runtime does at start), then claims until none is
// ready, printing each id, and "done".
// Started as: node --import ./register.mjs ./contender.mjs <dataDir> <skewMs> <maxInfraRestarts>
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { openStore } from "../../src/index.ts";
import { testRules } from "../support.ts";

const [dataDir, skewText, maxText] = process.argv.slice(2);
const store = openStore({
  dataDir,
  clock: { now: () => Date.now() + Number(skewText), schedule: () => () => undefined },
  ids: { next: () => randomUUID() },
  rules: testRules,
  // The holder of the lease under test is this test's own process, which is alive.
  isPidAlive: () => true,
});
try {
  const grant = store.runtime.acquire({
    pid: process.pid,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 30_000,
  });
  if (!grant.ok) {
    writeSync(1, `busy ${grant.error.pid}\n`);
  } else {
    const epoch = grant.value.epoch;
    writeSync(1, `acquired ${epoch}\n`);
    const reconciled = store.runtime.reconcile(epoch, Number(maxText));
    writeSync(1, `reconciled ${reconciled.length}\n`);
    for (;;) {
      const claimed = store.tasks.claimNext(epoch);
      if (claimed === undefined) break;
      writeSync(1, `${claimed.taskId}\n`);
    }
    writeSync(1, "done\n");
  }
} catch (error) {
  writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 3;
} finally {
  store.close();
}
