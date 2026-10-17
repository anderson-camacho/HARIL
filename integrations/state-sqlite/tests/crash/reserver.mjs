// Test-only child process (INV-03): reserves against one budget, count times, with a fixed amount. It prints "ok"
// for a reservation that held and "refused <reason> <budgetId>" for one that did not.
// Started as: node --import ./register.mjs ./reserver.mjs <dataDir> <budgetId> <runId> <taskId> <tag> <count> <amount>
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { openStore } from "../../src/index.ts";
import { testRules } from "../support.ts";

const [dataDir, budgetId, runId, taskId, tag, countText, amountText] = process.argv.slice(2);
const store = openStore({
  dataDir,
  clock: { now: () => Date.now(), schedule: () => () => undefined },
  ids: { next: () => randomUUID() },
  rules: testRules,
});
try {
  for (let n = 0; n < Number(countText); n += 1) {
    const result = store.budgets.reserve({
      budgetIds: [budgetId],
      amount: Number(amountText),
      idempotencyKey: `${tag}-${n}`,
      runId,
      taskId,
      routeId: "route-test",
    });
    writeSync(1, result.ok ? "ok\n" : `refused ${result.reason} ${result.budgetId}\n`);
  }
  writeSync(1, "done\n");
} catch (error) {
  writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 3;
} finally {
  store.close();
}
