import { homedir } from "node:os";
import { validatePlanSchema } from "@haril/contracts";
import {
  legalTargets,
  type PlanGraphIssue,
  TASK_STATES,
  topologicalOrder,
  validatePlanGraph,
} from "@haril/core";
import { inspectStore, type StoreInspection } from "@haril/state-sqlite";
import { resolveDataDir } from "./data-dir.js";
import { VERSION } from "./version.js";

// Composition root of the CLI. Only this layer touches the host (process, fs); the rules come from core.

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): string;
}

export interface HostInfo {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  // Environment and home directory used to resolve the data directory (M1-D8).
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  // Store inspection; defaults to the real read-only inspection of the data directory.
  readonly inspectStore?: (dataDir: string) => StoreInspection;
}

function currentHost(): HostInfo {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDir: homedir(),
  };
}

const EXIT_OK = 0;
// M1-D2: 0 ok, 1 warnings, 2 errors. plan validate reports an invalid plan with 1 (its own contract).
const EXIT_INVALID = 1;
const EXIT_WARN = 1;
const EXIT_USAGE = 2;
const EXIT_ERROR = 2;

const NODE_REQUIREMENT = "^24.21.0 || >=26.8.0";

const HELP_LINES = [
  "haril - HARIL command line",
  "",
  "usage:",
  "  haril --version | version        print the CLI version",
  "  haril doctor [--json] [--data-dir <path>]   check the runtime and the store",
  "  haril states                     print the task states and legal transitions",
  "  haril plan validate <file> [--json]   validate a plan file",
  "  haril help                       print this help",
];

export function run(argv: readonly string[], io: CliIo, host: HostInfo = currentHost()): number {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
      printHelp(io.err);
      return EXIT_USAGE;
    case "--version":
    case "version":
      io.out(`haril ${VERSION}`);
      return EXIT_OK;
    case "--help":
    case "-h":
    case "help":
      printHelp(io.out);
      return EXIT_OK;
    case "doctor":
      return doctor(rest, io, host);
    case "states":
      return states(rest, io);
    case "plan":
      return plan(rest, io);
    default:
      io.err(`haril: unknown command "${command}"`);
      printHelp(io.err);
      return EXIT_USAGE;
  }
}

function printHelp(write: (line: string) => void): void {
  for (const line of HELP_LINES) write(line);
}

interface SplitArgs {
  readonly positionals: string[];
  readonly json: boolean;
  readonly unknown: string[];
}

function splitArgs(args: readonly string[]): SplitArgs {
  const positionals: string[] = [];
  const unknown: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("-")) unknown.push(arg);
    else positionals.push(arg);
  }
  return { positionals, json, unknown };
}

function reportUnknownOptions(unknown: readonly string[], io: CliIo): number | null {
  if (unknown.length === 0) return null;
  io.err(`haril: unknown option "${unknown[0]}"`);
  return EXIT_USAGE;
}

type Version = readonly [number, number, number];
type NodeStatus = "ok" | "warn" | "error";

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// Equivalent to "^24.21.0 || >=26.8.0": the 24.x line from 24.21.0, or anything from 26.8.0 on.
function satisfiesRequirement(version: Version): boolean {
  const onLine24 = version[0] === 24 && compareVersions(version, [24, 21, 0]) >= 0;
  return onLine24 || compareVersions(version, [26, 8, 0]) >= 0;
}

// Below Node 24 is a hard error (exit 1); a version that does not satisfy the range is only a warning.
function nodeStatus(nodeVersion: string): NodeStatus {
  const version = parseVersion(nodeVersion);
  if (version === null || version[0] < 24) return "error";
  return satisfiesRequirement(version) ? "ok" : "warn";
}

type Status = "ok" | "warn" | "error";

const RANK: Record<Status, number> = { ok: 0, warn: 1, error: 2 };

function worst(...statuses: Status[]): Status {
  return statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "ok" as Status);
}

// Gate statuses from the store share the Node vocabulary: ok, warn, error.
function storeStatus(report: StoreInspection): Status {
  const gates = report.gates.map((gate) => gate.status);
  if (report.error !== undefined || gates.includes("error")) return "error";
  return gates.includes("warn") ? "warn" : "ok";
}

// Doctor is read-only: it describes the store and never creates the directory or the database.
function doctor(args: readonly string[], io: CliIo, host: HostInfo): number {
  const { rest, dataDirFlag, error } = takeDataDirFlag(args);
  if (error !== undefined) {
    io.err(error);
    return EXIT_USAGE;
  }
  const { positionals, json, unknown } = splitArgs(rest);
  const usage = reportUnknownOptions(unknown, io);
  if (usage !== null) return usage;
  if (positionals.length > 0) {
    io.err("usage: haril doctor [--json] [--data-dir <path>]");
    return EXIT_USAGE;
  }

  const { dataDir } = resolveDataDir({
    flag: dataDirFlag,
    env: host.env ?? {},
    platform: host.platform,
    homeDir: host.homeDir ?? "",
  });
  const inspect =
    host.inspectStore ??
    ((path: string) => inspectStore({ dataDir: path, runtime: { nodeVersion: host.nodeVersion } }));
  const store = inspect(dataDir);

  const node = nodeStatus(host.nodeVersion);
  const overall = worst(node, storeStatus(store));
  if (json) {
    io.out(
      JSON.stringify({
        status: overall,
        node: { version: host.nodeVersion, required: NODE_REQUIREMENT, status: node },
        platform: host.platform,
        arch: host.arch,
        store: {
          status: storeStatus(store),
          dataDir: store.dataDir,
          dbPath: store.dbPath,
          initialized: store.initialized,
          sqliteVersion: store.sqliteVersion,
          schemaVersion: store.schemaVersion,
          gates: store.gates,
          ...(store.error === undefined ? {} : { error: store.error }),
        },
      }),
    );
  } else {
    io.out(`haril ${VERSION} doctor`);
    io.out(`  node      ${host.nodeVersion}  ${node}  requires ${NODE_REQUIREMENT}`);
    io.out(`  platform  ${host.platform}`);
    io.out(`  arch      ${host.arch}`);
    io.out(`  store     ${storeStatus(store)}  ${store.dataDir}`);
    io.out(`    database  ${storeDatabaseLine(store)}`);
    io.out(`    sqlite    ${store.sqliteVersion}`);
    for (const gate of store.gates) io.out(`    gate ${gate.name}  ${gate.status}  ${gate.detail}`);
    if (store.error !== undefined) io.out(`    error     ${store.error}`);
    io.out(`  status    ${overall}`);
  }
  if (overall === "error") return EXIT_ERROR;
  return overall === "warn" ? EXIT_WARN : EXIT_OK;
}

function storeDatabaseLine(store: StoreInspection): string {
  if (!store.initialized)
    return `${store.dbPath} (not initialized; the first write command creates it)`;
  return `${store.dbPath} (schema ${store.schemaVersion ?? "unknown"})`;
}

// Extracts "--data-dir <path>" or "--data-dir=<path>" before the generic option parsing.
function takeDataDirFlag(args: readonly string[]): {
  rest: string[];
  dataDirFlag?: string;
  error?: string;
} {
  const rest: string[] = [];
  let dataDirFlag: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "--data-dir") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { rest, error: "haril: --data-dir needs a path" };
      }
      dataDirFlag = value;
      index++;
    } else if (arg.startsWith("--data-dir=")) {
      dataDirFlag = arg.slice("--data-dir=".length);
    } else {
      rest.push(arg);
    }
  }
  return { rest, dataDirFlag };
}

function states(args: readonly string[], io: CliIo): number {
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

function plan(args: readonly string[], io: CliIo): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "validate") return planValidate(rest, io);
  if (subcommand === undefined) io.err("haril: plan needs a subcommand");
  else io.err(`haril: unknown plan subcommand "${subcommand}"`);
  io.err("usage: haril plan validate <file> [--json]");
  return EXIT_USAGE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function planValidate(args: readonly string[], io: CliIo): number {
  const { positionals, json, unknown } = splitArgs(args);
  const usage = reportUnknownOptions(unknown, io);
  if (usage !== null) return usage;
  const [file, ...extra] = positionals;
  if (file === undefined || extra.length > 0) {
    io.err("usage: haril plan validate <file> [--json]");
    return EXIT_USAGE;
  }

  let text: string;
  try {
    text = io.readFile(file);
  } catch (error) {
    io.err(`haril: cannot read ${file}: ${errorMessage(error)}`);
    return EXIT_USAGE;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    io.err(`haril: ${file} is not valid JSON: ${errorMessage(error)}`);
    return EXIT_USAGE;
  }

  const schema = validatePlanSchema(value);
  if (!schema.ok) {
    return reportPlan(io, json, { ok: false, errors: schema.errors, issues: [] });
  }

  const issues = validatePlanGraph(schema.plan);
  const order = topologicalOrder(schema.plan);
  if (issues.length > 0 || order === null) {
    return reportPlan(io, json, { ok: false, errors: [], issues });
  }
  return reportPlan(io, json, { ok: true, taskCount: schema.plan.tasks.length, order });
}

type PlanReport =
  | { readonly ok: true; readonly taskCount: number; readonly order: readonly string[] }
  | {
      readonly ok: false;
      readonly errors: readonly string[];
      readonly issues: readonly PlanGraphIssue[];
    };

function reportPlan(io: CliIo, json: boolean, report: PlanReport): number {
  if (json) {
    io.out(JSON.stringify(report));
  } else if (report.ok) {
    io.out(`OK: ${report.taskCount} tasks`);
    io.out(`order: ${report.order.join(", ")}`);
  } else {
    const problems = report.errors.length + report.issues.length;
    io.out(`INVALID: ${problems} problem${problems === 1 ? "" : "s"}`);
    for (const error of report.errors) io.out(`  ${error}`);
    for (const issue of report.issues) io.out(`  [${issue.code}] ${issue.message}`);
  }
  return report.ok ? EXIT_OK : EXIT_INVALID;
}
