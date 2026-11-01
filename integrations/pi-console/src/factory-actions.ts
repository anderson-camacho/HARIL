import type { CliResult } from "./cli.js";
import type { FactoryAction } from "./factory-state.js";

// What a confirmed key of the factory runs: the same CLI commands as /continue, /approve and /deny, refused in the same
// modes. Their output is the answer the screen shows. Approving and continuing need a runtime to do anything, so as those
// commands do, this makes sure one runs.

export interface FactoryActionDeps {
  run(args: readonly string[]): Promise<CliResult>;
  // A note when it had to start a runtime or could not; undefined when one already ran.
  ensureRuntime(): Promise<string | undefined>;
  // Why the mode refuses the command, if it does.
  refusal(command: "continue" | "approve" | "deny"): string | undefined;
}

function commandOf(action: Exclude<FactoryAction, { kind: "reread" }>): {
  readonly command: "continue" | "approve" | "deny";
  readonly args: readonly string[];
  readonly done: string;
} {
  if (action.kind === "continue") {
    return {
      command: "continue",
      args: [
        "workflow",
        "continue",
        action.workflowId,
        ...(action.projectSlug === null ? [] : ["--project", action.projectSlug]),
      ],
      done: `El flujo ${action.workflowId} continúa.`,
    };
  }
  return {
    command: action.kind,
    args: [action.kind, action.approvalId],
    done: action.kind === "approve" ? "Plan aprobado." : "Plan negado.",
  };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
}

export async function runFactoryAction(
  action: FactoryAction,
  deps: FactoryActionDeps,
): Promise<string> {
  if (action.kind === "reread") {
    const read = await deps.run(["quota", "--json"]);
    return read.ok
      ? "Cuota leída de nuevo."
      : firstLine(read.stderr) || "No se pudo leer la cuota.";
  }
  const { command, args, done } = commandOf(action);
  const refused = deps.refusal(command);
  if (refused !== undefined) return refused;
  const result = await deps.run(args);
  if (!result.ok) return firstLine(result.stderr) || `haril ${args.join(" ")} falló`;
  if (action.kind === "deny") return done;
  const note = await deps.ensureRuntime();
  return note === undefined ? done : `${done} ${note}`;
}
