// Stands in for a tool command the fake Pi starts through the shell (scenario hang_with_tool). It writes its pid to
// fake-tool.pid in its working directory, whole (a rename), so the test never reads it half written, then idles.

import { renameSync, writeFileSync } from "node:fs";

writeFileSync("fake-tool.pid.tmp", String(process.pid));
renameSync("fake-tool.pid.tmp", "fake-tool.pid");
setInterval(() => {}, 1000);
