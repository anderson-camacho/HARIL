import type { Plan } from "@haril/contracts";

// Limits of one plan. A plan task may not plan itself: maxDelegationDepth 1 allows a single level.
export const PLAN_LIMITS = { maxTasksPerPlan: 50, maxDelegationDepth: 1 } as const;

export type PlanGraphIssueCode =
  | "unknown_dependency"
  | "duplicate_task_id"
  | "cycle"
  | "too_many_tasks"
  | "nested_plan_task";

export interface PlanGraphIssue {
  readonly code: PlanGraphIssueCode;
  readonly message: string;
  // The local id of the task the issue belongs to, when it belongs to one task.
  readonly taskId?: string;
  // For cycle: the ids along the cycle, first id repeated at the end ("a depends on b depends on a").
  readonly path?: readonly string[];
}

// Structural rules over a plan's local-id graph. Pure: no I/O, no clock, no typebox.
// Issues come out in a fixed order (limit, duplicates, nested plans, unknown deps, cycles).
export function validatePlanGraph(plan: Plan): PlanGraphIssue[] {
  const issues: PlanGraphIssue[] = [];
  const { tasks } = plan;

  if (tasks.length > PLAN_LIMITS.maxTasksPerPlan) {
    issues.push({
      code: "too_many_tasks",
      message: `plan has ${tasks.length} tasks; the maximum is ${PLAN_LIMITS.maxTasksPerPlan}`,
    });
  }

  const known = new Set<string>();
  const reportedDuplicates = new Set<string>();
  for (const task of tasks) {
    if (!known.has(task.localId)) {
      known.add(task.localId);
    } else if (!reportedDuplicates.has(task.localId)) {
      reportedDuplicates.add(task.localId);
      issues.push({
        code: "duplicate_task_id",
        taskId: task.localId,
        message: `local id "${task.localId}" is used by more than one task`,
      });
    }
  }

  for (const task of tasks) {
    if (task.kind === "plan") {
      issues.push({
        code: "nested_plan_task",
        taskId: task.localId,
        message: `task "${task.localId}" has kind "plan"; a plan task may not plan (maxDelegationDepth ${PLAN_LIMITS.maxDelegationDepth})`,
      });
    }
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!known.has(dependency)) {
        issues.push({
          code: "unknown_dependency",
          taskId: task.localId,
          message: `task "${task.localId}" depends on unknown task "${dependency}"`,
        });
      }
    }
  }

  issues.push(...findCycles(dependencyMap(plan), known));
  return issues;
}

// Dependencies first, ties broken by plan order (Kahn's algorithm with a stable pick).
// Returns null when the plan has a duplicate id, an unknown dependency or a cycle.
export function topologicalOrder(plan: Plan): string[] | null {
  const known = new Set(plan.tasks.map((task) => task.localId));
  if (known.size !== plan.tasks.length) return null;
  if (plan.tasks.some((task) => task.dependsOn.some((dep) => !known.has(dep)))) return null;

  const done = new Set<string>();
  const order: string[] = [];
  const pending = [...plan.tasks];
  while (pending.length > 0) {
    const index = pending.findIndex((task) => task.dependsOn.every((dep) => done.has(dep)));
    if (index === -1) return null;
    const [next] = pending.splice(index, 1);
    if (next === undefined) return null;
    done.add(next.localId);
    order.push(next.localId);
  }
  return order;
}

function dependencyMap(plan: Plan): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  for (const task of plan.tasks) {
    const merged = deps.get(task.localId) ?? [];
    deps.set(task.localId, [...merged, ...task.dependsOn]);
  }
  return deps;
}

function findCycles(deps: Map<string, string[]>, known: ReadonlySet<string>): PlanGraphIssue[] {
  const issues: PlanGraphIssue[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): void => {
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (!known.has(dep)) continue;
      const depState = state.get(dep);
      if (depState === "visiting") {
        const path = [...stack.slice(stack.indexOf(dep)), dep];
        issues.push({
          code: "cycle",
          path,
          message: `dependency cycle: ${path.join(" -> ")}`,
        });
      } else if (depState === undefined) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(id, "done");
  };

  for (const id of known) {
    if (!state.has(id)) visit(id);
  }
  return issues;
}
