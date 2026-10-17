import { type Plan, validatePlanSchema } from "@haril/contracts";
import { type PlanGraphIssue, topologicalOrder, validatePlanGraph } from "@haril/core";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_INVALID, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { planSubmitKey } from "../plan-submit.js";
import { dataDirFor, queueCommand, withProject } from "./common.js";

// `haril plan validate` (M1 plan contract) and `haril plan import` (M1-T4: validate, then queue plan.submit).

export function plan(args: readonly string[], io: CliIo, host: HostInfo): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "validate") return planValidate(rest, io);
  if (subcommand === "import") return planImport(rest, io, host);
  if (subcommand === "propose") return planPropose(rest, io, host);
  if (subcommand === undefined) io.err("haril: plan needs a subcommand");
  else io.err(`haril: unknown plan subcommand "${subcommand}"`);
  io.err(
    "usage: haril plan validate <file> [--json] | haril plan import <file> [--project <slug>] [--json] | haril plan propose <file> [--project <slug>] [--json]",
  );
  return EXIT_USAGE;
}

function planValidate(args: readonly string[], io: CliIo): number {
  const parsed = parseArgs(args, { values: [], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [file, ...extra] = parsed.positionals;
  if (file === undefined || extra.length > 0) {
    io.err("usage: haril plan validate <file> [--json]");
    return EXIT_USAGE;
  }
  const json = parsed.flags.has("--json");
  const checked = checkPlanFile(io, file, json);
  if (typeof checked === "number") return checked;
  return reportPlan(io, json, {
    ok: true,
    taskCount: checked.plan.tasks.length,
    order: checked.order,
  });
}

function planImport(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--project", "--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [file, ...extra] = parsed.positionals;
  if (file === undefined || extra.length > 0) {
    io.err("usage: haril plan import <file> [--project <slug>] [--json]");
    return EXIT_USAGE;
  }
  const json = parsed.flags.has("--json");
  const checked = checkPlanFile(io, file, json);
  if (typeof checked === "number") return checked;

  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  // Idempotency key = sha256(projectId + canonical JSON of the plan) (M1-T5): re-importing the same plan
  // is reported as already queued and does not add a command.
  return withProject(io, host, dataDir, lastValue(parsed, "--project"), (store, project) =>
    queueCommand(
      io,
      json,
      store,
      {
        type: "plan.submit",
        projectId: project.projectId,
        args: { plan: checked.plan },
        idempotencyKey: planSubmitKey(project.projectId, checked.plan),
      },
      dataDir,
    ),
  );
}

// `haril plan propose` (LD-T3): a plan file becomes a requested approval. Nothing is queued until a person grants it.
function planPropose(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--project", "--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [file, ...extra] = parsed.positionals;
  if (file === undefined || extra.length > 0) {
    io.err("usage: haril plan propose <file> [--project <slug>] [--json]");
    return EXIT_USAGE;
  }
  const json = parsed.flags.has("--json");
  const checked = checkPlanFile(io, file, json);
  if (typeof checked === "number") return checked;

  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  return withProject(io, host, dataDir, lastValue(parsed, "--project"), (store, project) => {
    const proposed = store.approvals.proposePlan({
      projectId: project.projectId,
      plan: checked.plan,
      requestedBy: "cli",
    });
    if (!proposed.ok) {
      io.err(`haril: ${proposed.error.message}`);
      return EXIT_INVALID;
    }
    const { approval, created } = proposed.value;
    const tasks = checked.plan.tasks.length;
    if (json) {
      io.out(
        JSON.stringify({
          approvalId: approval.approvalId,
          projectSlug: project.slug,
          kind: approval.kind,
          status: approval.status,
          tasks,
          created,
        }),
      );
    } else {
      const note = created ? "" : " (already requested)";
      io.out(`approval ${approval.approvalId}: pending, ${tasks} tasks in ${project.slug}${note}`);
      io.out(
        `decide with: haril approve ${approval.approvalId}   or   haril deny ${approval.approvalId}`,
      );
    }
    return EXIT_OK;
  });
}

interface CheckedPlan {
  readonly plan: Plan;
  readonly order: readonly string[];
}

// Reads, parses and checks a plan file. Problems are printed here; the returned number is the exit code.
function checkPlanFile(io: CliIo, file: string, json: boolean): CheckedPlan | number {
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
  return { plan: schema.plan, order };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
