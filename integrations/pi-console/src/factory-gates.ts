import type { BodyLine } from "./factory-board.js";
import { type FactoryGlyphs, type FactoryToken, factoryCell } from "./factory-kit.js";
import type { FactoryState } from "./factory-state.js";
import type { FactoryModel, FactoryTask, FactoryWorkflow } from "./factory-types.js";

// The Avance tab's gates (canary-rollout): a workflow moves through its steps while code checks each gate. Each mark comes
// from stored facts; a step with nothing to judge yet is `·`, never a ✓.

type StepState = "passed" | "current" | "failed" | "waiting";

interface Step {
  readonly label: string;
  readonly state: StepState;
}

const STEP_MARK: Readonly<Record<StepState, string>> = {
  passed: "✓",
  current: "▶",
  failed: "✗",
  waiting: "·",
};
const STEP_TOKEN: Readonly<Record<StepState, FactoryToken>> = {
  passed: "green",
  current: "yellow",
  failed: "red",
  waiting: "dim",
};

function chosenWorkflow(model: FactoryModel): FactoryWorkflow | undefined {
  return (
    model.workflows.find((row) => row.state === "running") ??
    model.workflows.find((row) => row.state === "awaiting_human") ??
    model.workflows[0]
  );
}

function ofRoles(tasks: readonly FactoryTask[], roles: readonly string[]): readonly FactoryTask[] {
  return tasks.filter((task) => roles.includes(task.role));
}

function stepOf(rows: readonly FactoryTask[], earlierDone: boolean): StepState {
  if (rows.length === 0) return earlierDone ? "passed" : "waiting";
  if (rows.some((task) => task.column === "errores")) return "failed";
  if (rows.every((task) => task.column === "hechas")) return "passed";
  return earlierDone ? "current" : "waiting";
}

function stepsOf(workflow: FactoryWorkflow, tasks: readonly FactoryTask[]): Step[] {
  const executors = tasks.filter(
    (task) =>
      task.delegatedBy !== null &&
      !["product-owner", "git", "tester", "arquitecto", "orchestrator", "delegator"].includes(
        task.role,
      ),
  );
  const steps: Step[] = [];
  let earlier = tasks.length > 1;
  steps.push({ label: "Plan", state: earlier ? "passed" : "current" });
  for (const [label, rows] of [
    ["Trabajo", executors],
    ["Pruebas", ofRoles(tasks, ["tester"])],
    ["Aceptación", ofRoles(tasks, ["product-owner"])],
    ["Publicar", ofRoles(tasks, ["git"])],
  ] as const) {
    const state = stepOf(rows, earlier);
    steps.push({ label, state });
    earlier = earlier && state === "passed";
  }
  return workflow.state === "completed"
    ? steps.map((step) => ({ ...step, state: step.state === "failed" ? "failed" : "passed" }))
    : steps;
}

function ladder(steps: readonly Step[], width: number, g: FactoryGlyphs): BodyLine {
  const labels = steps.reduce((sum, step) => sum + step.label.length + 2, 0);
  const link = Math.max(1, Math.floor((width - 2 - labels) / Math.max(1, steps.length - 1)) - 2);
  return steps.flatMap((step, index): BodyLine => {
    const passed = step.state === "passed";
    return [
      { text: index === 0 ? " " : "", token: "dim" },
      { text: `${STEP_MARK[step.state]} ${step.label}`, token: STEP_TOKEN[step.state] },
      ...(index === steps.length - 1
        ? []
        : [
            { text: " ", token: "dim" as const },
            {
              text: (passed ? g.heavy : g.h).repeat(link),
              token: passed ? ("green" as const) : ("line" as const),
            },
            { text: " ", token: "dim" as const },
          ]),
    ];
  });
}

export function gatesBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const workflow = chosenWorkflow(model);
  if (workflow === undefined) return [[factoryCell("  Sin flujos todavía.", width, "muted")]];
  const tasks = model.tasks.filter((task) => task.workflowId === workflow.id);
  const steps = stepsOf(workflow, tasks);
  const failed = steps.some((step) => step.state === "failed") || workflow.state === "failed";
  const current = steps.findIndex((step) => step.state === "current");
  const status: { text: string; token: FactoryToken } = failed
    ? { text: `✗ ${workflow.explanation.what}`, token: "red" }
    : workflow.state === "completed"
      ? { text: "✓ Completado", token: "green" }
      : workflow.state === "awaiting_human"
        ? { text: `${g.dot} Te espera`, token: "yellow" }
        : { text: `${g.dot} Paso ${Math.max(0, current) + 1} de ${steps.length}`, token: "yellow" };
  const ratio = workflow.totalTasks === 0 ? 0 : workflow.closedTasks / workflow.totalTasks;
  const barWidth = Math.max(0, width - 2);
  const filled = Math.round(ratio * barWidth);
  const errors = tasks.filter((task) => task.column === "errores").length;
  const requests = model.humanRequests.filter((row) => row.workflowId === workflow.id).length;
  const criteria = workflow.criteria;
  const gates: readonly (readonly [string, boolean | null])[] = [
    ["sin errores", errors === 0],
    ["criterios", criteria === null ? null : criteria.passed === criteria.total],
    ["sin peticiones", requests === 0],
    [
      "presupuesto",
      workflow.tokensBudget === null ? null : workflow.tokensUsed <= workflow.tokensBudget,
    ],
  ];
  const gateLine: BodyLine = [
    { text: " compuertas  ", token: "muted" },
    ...gates.flatMap(
      ([name, ok]): BodyLine => [
        {
          text: ok === null ? "· " : ok ? "✓ " : "✗ ",
          token: ok === null ? "dim" : ok ? "green" : "red",
        },
        { text: `${name}   `, token: ok === null ? "dim" : ok ? "text" : "red" },
      ],
    ),
  ];
  const lines: BodyLine[] = [
    [
      factoryCell(` ${workflow.goal}`, Math.max(0, width - status.text.length - 1), "orange"),
      { text: `${status.text} `, token: status.token },
    ],
    [],
    [{ text: " avance", token: "muted" }],
    [
      { text: " ", token: "dim" },
      { text: g.barOn.repeat(filled), token: failed ? "red" : "orange" },
      { text: g.barOff.repeat(Math.max(0, barWidth - filled)), token: "blue" },
    ],
    [
      factoryCell(
        ` ${workflow.closedTasks} de ${workflow.totalTasks} tareas cerradas`,
        Math.max(0, width - 1),
        "muted",
      ),
    ],
    [],
    ladder(steps, width, g),
    [],
    gateLine,
    [],
    [factoryCell(` ${workflow.explanation.why}`, width, failed ? "red" : "muted")],
  ];
  return lines.slice(0, Math.max(0, height));
}
