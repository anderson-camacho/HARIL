// Test-only child process: commits small write transactions back to back on an existing store file, so that an open
// in the parent meets a write lock most of the time (INV-01 family, open next to a busy writer). It prints "ready"
// after its first commit and stops at the time limit or when the parent kills it.
// Started as: node --import ./register.mjs ./churner.mjs <dbPath> <durationMs>
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [path, durationText] = process.argv.slice(2);
const deadline = Date.now() + Number(durationText);
const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS churn (n INTEGER NOT NULL)");
const insert = db.prepare("INSERT INTO churn (n) VALUES (?)");
let first = true;
for (let n = 0; Date.now() < deadline; n += 1) {
  db.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < 200; i += 1) insert.run(n);
  db.exec("COMMIT");
  if (first) {
    first = false;
    writeSync(1, "ready\n");
  }
}
db.close();
