// Test-only child process: takes the write lock of a database and keeps it for the given time, then commits.
// It prints "ready" once it holds the lock. Started as: node --import ./register.mjs ./lock-holder.mjs <dbPath> <holdMs>
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [path, holdText] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("BEGIN EXCLUSIVE");
writeSync(1, "ready\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdText));
db.exec("COMMIT");
db.close();
