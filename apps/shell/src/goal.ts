import { Input, type SelectItem, SelectList, type SelectListTheme } from "@earendil-works/pi-tui";
import type { AddTaskArgs, AddTaskTarget } from "./add-task.js";
import { visibleText } from "./format.js";

// The goal form of the shell (LD-T5): the objective, the planner agent and its model. It mirrors the add-task form:
// pi-tui's Input and SelectList keep the editing and the selection, and the app routes Tab, Enter and Esc itself.
// goalArgs turns the values into `haril task add --kind plan`, so the CLI's validation and defaults still decide what
// is queued. The plan the planner writes waits for haril approve (LD-T4).

const PLANNER_REFS: readonly string[] = ["planner", "fake:plan"];
const PLANNER = "planner";
const SIMULATED = "fake:plan";
const FIELDS = ["goal", "agent", "model"] as const;

type GoalField = (typeof FIELDS)[number];

export interface GoalValues {
  readonly goal: string;
  readonly agent: string;
  readonly model: string;
}

// A goal with the form's defaults: with a default model, planner and that model; without one, the simulated planner.
// The input box sends its goal with these (LD-T6b-2), so Enter there queues what g and Enter would.
export function goalDefaults(goal: string, defaultModel: string | undefined): GoalValues {
  const model = defaultModel?.trim() ?? "";
  return { goal, agent: model === "" ? SIMULATED : PLANNER, model };
}

// The argv of a plan task. Only planner takes a model; the simulated planner never does. The goal goes as the form
// and the input box show it, and so does the model (format.ts visibleText): a control or invisible character a paste
// brought is sent as "?".
export function goalArgs(values: GoalValues, target: AddTaskTarget): AddTaskArgs {
  const goal = visibleText(values.goal).trim();
  if (goal === "") return { ok: false, message: "goal is required" };
  const model = visibleText(values.model).trim();
  if (values.agent === PLANNER && model === "") {
    return { ok: false, message: "planner needs a model: type one in the model field" };
  }
  const args = ["task", "add", goal, "--project", target.slug, "--kind", "plan"];
  args.push("--agent", values.agent);
  if (values.agent === PLANNER) args.push("--model", model);
  if (target.dataDir !== undefined) args.push("--data-dir", target.dataDir);
  return { ok: true, args };
}

// The labels are plain text: the app colors the lines.
const PLAIN_THEME: SelectListTheme = {
  selectedPrefix: (text) => text,
  selectedText: (text) => text,
  description: (text) => text,
  scrollInfo: (text) => text,
  noMatch: (text) => text,
};

interface GoalFormOptions {
  readonly projectSlug: string;
  // HARIL_DEFAULT_MODEL as the shell received it. Prefills the model; with one, planner is the default agent.
  readonly defaultModel: string | undefined;
}

export class GoalForm {
  readonly projectSlug: string;
  private readonly goalInput = new Input();
  private readonly modelInput = new Input();
  private readonly agentList: SelectList;
  private focused: GoalField = "goal";

  constructor(options: GoalFormOptions) {
    this.projectSlug = options.projectSlug;
    const defaults = goalDefaults("", options.defaultModel);
    const items: SelectItem[] = PLANNER_REFS.map((ref) => ({ value: ref, label: ref }));
    this.agentList = new SelectList(items, items.length, PLAIN_THEME);
    this.agentList.setSelectedIndex(Math.max(0, PLANNER_REFS.indexOf(defaults.agent)));
    this.modelInput.setValue(defaults.model);
  }

  get field(): GoalField {
    return this.focused;
  }

  next(): void {
    this.focused = FIELDS[(FIELDS.indexOf(this.focused) + 1) % FIELDS.length] ?? "goal";
  }

  previous(): void {
    this.focused =
      FIELDS[(FIELDS.indexOf(this.focused) + FIELDS.length - 1) % FIELDS.length] ?? "goal";
  }

  // A key for the focused field: text editing for the goal and the model, up and down for the agent.
  handleInput(data: string): void {
    if (this.focused === "goal") this.goalInput.handleInput(data);
    else if (this.focused === "model") this.modelInput.handleInput(data);
    else this.agentList.handleInput(data);
  }

  values(): GoalValues {
    return {
      goal: this.goalInput.getValue(),
      agent: this.selectedAgent(),
      model: this.modelInput.getValue(),
    };
  }

  // The form as plain lines: the focused field has a marker and a cursor at the end of its text.
  lines(): string[] {
    const marker = (field: GoalField): string => (this.focused === field ? "> " : "  ");
    const cursor = (field: GoalField): string => (this.focused === field ? "_" : "");
    const agent = this.selectedAgent();
    const agents = PLANNER_REFS.map((ref) => (ref === agent ? `[${ref}]` : ref)).join("  ");
    return [
      `Plan a goal for project ${this.projectSlug}`,
      `${marker("goal")}goal    ${visibleText(this.goalInput.getValue())}${cursor("goal")}`,
      `${marker("agent")}agent   ${agents}`,
      `${marker("model")}model   ${visibleText(this.modelInput.getValue())}${cursor("model")}${agent === PLANNER ? "" : "  (planner only)"}`,
    ];
  }

  private selectedAgent(): string {
    return this.agentList.getSelectedItem()?.value ?? SIMULATED;
  }
}
