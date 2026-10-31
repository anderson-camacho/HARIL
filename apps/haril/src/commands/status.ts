import {
  describeMemory,
  type MemoryStatusView,
  TASK_STATES,
  UNRECORDED_MEMORY_STATUS,
  visibleText,
} from "@haril/core";
import type {
  CommandRecord,
  HaltState,
  ProjectRecord,
  RuntimeLeaseSummary,
  Store,
  TaskRecord,
} from "@haril/core/ports";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { readMemoryConfig } from "../tools/configured-memory.js";
import { VERSION } from "../version.js";
import { dataDirFor, leaseHolderAlive, openExisting } from "./common.js";
import { memoryLine } from "./memory.js";

// `haril status` (M1-T4): read-only. A missing database is reported as "not initialized" and never created. It shows
// memory as haril memory status does, from the same store status (MC-T4 fix; MEMORY.md 12.3).

interface QueuedView {
  readonly commandId: string;
  readonly type: string;
  readonly projectId: string | null;
  readonly args: CommandRecord["args"];
  readonly enqueuedAt: number;
}

interface StatusReport {
  readonly initialized: boolean;
  readonly dataDir: string;
  readonly projects: readonly ProjectRecord[];
  readonly tasks: { readonly total: number; readonly byState: Readonly<Record<string, number>> };
  readonly taskList: readonly TaskRecord[];
  readonly queuedCommands: readonly QueuedView[];
  readonly runtime: RuntimeLeaseSummary;
  // An emergency stop's halt (3.14): nothing is claimed until haril resume.
  readonly halted: HaltState;
  readonly memory: MemoryStatusView & { readonly configured?: string | null };
}

const USAGE = "usage: haril status [--project <slug>] [--json] [--data-dir <path>]";

export function status(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--project", "--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = openExisting(host, dataDir);
  try {
    const result =
      store === undefined
        ? { ok: true as const, report: emptyReport(dataDir) }
        : readReport(store, dataDir, lastValue(parsed, "--project"), host);
    if (!result.ok) {
      io.err(`haril: ${result.message}`);
      return EXIT_USAGE;
    }
    if (parsed.flags.has("--json")) io.out(JSON.stringify(result.report));
    else printText(io, result.report);
    return EXIT_OK;
  } finally {
    store?.close();
  }
}

function emptyReport(dataDir: string): StatusReport {
  return {
    initialized: false,
    dataDir,
    projects: [],
    tasks: { total: 0, byState: countByState([]) },
    taskList: [],
    queuedCommands: [],
    runtime: { status: "none" },
    halted: { halted: false, since: null },
    memory: describeMemory(UNRECORDED_MEMORY_STATUS, false),
  };
}

type ReadResult =
  | { readonly ok: true; readonly report: StatusReport }
  | { readonly ok: false; readonly message: string };

function readReport(
  store: Store,
  dataDir: string,
  slug: string | undefined,
  host: HostInfo,
): ReadResult {
  const allProjects = store.projects.list();
  const scope =
    slug === undefined ? undefined : allProjects.find((project) => project.slug === slug);
  if (slug !== undefined && scope === undefined) {
    return { ok: false, message: `no project with slug "${slug}"` };
  }
  const projects = scope === undefined ? allProjects : [scope];
  const projectId = scope?.projectId;

  const taskList = store.tasks.list(projectId === undefined ? {} : { projectId });
  const queuedCommands = store.commands
    .listQueued()
    .filter((command) => projectId === undefined || command.projectId === projectId)
    .map((command) => ({
      commandId: command.commandId,
      type: command.type,
      projectId: command.projectId,
      args: command.args,
      enqueuedAt: command.enqueuedAt,
    }));

  const runtime = store.runtime.leaseSummary();
  return {
    ok: true,
    report: {
      initialized: true,
      dataDir,
      projects,
      tasks: { total: taskList.length, byState: countByState(taskList) },
      taskList,
      queuedCommands,
      runtime,
      halted: store.runtime.haltState(),
      memory: {
        ...describeMemory(store.memory.status(), leaseHolderAlive(runtime, host)),
        // What haril.json sets: the store records the provider in use only once a runtime has run.
        configured: readMemoryConfig(host).provider,
      },
    },
  };
}

function countByState(tasks: readonly TaskRecord[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(TASK_STATES.map((state) => [state, 0]));
  for (const task of tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
  return counts;
}

function printText(io: CliIo, report: StatusReport): void {
  io.out(`haril ${VERSION} status`);
  io.out(`  data      ${report.dataDir}`);
  if (!report.initialized) {
    io.out("  store     not initialized (run haril project init <path> --name <name> --yes)");
  }
  io.out(`  projects  ${report.projects.length}`);
  for (const project of report.projects) {
    io.out(visibleText(`    ${project.slug}  ${project.name}  ${project.rootPath}`));
  }
  const byState = TASK_STATES.map((state) => `${state} ${report.tasks.byState[state] ?? 0}`);
  io.out(`  tasks     ${report.tasks.total} (${byState.join(", ")})`);
  // LD-T7c: a plan task's goal is agent-written, so it is shown as the terminal draws it.
  for (const task of report.taskList) {
    io.out(visibleText(`    ${task.taskId}  ${task.state}  ${task.goal}`));
  }
  io.out(`  queued    ${report.queuedCommands.length}`);
  for (const command of report.queuedCommands) io.out(`    ${command.commandId}  ${command.type}`);
  io.out(`  runtime   ${runtimeText(report.runtime)}`);
  if (report.halted.halted) {
    const since =
      report.halted.since === null ? "" : ` since ${new Date(report.halted.since).toISOString()}`;
    io.out(`  halted    yes${since}: nothing is claimed until haril resume`);
  }
  io.out(visibleText(`  memory    ${memoryLine(report.memory)}`));
}

function runtimeText(runtime: RuntimeLeaseSummary): string {
  if (runtime.status === "none") return "none";
  return `${runtime.status} (instance ${runtime.instanceId}, pid ${runtime.pid})`;
}
