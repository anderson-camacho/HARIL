import type { CliIo } from "./context.js";
import { EXIT_USAGE } from "./context.js";

// Minimal option parser shared by the commands: `--name v`, `--name=v`, repeatable values, boolean flags.
// Anything else that starts with "-" is an unknown option; the rest are positionals.

export interface ArgSpec {
  readonly values: readonly string[];
  readonly flags: readonly string[];
}

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly flags: ReadonlySet<string>;
  readonly unknown: readonly string[];
  // A value option that had no value (end of line, or followed by another option).
  readonly missingValue: string | undefined;
}

export function parseArgs(args: readonly string[], spec: ArgSpec): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const unknown: string[] = [];
  let missingValue: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;

    if (equals < 0 && spec.flags.includes(arg)) {
      flags.add(arg);
    } else if (spec.values.includes(name)) {
      let value: string | undefined;
      if (equals > 0) {
        value = arg.slice(equals + 1);
      } else {
        const next = args[index + 1];
        if (next === undefined || next.startsWith("-")) {
          missingValue ??= name;
          continue;
        }
        value = next;
        index++;
      }
      const list = values.get(name) ?? [];
      list.push(value);
      values.set(name, list);
    } else if (arg.startsWith("-") && arg !== "-") {
      unknown.push(arg);
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, values, flags, unknown, missingValue };
}

// The last value given for an option, or undefined.
export function lastValue(parsed: ParsedArgs, name: string): string | undefined {
  const list = parsed.values.get(name);
  return list?.[list.length - 1];
}

export function allValues(parsed: ParsedArgs, name: string): string[] {
  return [...(parsed.values.get(name) ?? [])];
}

// Prints the first parsing problem and returns the usage exit code, or null when the args are fine.
export function argsProblem(parsed: ParsedArgs, io: CliIo): number | null {
  if (parsed.missingValue !== undefined) {
    io.err(`haril: ${parsed.missingValue} needs a value`);
    return EXIT_USAGE;
  }
  const [first] = parsed.unknown;
  if (first !== undefined) {
    io.err(`haril: unknown option "${first}"`);
    return EXIT_USAGE;
  }
  return null;
}
