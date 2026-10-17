import type { PlanTask } from "@haril/contracts";

// One task of a proposed plan as a person reads it before deciding (LD-T6c): every field the runtime applies to the
// task it creates. The goal and the description are the agent's prompt; the agent, the dependencies, the files it may
// write and read, the kind, the limits, the budget, the capabilities, the context and the checks decide what it may do
// and when it is done. Shared by the shell's plan review and `haril approvals show` (LD-T7c), so both list the same
// fields. Plain lines: each caller shows them through visibleText before they reach a terminal. Pure.
export function planTaskLines(task: PlanTask, index: number): string[] {
  const { budget, surface } = task;
  return [
    `${index + 1}. ${task.localId}: ${task.goal}`,
    `   agent ${task.agent}, depends on: ${listed(task.dependsOn)}`,
    ...descriptionLines(task.description),
    `   writes: ${listed(surface.write)}; reads: ${listed(surface.read)}`,
    `   kind ${task.kind}, priority ${task.priority}, attempts ${task.maxAttempts}, timeout ${task.timeoutMs} ms`,
    `   budget: ${budget.maxTokens} tokens, ${budget.maxWallMs} ms wall time, ${budget.maxCostMicros} cost micros`,
    `   requires: ${listed(task.requires)}; context: ${listed(task.context)}`,
    `   acceptance: ${task.acceptance.length === 0 ? "none" : task.acceptance.map(checkText).join(", ")}`,
  ];
}

// The description line by line, the lines after the first indented under it; "none" when it is blank, as the agent
// then gets the goal alone.
function descriptionLines(description: string): string[] {
  if (description.trim() === "") return ["   description: none"];
  const [first, ...rest] = description.split(/\r?\n/);
  return [`   description: ${first ?? ""}`, ...rest.map((line) => `     ${line}`)];
}

// A host check as it reads: its kind with its path and its text quoted, or a block verifier as block/check.
function checkText(check: PlanTask["acceptance"][number]): string {
  if (!("kind" in check)) {
    const params = check.params === undefined ? "" : ` ${JSON.stringify(check.params)}`;
    return `${check.blockId}/${check.checkId}${params}`;
  }
  switch (check.kind) {
    case "file_exists":
      return `file_exists ${check.path}`;
    case "file_contains":
      return `file_contains ${check.path} ${JSON.stringify(check.text)}`;
    case "output_contains":
      return `output_contains ${JSON.stringify(check.text)}`;
  }
}

function listed(items: readonly string[]): string {
  return items.length === 0 ? "none" : items.join(", ");
}
