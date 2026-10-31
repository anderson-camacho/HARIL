import { visibleText } from "@haril/core";
import type { EventRecord } from "@haril/core/ports";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { isProblem, orderedTimeRange } from "../time-range.js";
import { dataDirFor, openExisting } from "./common.js";

// `haril events` (M1-T6): read-only. Newest last, one line per event; a missing database is never created. The time
// range (the console's ACT tab uses it) is the one of `haril usage log`: --since back from now, or --from (inclusive)
// and --to (exclusive); --limit keeps the newest events inside it.
const USAGE = [
  "usage: haril events [--project <slug>] [--task <id>] [--limit <n>] [--json] [--data-dir <path>]",
  "    [--since <duration> | --from <time> --to <time>]",
].join("\n");
const NOT_INITIALIZED =
  "store not initialized (run haril project init <path> --name <name> --yes first)";
const DEFAULT_LIMIT = 50;

export function events(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: ["--project", "--task", "--limit", "--since", "--from", "--to", "--data-dir"],
    flags: ["--json"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const range = orderedTimeRange(parsed, host);
  if (isProblem(range)) {
    io.err(`haril: ${range.problem}`);
    return EXIT_USAGE;
  }

  const limitText = lastValue(parsed, "--limit");
  const limit = limitText === undefined ? DEFAULT_LIMIT : Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    io.err("haril: --limit must be a whole number of at least 1");
    return EXIT_USAGE;
  }

  const store = openExisting(host, dataDirFor(host, lastValue(parsed, "--data-dir")));
  if (store === undefined) {
    io.err(`haril: ${NOT_INITIALIZED}`);
    return EXIT_USAGE;
  }
  try {
    const slug = lastValue(parsed, "--project");
    let projectId: string | undefined;
    if (slug !== undefined) {
      const project = store.projects.getBySlug(slug);
      if (project === undefined) {
        io.err(`haril: no project with slug "${slug}"`);
        return EXIT_USAGE;
      }
      projectId = project.projectId;
    }
    const rows = store.events.list({
      projectId,
      taskId: lastValue(parsed, "--task"),
      ...range,
      limit,
    });
    if (parsed.flags.has("--json")) {
      io.out(JSON.stringify(rows.map(toView)));
    } else {
      // LD-T7c: payloads carry goals and reasons an agent may have written, shown as the terminal draws them.
      for (const row of rows) io.out(visibleText(formatLine(row)));
    }
    return EXIT_OK;
  } finally {
    store.close();
  }
}

function toView(row: EventRecord) {
  return {
    seq: row.seq,
    time: new Date(row.ts).toISOString(),
    type: row.type,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    projectId: row.projectId ?? null,
    taskId: row.taskId ?? null,
    runId: row.runId ?? null,
    payload: row.payload,
  };
}

// `seq time type aggregate summary`; the summary is the payload as key=value pairs.
function formatLine(row: EventRecord): string {
  const pairs = Object.entries(row.payload).map(
    ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
  const summary = pairs.length === 0 ? "-" : pairs.join(" ");
  return `${row.seq} ${new Date(row.ts).toISOString()} ${row.type} ${row.aggregateType}:${row.aggregateId} ${summary}`;
}
