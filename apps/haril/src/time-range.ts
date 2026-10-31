import { lastValue, type ParsedArgs } from "./args.js";
import { parseDuration, parseInstant } from "./commands/usage-format.js";
import type { HostInfo } from "./context.js";
import { clockFor } from "./host.js";

// The time bounds `haril usage` and `haril events` share: --since is measured back from now, --from is inclusive and
// --to exclusive, and `before` is the alias --before has in `haril usage` (it is only read when that command declares it).
// All values are epoch milliseconds, the unit of the stores' ts columns.

export interface TimeRange {
  readonly from?: number;
  readonly to?: number;
}

export type Problem = { readonly problem: string };

export function isProblem(value: unknown): value is Problem {
  return typeof value === "object" && value !== null && "problem" in value;
}

export function timeRange(parsed: ParsedArgs, host: HostInfo): TimeRange | Problem {
  const since = lastValue(parsed, "--since");
  const fromText = lastValue(parsed, "--from");
  const toText = lastValue(parsed, "--to") ?? lastValue(parsed, "--before");
  if (since !== undefined && (fromText !== undefined || toText !== undefined)) {
    return { problem: "give either --since or --from/--to, not both" };
  }
  if (since !== undefined) {
    const duration = parseDuration(since);
    if (duration === null) {
      return { problem: `--since takes a duration such as 90s, 15m, 2h, 7d or 1w; got "${since}"` };
    }
    return { from: clockFor(host).now() - duration };
  }
  const range: { from?: number; to?: number } = {};
  for (const [name, text] of [
    ["--from", fromText],
    ["--to", toText],
  ] as const) {
    if (text === undefined) continue;
    const value = parseInstant(text);
    if (value === null) {
      return {
        problem: `${name} takes an ISO 8601 date or time, or epoch milliseconds; got "${text}"`,
      };
    }
    if (name === "--from") range.from = value;
    else range.to = value;
  }
  return range;
}

// The same range, but one with both bounds must start before it ends: `haril events` refuses the rest instead of
// printing nothing (`haril usage` keeps accepting it, as it always has).
export function orderedTimeRange(parsed: ParsedArgs, host: HostInfo): TimeRange | Problem {
  const range = timeRange(parsed, host);
  if (isProblem(range)) return range;
  if (range.from !== undefined && range.to !== undefined && range.from >= range.to) {
    return { problem: "--from must be before --to" };
  }
  return range;
}
