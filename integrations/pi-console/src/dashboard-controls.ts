import type { DashboardArea } from "./dashboard.js";
import type { DashboardData } from "./dashboard-data.js";
import { DEFAULT_UI_LOCALE, localized, type UiLocale } from "./locale.js";

export type DashboardAction =
  | "refresh"
  | "model"
  | "model-level"
  | "level"
  | "tasks"
  | "approvals"
  | "events"
  | "goal"
  | "run-queue"
  | "start-runtime"
  | "stop-runtime"
  | "toggle-tools"
  | "delegation"
  | "methodologies"
  | "commands"
  | "memory"
  | "usage-log"
  | "details"
  | "register-project"
  | "orchestration-view"
  | "orchestration-pick"
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
  locale: UiLocale = DEFAULT_UI_LOCALE,
): DashboardControl[] {
  const control = (
    action: DashboardAction,
    hint: string,
    english: string,
    spanish: string,
  ): DashboardControl => ({ action, hint, label: localized(locale, english, spanish) });
  const refresh = control("refresh", "R", "Refresh data", "Actualizar datos");
  switch (area) {
    case "agents":
      return [
        ...(data.projectSlug === undefined
          ? [control("register-project", "I", "Register this folder", "Registrar esta carpeta")]
          : []),
        control("details", "D", "View complete details", "Ver detalles completos"),
        control("model", "M", "Choose Pi model", "Elegir modelo de Pi"),
        ...(data.projectSlug === undefined
          ? []
          : [control("tasks", "T", "Tasks by observed agent", "Tareas por agente observado")]),
        refresh,
      ];
    case "orchestration":
      return [
        ...(data.projectSlug === undefined
          ? [control("register-project", "I", "Register this folder", "Registrar esta carpeta")]
          : []),
        control("details", "D", "View complete details", "Ver detalles completos"),
        control(
          "orchestration-view",
          "V",
          "Open orchestration view",
          "Abrir vista de orquestación",
        ),
        control(
          "orchestration-pick",
          "P",
          "Pick the workflow to follow",
          "Elegir el flujo de trabajo a seguir",
        ),
        control(
          "orchestration-demo",
          "M",
          orchestrationDemo ? "Demo off (sample data)" : "Demo on (sample data)",
          orchestrationDemo
            ? "Desactivar demostración (datos de ejemplo)"
            : "Activar demostración (datos de ejemplo)",
        ),
        ...(data.projectSlug === undefined
          ? []
          : [
              control(
                "approvals",
                "A",
                `Review approvals (${data.approvals.length})`,
                `Revisar aprobaciones (${data.approvals.length})`,
              ),
              control("tasks", "T", "Inspect project tasks", "Inspeccionar tareas del proyecto"),
              control(
                "goal",
                "G",
                "Queue a goal for planning",
                "Encolar un objetivo para planificación",
              ),
              control("events", "E", "Project event history", "Historial de eventos del proyecto"),
            ]),
        refresh,
      ];
    case "automation":
      return [
        ...(data.projectSlug === undefined
          ? [control("register-project", "I", "Register this folder", "Registrar esta carpeta")]
          : []),
        control("details", "D", "View complete details", "Ver detalles completos"),
        ...(data.projectSlug === undefined
          ? []
          : [
              ...(runtimeAvailable && runtime === "idle"
                ? [
                    control(
                      "run-queue",
                      "Q",
                      "Run this project's queued work",
                      "Ejecutar trabajo encolado del proyecto",
                    ),
                    control(
                      "start-runtime",
                      "S",
                      "Start shared runtime",
                      "Iniciar runtime compartido",
                    ),
                  ]
                : []),
              ...(runtimeAvailable && runtime === "running"
                ? [
                    control(
                      "stop-runtime",
                      "S",
                      "Stop shared runtime",
                      "Detener runtime compartido",
                    ),
                  ]
                : []),
              control(
                "tasks",
                "T",
                "Inspect queue and task states",
                "Inspeccionar cola y estados de tareas",
              ),
            ]),
        refresh,
      ];
    case "tools":
      return [
        control("details", "D", "View complete details", "Ver detalles completos"),
        control("model-level", "M", "Model and level", "Modelo y nivel"),
        control("delegation", "S", "Delegation settings", "Ajustes de delegación"),
        control(
          "toggle-tools",
          "T",
          "Enable or disable Pi tools",
          "Activar o desactivar herramientas de Pi",
        ),
        control(
          "methodologies",
          "B",
          "Browse HARIL methodologies",
          "Explorar metodologías de HARIL",
        ),
        control("commands", "C", "Browse HARIL commands", "Explorar comandos de HARIL"),
        control("usage-log", "L", "Recent activity log", "Registro de actividad reciente"),
        refresh,
      ];
    case "everywhere":
      return [
        control("details", "D", "View complete details", "Ver detalles completos"),
        control("usage-log", "L", "Recent activity log", "Registro de actividad reciente"),
        control(
          "memory",
          "M",
          "Show recorded memory health",
          "Mostrar estado de la memoria registrada",
        ),
        refresh,
      ];
  }
}
