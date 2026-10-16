import { readFileSync } from "node:fs";
import { run } from "./cli.js";

// Process wiring only: argv, console and fs. The exit code is set, never forced with process.exit.
process.exitCode = await run(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  readFile: (path) => readFileSync(path, "utf8"),
});
