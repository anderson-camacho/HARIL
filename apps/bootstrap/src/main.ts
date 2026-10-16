import { homedir } from "node:os";
import { realExec, realFetch, realFs, runCli } from "./index.js";

// Process wiring only: argv, console, the real fs, child processes and fetch. The exit code is set, never forced.
process.exitCode = await runCli(
  process.argv.slice(2),
  {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  },
  {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDir: homedir(),
    cwd: process.cwd(),
    fs: realFs,
    exec: realExec,
    fetch: realFetch,
    now: () => new Date().toISOString(),
  },
);
