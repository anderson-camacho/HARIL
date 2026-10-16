import { ProcessTerminal } from "@earendil-works/pi-tui";
import { runShell } from "./run.js";
import { readOptionalFile } from "./theme.js";

// Process wiring only: argv, the standard streams and the real terminal. The exit code is set, never forced.
process.exitCode = await runShell(process.argv.slice(2), {
  stdinIsTTY: process.stdin.isTTY,
  stdoutIsTTY: process.stdout.isTTY,
  stderr: (line) => console.error(line),
  readFile: readOptionalFile,
  createTerminal: () => new ProcessTerminal(),
});
