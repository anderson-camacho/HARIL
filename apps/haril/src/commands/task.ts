import type { AcceptanceCheck } from "@haril/contracts";
import { checkTaskKind, isRealAgent, type Verification, visibleText } from "@haril/core";
import { allValues, argsProblem, lastValue, type ParsedArgs, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { storeAccess } from "../host.js";
import {
  dataDirFor,
  failureReasonText,
  openExisting,
  queueCommand,
  visibleBlock,
  withProject,
} from "./common.js";

// `haril task add` (M1-T4): validates the input and queues task.create. `haril start` applies the queue.
// `haril task show` (M2-T6) prints one task with its result or error and its settled tokens.
// `--kind plan` (LD-T4) asks a planner agent (planner, or fake:plan in the hermetic lane) for a plan: the task writes
// nothing, and the plan it proposes waits for `haril approve`.

const DEFAULT_AGENT = "fake:succeed";
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_TOKENS = 20000; // M2-D5
const MODEL_ENV = "HARIL_DEFAULT_MODEL";
const TASK_ADD_USAGE =
  'usage: haril task add "<title>" [--project <slug>] [--depends-on <taskId>]... [--kind work|plan] [--agent <agentRef>] [--model <id>] [--max-tokens <n>] [--max-attempts <n>] [--timeout-ms <n>] [--accept-file <path>]... [--accept-contains <path>=<text>]... [--accept-output <text>]... [--idempotency-key <key>] [--json] [--data-dir <path>]';
// `haril task add --help` (MC-T2 fix): the usage and what each flag does.
const TASK_ADD_HELP: readonly string[] = [
  TASK_ADD_USAGE,
  "  --project <slug>                 the project; may be left out when only one exists",
  "  --depends-on <taskId>            wait for that task to complete and receive its result (repeatable)",
  "  --kind work|plan                 plan asks a planner agent for a plan, which waits for haril approve",
  `  --agent <agentRef>               the agent (default ${DEFAULT_AGENT}; analyst and planner are real agents)`,
  `  --model <id>                     the model of a real agent (default: ${MODEL_ENV}; see haril models)`,
  `  --max-tokens <n>                 the task's token ceiling (default ${DEFAULT_MAX_TOKENS})`,
  `  --max-attempts <n>               attempts, retries included (default ${DEFAULT_MAX_ATTEMPTS}); at most 2 retries after failed checks`,
  `  --timeout-ms <n>                 the time limit of one attempt (default ${DEFAULT_TIMEOUT_MS})`,
  "  --accept-file <path>             check: the file exists inside the project root (repeatable)",
  "  --accept-contains <path>=<text>  check: the file contains the text (repeatable)",
  "  --accept-output <text>           check: the agent's final answer contains the text (repeatable)",
  "  --idempotency-key <key>          queue the command at most once for this key",
  "  --json                           print the queued command as JSON",
  "  --data-dir <path>                the HARIL data directory",
  "  a failed check fails the attempt; the next attempt is told which checks failed and what was answered",
];
const HELP_FLAGS: readonly string[] = ["--help", "-h"];
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
  if (args.some((arg) => HELP_FLAGS.includes(arg))) {
    for (const line of TASK_ADD_HELP) io.out(line);
    return EXIT_OK;
  }
  const parsed = parseArgs(args, {
    values: [
      "--project",
      "--depends-on",
      "--kind",
      "--agent",
      "--model",
      "--max-tokens",
      "--max-attempts",
      "--timeout-ms",
      "--accept-file",
      "--accept-contains",
      "--accept-output",
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
  const kindFlag = lastValue(parsed, "--kind")?.trim();
  if (kindFlag === "") {
    io.err("haril: --kind needs work or plan");
    return EXIT_USAGE;
  }
  // The store applies the same rule to the queued command (LD-T4).
  const kind = checkTaskKind(kindFlag, agent);
  if (!kind.ok) {
    io.err(`haril: ${kind.reason}`);
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
  const acceptance = acceptanceFromFlags(io, parsed);
  if (acceptance === null) return EXIT_USAGE;
  const explicitKey = lastValue(parsed, "--idempotency-key");
  if (explicitKey !== undefined && explicitKey.trim() === "") {
    io.err("haril: --idempotency-key needs a value");
    return EXIT_USAGE;
  }

  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const idempotencyKey = explicitKey ?? `task-add-${storeAccess(host).ids.next()}`;
  return withProject(io, host, dataDir, lastValue(parsed, "--project"), (store, project) =>
    queueCommand(
      io,
      parsed.flags.has("--json"),
      store,
      {
        type: "task.create",
        projectId: project.projectId,
        args: {
          goal: title,
          dependsOn,
          kind: kind.kind,
          agent,
          maxAttempts,
          timeoutMs,
          model: model ?? null,
          maxTokens,
          acceptance,
        },
        idempotencyKey,
      },
      dataDir,
    ),
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
    const permissionDenials = store.events
      .list({ taskId })
      .filter((event) => event.type === "security.pathguard.denied").length;
    // MC-T2 fix: once a task completed, the newest failed attempt is an earlier one that a later attempt made good, not
    // the task's error: it is kept as history under its own name.
    const completed = detail.state === "completed";
    const view = {
      taskId: detail.taskId,
      goal: detail.goal,
      state: detail.state,
      agent: detail.agentRef,
      model: detail.model,
      maxTokens: detail.maxTokens,
      attempts: { used: detail.attemptsUsed, max: detail.maxAttempts },
      result: detail.result,
      error: completed ? null : detail.error,
      earlierFailure: completed ? detail.error : null,
      failureReason: detail.failureReason,
      verifyRetries: detail.verifyRetries,
      // The host verification of the settled attempt: the result of a completed task, the evidence of a failed one.
      verification: verificationOf(detail.result, completed ? null : detail.error),
      permissionDenials,
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
    // LD-T7c: the goal, the agent, the result and the error may be agent-written, so the text shows them as the terminal
    // draws them; the result and the error keep their line breaks.
    io.out(visibleText(`task ${view.taskId}: ${view.goal}`));
    io.out(visibleText(`state ${view.state}, agent ${view.agent}, model ${view.model ?? "none"}`));
    io.out(`attempts ${view.attempts.used}/${view.attempts.max}, max tokens ${view.maxTokens}`);
    if (view.failureReason !== null) {
      io.out(`failed: ${failureReasonText(view.failureReason, view.verifyRetries)}`);
    }
    io.out(`result: ${visibleBlock(resultText(view.result))}`);
    if (view.error !== null) {
      io.out(visibleBlock(`error: ${view.error.code}: ${view.error.message}`));
    }
    printVerification(io, view.verification);
    // MC-T2: the output the checks of the newest failed attempt rejected; the error message names the checks it failed.
    if (view.error?.output !== undefined) {
      io.out(`rejected output: ${visibleBlock(resultText(view.error.output))}`);
    }
    // A completed task's earlier failure is one line of history; --json keeps all of it under earlierFailure.
    if (view.earlierFailure !== null) {
      const attempt =
        view.earlierFailure.attempt === undefined ? "" : ` ${view.earlierFailure.attempt}`;
      io.out(
        visibleText(
          `earlier attempt${attempt} failed: ${view.earlierFailure.code}: ${view.earlierFailure.message}`,
        ),
      );
    }
    io.out(`permission denials: ${view.permissionDenials}`);
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

// The acceptance checks of `task add` (M3-D7). Each flag repeats; a problem prints and returns null.
function acceptanceFromFlags(io: CliIo, parsed: ParsedArgs): AcceptanceCheck[] | null {
  const checks: AcceptanceCheck[] = [];
  for (const raw of allValues(parsed, "--accept-file")) {
    const path = raw.trim();
    if (path === "") {
      io.err("haril: --accept-file needs a path relative to the project root");
      return null;
    }
    checks.push({ kind: "file_exists", path });
  }
  for (const raw of allValues(parsed, "--accept-contains")) {
    const separator = raw.indexOf("=");
    const path = separator < 0 ? "" : raw.slice(0, separator).trim();
    const text = separator < 0 ? "" : raw.slice(separator + 1);
    if (path === "" || text === "") {
      io.err("haril: --accept-contains needs <path>=<text> with a path and a non-empty text");
      return null;
    }
    checks.push({ kind: "file_contains", path, text });
  }
  for (const text of allValues(parsed, "--accept-output")) {
    if (text.trim() === "") {
      io.err("haril: --accept-output needs a non-empty text");
      return null;
    }
    checks.push({ kind: "output_contains", text });
  }
  return checks;
}

// The verification stored with the settled attempt, read from the result or from the failed attempt's evidence.
function verificationOf(
  result: Readonly<Record<string, unknown>> | null,
  error: { readonly verification?: unknown } | null,
): Verification | null {
  const candidate = result?.verification ?? error?.verification;
  return candidate === undefined || candidate === null ? null : (candidate as Verification);
}

function printVerification(io: CliIo, verification: Verification | null): void {
  if (verification === null) return;
  const state = verification.verified
    ? "verified"
    : verification.checks.length === 0
      ? "unverified (no acceptance checks)"
      : "not verified";
  io.out(`verification: ${state}`);
  for (const check of verification.checks) {
    io.out(visibleText(`  ${check.ok ? "ok" : "failed"} ${check.kind}: ${check.detail}`));
  }
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
