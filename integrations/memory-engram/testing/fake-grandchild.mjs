// Stands in for a long-lived process the fake Engram starts through the shell (scenario grandchild). It writes its pid
// to fake-grandchild.pid in the ENGRAM_DATA_DIR it inherits, whole (a rename), so the test never reads it half
// written, then idles. Its working directory is not the data dir, so a stray never holds the test's temp dir open.

import { renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const dataDir = process.env.ENGRAM_DATA_DIR ?? "";
if (!isAbsolute(dataDir)) process.exit(3);
const pidFile = join(dataDir, "fake-grandchild.pid");
writeFileSync(`${pidFile}.tmp`, String(process.pid));
renameSync(`${pidFile}.tmp`, pidFile);
setInterval(() => {}, 1000);
