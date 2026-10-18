import { DIFFICULTIES } from "@haril/contracts";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import {
  calibrate,
  type DifficultyFileStat,
  type DifficultyPolicy,
  loadDifficulty,
  type ValueSource,
  writeDifficultyFile,
} from "../difficulty.js";
import { clockFor } from "../host.js";
import { dataDirFor, openExisting } from "./common.js";

// `haril difficulty show | calibrate` (docs/modos-y-delegacion.md 6, 3.11; phase F6). show prints the table in effect:
// per difficulty class its minimum success rate and the recommended models in order with their cost level, and where
// each value comes from (config/difficulty.json or the provisional defaults); then the success rates of the last
// calibration. calibrate is the user's manual trigger (R-Q3): it recomputes the success rates from the model_stats view
// of the store (real executor runs that an auditor judged; simulated ones never count), prints what would change, and
// writes the file only with --yes (--apply, as section 6 writes it, does the same). Nothing else ever writes the table.

const USAGE = [
  "usage: haril difficulty show [--json]",
  "       haril difficulty calibrate [--yes | --apply] [--json] [--data-dir <path>]",
].join("\n");

function fail(io: CliIo, message: string): number {
  io.err(`haril: ${message}`);
  return EXIT_USAGE;
}

function sourceText(source: ValueSource): string {
  return source === "file" ? "file" : "default (provisional)";
}

function costOf(policy: DifficultyPolicy, entry: string): number | undefined {
  return policy.models.find((model) => model.pattern === entry)?.costTier;
}

function statText(stat: DifficultyFileStat | null): string {
  return stat === null ? "none" : `${stat.successRate} (${stat.samples} judged runs)`;
}

function show(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: [], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) return fail(io, USAGE);
  const loaded = loadDifficulty(host);
  if (!loaded.ok) {
    for (const error of loaded.errors) io.err(`haril: ${loaded.path}: ${error}`);
    return EXIT_USAGE;
  }
  const { policy } = loaded;
  if (parsed.flags.has("--json")) {
    io.out(
      JSON.stringify({
        path: loaded.path,
        file: loaded.exists,
        classes: policy.classes,
        models: policy.models,
        stats: policy.stats,
        calibratedAt: policy.calibratedAt,
      }),
    );
    return EXIT_OK;
  }
  io.out(`difficulty table  ${loaded.path}${loaded.exists ? "" : " (no file: built-in defaults)"}`);
  io.out(
    "class    min success  source (min / models)                       recommended models, cheapest level first",
  );
  for (const name of DIFFICULTIES) {
    const rule = policy.classes[name];
    const models = rule.order
      .map((entry) => {
        const cost = costOf(policy, entry);
        return cost === undefined ? entry : `${entry} (cost ${cost})`;
      })
      .join(", ");
    const sources = `${sourceText(rule.source.minSuccessRate)} / ${sourceText(rule.source.order)}`;
    io.out(
      `${name.padEnd(8)} ${rule.minSuccessRate.toFixed(2).padEnd(12)} ${sources.padEnd(43)} ${models || "(every model, by cost)"}`,
    );
  }
  io.out(
    `cost levels  ${policy.models.map((model) => `${model.pattern}=${model.costTier}`).join(", ") || "none"} (${sourceText(policy.models[0]?.source ?? "default")})`,
  );
  io.out(`calibrated  ${policy.calibratedAt ?? "never"}`);
  const rows = Object.entries(policy.stats).flatMap(([model, byClass]) =>
    DIFFICULTIES.flatMap((name) => {
      const stat = byClass[name];
      return stat === undefined ? [] : [`  ${model}  ${name}  ${statText(stat)}`];
    }),
  );
  for (const row of rows) io.out(row);
  return EXIT_OK;
}

function recalibrate(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--json", "--yes", "--apply"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) return fail(io, USAGE);
  const loaded = loadDifficulty(host);
  if (!loaded.ok) {
    for (const error of loaded.errors) io.err(`haril: ${loaded.path}: ${error}`);
    return EXIT_USAGE;
  }
  const store = openExisting(host, dataDirFor(host, lastValue(parsed, "--data-dir")));
  if (store === undefined) {
    return fail(
      io,
      "store not initialized (run haril project init <path> --name <name> --yes first)",
    );
  }
  let rows: ReturnType<typeof store.usageLog.modelStats>;
  try {
    rows = store.usageLog.modelStats();
  } finally {
    store.close();
  }
  const result = calibrate(loaded.file, rows, clockFor(host).now());
  const apply = parsed.flags.has("--yes") || parsed.flags.has("--apply");
  const written = apply && result.changes.length > 0;
  if (written) writeDifficultyFile(loaded.path, result.file);
  if (parsed.flags.has("--json")) {
    io.out(
      JSON.stringify({
        path: loaded.path,
        written,
        changes: result.changes,
        runs: rows.map((row) => ({ ...row })),
      }),
    );
    return EXIT_OK;
  }
  io.out(
    `difficulty calibrate  from model_stats: ${rows.length} model and class groups of real executor runs`,
  );
  if (result.changes.length === 0) {
    io.out("no change: the table already holds these success rates");
    return EXIT_OK;
  }
  for (const change of result.changes) {
    io.out(
      `  ${change.model}  ${change.difficulty}  ${statText(change.before)} -> ${statText(change.after)}`,
    );
  }
  io.out(
    written
      ? `written to ${loaded.path}`
      : `not written: run haril difficulty calibrate --yes to write ${loaded.path}`,
  );
  return EXIT_OK;
}

export function difficulty(args: readonly string[], io: CliIo, host: HostInfo): number {
  const [sub, ...rest] = args;
  if (sub === "show") return show(rest, io, host);
  if (sub === "calibrate") return recalibrate(rest, io, host);
  io.err(USAGE);
  return EXIT_USAGE;
}
