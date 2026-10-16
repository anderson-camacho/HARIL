import { isRealAgent } from "@haril/core";
import { allValues, argsProblem, lastValue, type ParsedArgs, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { storeAccess } from "../host.js";
import { dataDirFor, openExisting, queueCommand, withProject } from "./common.js";

// `haril task add` (M1-T4): validates the input and queues task.create. `haril start` applies the queue.
// `haril task show` (M2-T6) prints one task with its result or error and its settled tokens.

const DEFAULT_AGENT = "fake:succeed";
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_TOKENS = 20000; // M2-D5
const MODEL_ENV = "HARIL_DEFAULT_MODEL";
const TASK_ADD_USAGE =
  'usage: haril task add "<title>" [--project <slug>] [--depends-on <taskId>]... [--agent <agentRef>] [--model <id>] [--max-tokens <n>] [--max-attempts <n>] [--timeout-ms <n>] [--idempotency-key <key>] [--json] [--data-dir <path>]';
const TASK_SHOW_USAGE = "usage: haril task show <taskId> [--json] [--data-dir <path>]";
const NOT_INITIALIZED =
  "store not initialized (run haril project init <path> --name <name> --yes first)";

export function task(args: readonly string[], io: CliIo, host: HostInfo): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") return taskAdd(rest, io, host);
  if (subcommand === "show") return taskShow(rest, io, host);
  if (subcommand === undefined) io.err("haril: task needs a subcommand");
  else io.err(`haril: unknown task subcommand "${subcommand}"`);
  io.err("usage: haril task add ... | haril task show ...");
  return EXIT_USAGE;
}

function taskAdd(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: [
      "--project",
      "--depends-on",
      "--agent",
      "--model",
      "--max-tokens",
      "--max-attempts",
      "--timeout-ms",
      "--idempotency-key",
      "--data-dir",
    ],
    flags: ["--json"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [titleArg, ...extra] = parsed.positionals;
  if (titleArg === undefined || extra.length > 0) {
    io.err(TASK_ADD_USAGE);
    return EXIT_USAGE;
  }

  const title = titleArg.trim();
  if (title === "") {
    io.err("haril: task title must not be empty");
    return EXIT_USAGE;
  }
  const dependsOn = allValues(parsed, "--depends-on").map((id) => id.trim());
  if (dependsOn.some((id) => id === "")) {
    io.err("haril: --depends-on needs a task id");
    return EXIT_USAGE;
  }
  const agent = (lastValue(parsed, "--agent") ?? DEFAULT_AGENT).trim();
  if (agent === "") {
    io.err("haril: --agent needs an agent reference");
    return EXIT_USAGE;
  }
  // A real agent needs a model (M2-T6): --model, or HARIL_DEFAULT_MODEL; the simulated agents keep none.
  const modelFlag = lastValue(parsed, "--model");
  if (modelFlag !== undefined && modelFlag.trim() === "") {
    io.err("haril: --model needs a model id");
    return EXIT_USAGE;
  }
  const model = modelFlag?.trim() ?? nonEmpty(host.env?.[MODEL_ENV]);
  if (isRealAgent(agent) && model === undefined) {
    io.err(
      `haril: agent ${agent} needs a model: pass --model <id> (see haril models) or set ${MODEL_ENV}`,
    );
    return EXIT_USAGE;
  }
  const maxAttempts = intOption(io, parsed, "--max-attempts", DEFAULT_MAX_ATTEMPTS);
  const timeoutMs = intOption(io, parsed, "--timeout-ms", DEFAULT_TIMEOUT_MS);
  const maxTokens = intOption(io, parsed, "--max-tokens", DEFAULT_MAX_TOKENS);
  if (maxAttempts === null || timeoutMs === null || maxTokens === null) return EXIT_USAGE;
  const explicitKey = lastValue(parsed, "--idempotency-key");
  if (explicitKey !== undefined && explicitKey.trim() === "") {
    io.err("haril: --idempotency-key needs a value");
    return EXIT_USAGE;
  }

  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const idempotencyKey = explicitKey ?? `task-add-${storeAccess(host).ids.next()}`;
  return withProject(io, host, dataDir, lastValue(parsed, "--project"), (store, project) =>
    queueCommand(io, parsed.flags.has("--json"), store, {
      type: "task.create",
      projectId: project.projectId,
      args: {
        goal: title,
        dependsOn,
        agent,
        maxAttempts,
        timeoutMs,
        model: model ?? null,
        maxTokens,
      },
      idempotencyKey,
    }),
  );
}

// `haril task show <taskId>` (M2-T6): read-only. Tokens are the task's settled ledger entries; null when none.
function taskShow(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [taskId, ...extra] = parsed.positionals;
  if (taskId === undefined || extra.length > 0) {
    io.err(TASK_SHOW_USAGE);
    return EXIT_USAGE;
  }

  const store = openExisting(host, dataDirFor(host, lastValue(parsed, "--data-dir")));
  if (store === undefined) {
    io.err(`haril: ${NOT_INITIALIZED}`);
    return EXIT_USAGE;
  }
  try {
    const detail = store.tasks.get(taskId);
    if (detail === undefined) {
      io.err(`haril: no task with id "${taskId}"`);
      return EXIT_USAGE;
    }
    const usage = store.budgets.usageSummary({ taskId });
    const view = {
      taskId: detail.taskId,
      goal: detail.goal,
      state: detail.state,
      agent: detail.agentRef,
      model: detail.model,
      maxTokens: detail.maxTokens,
      attempts: { used: detail.attemptsUsed, max: detail.maxAttempts },
      result: detail.result,
      error: detail.error,
      tokens:
        usage === null
          ? null
          : {
              input: usage.inputTokens,
              output: usage.outputTokens,
              unreconciled: usage.unreconciled,
            },
    };
    if (parsed.flags.has("--json")) {
      io.out(JSON.stringify(view));
      return EXIT_OK;
    }
    io.out(`task ${view.taskId}: ${view.goal}`);
    io.out(`state ${view.state}, agent ${view.agent}, model ${view.model ?? "none"}`);
    io.out(`attempts ${view.attempts.used}/${view.attempts.max}, max tokens ${view.maxTokens}`);
    io.out(`result: ${resultText(view.result)}`);
    if (view.error !== null) io.out(`error: ${view.error.code}: ${view.error.message}`);
    io.out(
      view.tokens === null
        ? "tokens: none settled"
        : `tokens: input ${view.tokens.input}, output ${view.tokens.output}, unreconciled ${view.tokens.unreconciled}`,
    );
    return EXIT_OK;
  } finally {
    store.close();
  }
}

// The reply of a real run, or the summary of a simulated one; "none" when the task has no result yet.
function resultText(result: Readonly<Record<string, unknown>> | null): string {
  if (result === null) return "none";
  if (typeof result.text === "string") return result.text;
  if (typeof result.summary === "string") return result.summary;
  if (result.simulated === true) return "simulated (no real agent)";
  return JSON.stringify(result);
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// An integer option of at least 1; prints the problem and returns null when it is not one.
function intOption(io: CliIo, parsed: ParsedArgs, flag: string, fallback: number): number | null {
  const raw = lastValue(parsed, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    io.err(`haril: ${flag} must be a whole number of at least 1`);
    return null;
  }
  return value;
}
