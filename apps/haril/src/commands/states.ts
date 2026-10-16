import { legalTargets, TASK_STATES } from "@haril/core";
import { type CliIo, EXIT_OK, EXIT_USAGE } from "../context.js";

// `haril states`: the task states and the legal transitions from the Core state machine.

export function states(args: readonly string[], io: CliIo): number {
  if (args.length > 0) {
    io.err("usage: haril states");
    return EXIT_USAGE;
  }
  io.out(`task states (${TASK_STATES.length}):`);
  for (const state of TASK_STATES) io.out(`  ${state}`);
  io.out("");
  io.out("transitions:");
  for (const from of TASK_STATES) {
    const targets = legalTargets(from);
    const text = targets.length === 0 ? "(terminal)" : targets.join(", ");
    io.out(`  ${from} -> ${text}`);
  }
  return EXIT_OK;
}
