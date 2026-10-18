import type { CliResult } from "./cli.js";

// ■ STOP ALL (docs/modos-y-delegacion.md 3.14.6, P20), visible in every mode with a shortcut and no confirmation, as an
// emergency control should be. It does two things, in this order: it aborts the chat turn (ctx.abort), so the model in
// the console stops at once, and it runs `haril stop --now`, the CLI's emergency stop of every agent in every mode
// (workflows stopped, turns cancelled, agent process trees killed from their recorded pid and start time, the runtime
// halted until haril resume). The console never kills a process itself: the CLI does it, also when the runtime does
// not answer. This reads the CLI's JSON report and says plainly what happened, including when the runtime did not
// answer or the CLI failed. It never throws.

// haril stop --now waits up to 5 s for the runtime, then checks and kills the recorded processes itself.
export const STOP_ALL_TIMEOUT_MS = 20_000;

export interface StopAllDeps {
  abort(): void;
  cliAvailable(): boolean;
  run(args: readonly string[], options: { readonly timeoutMs?: number }): Promise<CliResult>;
}

export interface StopAllOutcome {
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

interface StopReport {
  readonly runtime: "stopped" | "unresponsive" | "none";
  readonly commandId: string | null;
  readonly queued: boolean;
  readonly halted: boolean;
  readonly cancelledTasks: number;
  readonly stoppedWorkflows: number;
  readonly processes: { readonly killed: number; readonly alive: number };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// The last JSON line the CLI printed, when it is a stop report.
function parseReport(stdout: string): StopReport | undefined {
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.runtime !== "stopped" && raw.runtime !== "unresponsive" && raw.runtime !== "none")
    return undefined;
  const processes = (raw.processes ?? {}) as Record<string, unknown>;
  return {
    runtime: raw.runtime,
    commandId: typeof raw.commandId === "string" ? raw.commandId : null,
    queued: raw.queued === true,
    halted: raw.halted === true,
    cancelledTasks: number(raw.cancelledTasks),
    stoppedWorkflows: number(raw.stoppedWorkflows),
    processes: { killed: number(processes.killed), alive: number(processes.alive) },
  };
}

function describe(report: StopReport, chat: string): StopAllOutcome {
  const halted = report.halted || report.queued ? " · nothing runs until haril resume" : "";
  const killed = report.processes.killed > 0 ? `, ${report.processes.killed} killed` : "";
  if (report.processes.alive > 0) {
    return {
      level: "error",
      message: `STOP ALL: ${chat} · ${plural(report.processes.alive, "agent process still alive", "agent processes still alive")} after the kill: check the task manager${halted}`,
    };
  }
  switch (report.runtime) {
    case "stopped":
      return {
        level: "info",
        message: `STOP ALL: ${chat} · runtime stopped: ${plural(report.cancelledTasks, "task", "tasks")} cancelled, ${plural(report.stoppedWorkflows, "workflow", "workflows")} stopped · no agent process left alive${killed}${halted}`,
      };
    case "unresponsive":
      return {
        level: "warning",
        message: `STOP ALL: ${chat} · the runtime did not answer in time: the stop stays queued for it, and the agent processes were checked here (none left alive${killed})${halted}`,
      };
    case "none":
      return {
        level: "info",
        message:
          report.commandId !== null || report.queued
            ? `STOP ALL: ${chat} · no runtime was running: the stop is queued, so the next runtime claims nothing${halted}`
            : `STOP ALL: ${chat} · no runtime was running and HARIL was already halted${halted}`,
      };
  }
}

export async function stopAll(deps: StopAllDeps): Promise<StopAllOutcome> {
  let chat = "chat turn aborted";
  try {
    deps.abort();
  } catch {
    chat = "no chat turn to abort";
  }
  if (!deps.cliAvailable()) {
    return {
      level: "warning",
      message: `STOP ALL: ${chat}, but this Pi was not opened by haril: the HARIL runtime is out of reach (run haril stop --now in a terminal)`,
    };
  }
  let result: CliResult;
  try {
    result = await deps.run(["stop", "--now", "--json"], { timeoutMs: STOP_ALL_TIMEOUT_MS });
  } catch (error) {
    return {
      level: "error",
      message: `STOP ALL: ${chat}, but haril stop --now could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const report = parseReport(result.stdout);
  if (report !== undefined) return describe(report, chat);
  if (result.code === null) {
    return {
      level: "error",
      message: `STOP ALL: ${chat}, but the runtime did not answer: haril stop --now gave no answer in ${STOP_ALL_TIMEOUT_MS / 1000} s; run it in a terminal`,
    };
  }
  const first = result.stderr.trim().split(/\r?\n/)[0] || `exit code ${result.code}`;
  return { level: "error", message: `STOP ALL: ${chat}, but haril stop --now failed: ${first}` };
}
