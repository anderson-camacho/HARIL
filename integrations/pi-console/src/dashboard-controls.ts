import type { DashboardArea } from "./dashboard.js";
import type { DashboardData } from "./dashboard-data.js";

export type DashboardAction =
  | "refresh"
  | "model"
  | "tasks"
  | "approvals"
  | "events"
  | "goal"
  | "run-queue"
  | "start-runtime"
  | "stop-runtime"
  | "toggle-tools"
  | "methodologies"
  | "commands"
  | "memory"
  | "details"
  | "register-project"
  | "orchestration-view"
  | "orchestration-demo";

export interface DashboardControl {
  readonly action: DashboardAction;
  readonly label: string;
  readonly hint: string;
}

export function controlsFor(
  area: DashboardArea,
  data: DashboardData,
  runtime: string,
  runtimeAvailable = true,
  orchestrationDemo = false,
): DashboardControl[] {
  const refresh: DashboardControl = { action: "refresh", label: "Refresh data", hint: "R" };
  switch (area) {
    case "agents":
      return [
        ...(data.projectSlug === undefined
          ? [{ action: "register-project" as const, label: "Register this folder", hint: "I" }]
          : []),
        { action: "details", label: "View complete details", hint: "D" },
        { action: "model", label: "Choose Pi model", hint: "M" },
        ...(data.projectSlug === undefined
          ? []
          : [{ action: "tasks" as const, label: "Tasks by observed agent", hint: "T" }]),
        refresh,
      ];
    case "orchestration":
      return [
        ...(data.projectSlug === undefined
          ? [{ action: "register-project" as const, label: "Register this folder", hint: "I" }]
          : []),
        { action: "details", label: "View complete details", hint: "D" },
        { action: "orchestration-view", label: "Open orchestration view", hint: "V" },
        {
          action: "orchestration-demo",
          label: orchestrationDemo ? "Demo off (sample data)" : "Demo on (sample data)",
          hint: "M",
        },
        ...(data.projectSlug === undefined
          ? []
          : [
              {
                action: "approvals" as const,
                label: `Review approvals (${data.approvals.length})`,
                hint: "A",
              },
              { action: "tasks" as const, label: "Inspect project tasks", hint: "T" },
              { action: "goal" as const, label: "Queue a goal for planning", hint: "G" },
              { action: "events" as const, label: "Project event history", hint: "E" },
            ]),
        refresh,
      ];
    case "automation":
      return [
        ...(data.projectSlug === undefined
          ? [{ action: "register-project" as const, label: "Register this folder", hint: "I" }]
          : []),
        { action: "details", label: "View complete details", hint: "D" },
        ...(data.projectSlug === undefined
          ? []
          : [
              ...(runtimeAvailable && runtime === "idle"
                ? [
                    {
                      action: "run-queue" as const,
                      label: "Run this project's queued work",
                      hint: "Q",
                    },
                    { action: "start-runtime" as const, label: "Start shared runtime", hint: "S" },
                  ]
                : []),
              ...(runtimeAvailable && runtime === "running"
                ? [{ action: "stop-runtime" as const, label: "Stop shared runtime", hint: "S" }]
                : []),
              { action: "tasks" as const, label: "Inspect queue and task states", hint: "T" },
            ]),
        refresh,
      ];
    case "tools":
      return [
        { action: "details", label: "View complete details", hint: "D" },
        { action: "toggle-tools", label: "Enable or disable Pi tools", hint: "T" },
        refresh,
      ];
    case "workflows":
      return [
        ...(data.projectSlug === undefined
          ? [{ action: "register-project" as const, label: "Register this folder", hint: "I" }]
          : []),
        { action: "details", label: "View complete details", hint: "D" },
        { action: "methodologies", label: "Browse HARIL methodologies", hint: "B" },
        { action: "commands", label: "Browse HARIL commands", hint: "C" },
        refresh,
      ];
    case "everywhere":
      return [
        { action: "details", label: "View complete details", hint: "D" },
        { action: "memory", label: "Show recorded memory health", hint: "M" },
        refresh,
      ];
  }
}
