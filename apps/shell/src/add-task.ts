import { Input, type SelectItem, SelectList, type SelectListTheme } from "@earendil-works/pi-tui";

// The add-task form of the shell (TUI-D13): title, agent and model. pi-tui's Input and SelectList keep the editing
// and the selection; the app routes Tab, Enter and Esc itself and sends every other key to the focused field.
// addTaskArgs turns the values into the CLI argv, so the CLI's validation and defaults still decide what is queued.

const AGENT_REFS: readonly string[] = ["analyst", "fake:succeed"];
const ANALYST = "analyst";
const SIMULATED = "fake:succeed";
const FIELDS = ["title", "agent", "model"] as const;

export type FormField = (typeof FIELDS)[number];

export interface AddTaskValues {
  readonly title: string;
  readonly agent: string;
  readonly model: string;
}

export interface AddTaskTarget {
  readonly slug: string;
  // The data dir the shell was given, so the task is queued in the same store. Undefined when none is known.
  readonly dataDir: string | undefined;
}

export type AddTaskArgs =
  | { readonly ok: true; readonly args: readonly string[] }
  | { readonly ok: false; readonly message: string };

// The argv of `haril task add`. Only analyst takes a model; the simulated agent never does.
export function addTaskArgs(values: AddTaskValues, target: AddTaskTarget): AddTaskArgs {
  const title = values.title.trim();
  if (title === "") return { ok: false, message: "title is required" };
  const model = values.model.trim();
  if (values.agent === ANALYST && model === "") {
    return { ok: false, message: "analyst needs a model: type one in the model field" };
  }
  const args = ["task", "add", title, "--project", target.slug, "--agent", values.agent];
  if (values.agent === ANALYST) args.push("--model", model);
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

export interface AddTaskFormOptions {
  readonly projectSlug: string;
  // HARIL_DEFAULT_MODEL as the shell received it. Prefills the model; with one, analyst is the default agent.
  readonly defaultModel: string | undefined;
}

export class AddTaskForm {
  readonly projectSlug: string;
  private readonly titleInput = new Input();
  private readonly modelInput = new Input();
  private readonly agentList: SelectList;
  private focused: FormField = "title";

  constructor(options: AddTaskFormOptions) {
    this.projectSlug = options.projectSlug;
    const defaultModel = options.defaultModel?.trim() ?? "";
    const items: SelectItem[] = AGENT_REFS.map((ref) => ({ value: ref, label: ref }));
    this.agentList = new SelectList(items, items.length, PLAIN_THEME);
    this.agentList.setSelectedIndex(
      Math.max(0, AGENT_REFS.indexOf(defaultModel === "" ? SIMULATED : ANALYST)),
    );
    this.modelInput.setValue(defaultModel);
  }

  get field(): FormField {
    return this.focused;
  }

  next(): void {
    this.focused = FIELDS[(FIELDS.indexOf(this.focused) + 1) % FIELDS.length] ?? "title";
  }

  previous(): void {
    this.focused =
      FIELDS[(FIELDS.indexOf(this.focused) + FIELDS.length - 1) % FIELDS.length] ?? "title";
  }

  // A key for the focused field: text editing for title and model, up and down for the agent.
  handleInput(data: string): void {
    if (this.focused === "title") this.titleInput.handleInput(data);
    else if (this.focused === "model") this.modelInput.handleInput(data);
    else this.agentList.handleInput(data);
  }

  values(): AddTaskValues {
    return {
      title: this.titleInput.getValue(),
      agent: this.selectedAgent(),
      model: this.modelInput.getValue(),
    };
  }

  // The form as plain lines: the focused field has a marker and a cursor at the end of its text.
  lines(): string[] {
    const marker = (field: FormField): string => (this.focused === field ? "> " : "  ");
    const cursor = (field: FormField): string => (this.focused === field ? "_" : "");
    const agent = this.selectedAgent();
    const agents = AGENT_REFS.map((ref) => (ref === agent ? `[${ref}]` : ref)).join("  ");
    return [
      `Add task to project ${this.projectSlug}`,
      `${marker("title")}title   ${this.titleInput.getValue()}${cursor("title")}`,
      `${marker("agent")}agent   ${agents}`,
      `${marker("model")}model   ${this.modelInput.getValue()}${cursor("model")}${agent === ANALYST ? "" : "  (analyst only)"}`,
    ];
  }

  private selectedAgent(): string {
    return this.agentList.getSelectedItem()?.value ?? SIMULATED;
  }
}
