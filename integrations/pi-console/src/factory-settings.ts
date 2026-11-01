import type { CliResult } from "./cli.js";
import type { DelegationView, SettingField, SettingValue } from "./delegation-settings.js";
import { decodeDelegationView } from "./delegation-settings.js";
import type { Catalog } from "./tools-catalog.js";
import { parseMemoryStatus, parseToolsStatus } from "./tools-model.js";

// What the Sistema tab reads besides the feed: the settings of `haril config get delegation --json`, generated field by
// field from HARIL's table, and the inventory TOOLS lists. Labels are shown in Spanish here because the table's are
// English for the CLI. Pure, apart from the commands its loader is given.

export type HealthState = "ok" | "down" | "unknown";

export interface FactorySystemData {
  // null: the settings could not be read.
  readonly settings: DelegationView | null;
  readonly skills: readonly string[];
  readonly mcp: readonly { readonly name: string; readonly state: string }[];
  readonly tools: readonly { readonly name: string; readonly state: string }[];
  readonly memory: { readonly state: HealthState; readonly detail: string };
}

export interface FactorySystemDeps {
  run(args: readonly string[]): Promise<CliResult>;
  catalog(): Catalog;
}

const LAYER: Readonly<Record<string, string>> = {
  orchestrator: "orquestador",
  delegator: "delegado",
  executor: "ejecutor",
  auditor: "auditor",
};

const LABELS: Readonly<Record<string, string>> = {
  "context.compactAtTokens": "Compactar desde, todas las capas",
  "limits.maxActiveChildren.orchestrator": "Hijos vivos del orquestador",
  "limits.maxActiveChildren.delegator": "Hijos vivos de un delegado",
  "limits.maxConcurrent.executors": "Ejecutores a la vez",
  "limits.maxConcurrent.auditors": "Auditores a la vez",
  "limits.maxConcurrent.delegators": "Delegados a la vez",
  "limits.maxConcurrent.writers": "Escritores a la vez (git)",
  "limits.maxQueuedTasksPerThread": "Hijos en cola por hilo",
  "limits.maxProposalsPerThread": "Propuestas por hilo",
  "limits.maxAgentsPerWorkflow": "Agentes por flujo",
  "limits.maxAuditRetries": "Relanzamientos tras una auditoría rechazada",
  "limits.maxEscalationsPerTask": "Escalados por tarea",
  "limits.maxWorkflowTokens": "Presupuesto de tokens del flujo",
  "limits.maxWorkflowWallMs": "Tiempo máximo del flujo",
  "limits.largeTaskTokens": "Una tarea es grande desde",
  "limits.attemptTimeoutMs": "Intento más largo",
  "limits.minAuditorTokens": "Presupuesto mínimo de un auditor",
  "limits.maxCouncillors": "Máximo de consejeros en una discusión",
  "limits.maxHandoffsPerTask": "Relevos de una tarea antes de detenerse",
  "watchdog.vigilanteAnalysis": "El vigilante pide un análisis a un modelo",
  "limits.projectTokens": "Presupuesto de tokens del proyecto",
  "models.auditorDistinctFromExecutor": "Auditor en otro modelo que su ejecutor",
  "quota.source": "Fuente de la cuota",
  "quota.managementBaseUrl": "URL del servidor de gestión",
  "quota.managementKeyEnv": "Variable de la clave de gestión",
  "quota.switchAtPercent5h": "Cambiar de modelo desde (5 horas)",
  "quota.stopAtPercentWeekly": "Dejar de usar desde (semana)",
  "quota.minRemainingPercentForLargeTask": "Mínimo libre para tarea grande",
  "quota.maxWaitMs": "Espera máxima de un reinicio",
  "quota.reservePercent": "Reserva intocable de cada ventana",
  "quota.colorWarnPercent": "Barra amarilla desde",
  "quota.colorDangerPercent": "Barra roja desde",
  "watchdog.intervalMs": "Revisar cada",
  "watchdog.idleStrikesToClose": "Revisiones sin avance antes de cerrar",
  "watchdog.closeResidualImmediately": "Cerrar residuales al instante",
  "autonomy.defaultStops": "Paradas por defecto",
  "commands.allow": "Comandos que pueden correr",
  "commands.timeoutMs": "Comando más largo",
  "commands.outputMaxBytes": "Salida guardada por flujo (bytes)",
  "git.baseBranch": "Rama base de los flujos que escriben",
  "research.folder": "Carpeta de investigación (CONSULT)",
};

const ROLE_PARTS: Readonly<Record<string, string>> = {
  enabled: "activo",
  archetype: "corre como",
  models: "modelos en orden",
  floor: "nivel mínimo",
};

export function settingLabel(field: Pick<SettingField, "path" | "label">): string {
  const path = field.path.replace(/^delegation\./, "");
  const known = LABELS[path];
  if (known !== undefined) return known;
  const parts = path.split(".");
  const [head] = parts;
  const layer = LAYER[parts[parts.length - 1] ?? ""] ?? LAYER[parts[2] ?? ""] ?? "";
  if (head === "roles") return `Rol ${parts[1]}: ${ROLE_PARTS[parts[2] ?? ""] ?? parts[2]}`;
  if (head === "context") return `Compactar desde, ${layer}`;
  if (head === "models" && parts[1] === "allow") return `Modelos permitidos, ${layer}`;
  if (head === "models" && parts[3] === "level") return `Razonamiento, ${layer}`;
  if (head === "models" && parts[3] === "model") return `Modelo, ${layer}`;
  return field.label;
}

export const GROUP_LABELS: Readonly<Record<string, string>> = {
  context: "Contexto",
  limits: "Límites",
  models: "Modelos y niveles",
  roles: "Roles",
  quota: "Cuota",
  watchdog: "Vigilante",
  autonomy: "Autonomía",
  commands: "Comandos",
  git: "Git",
  research: "Investigación",
};

const EFFECTS: Readonly<Record<string, string>> = {
  "new workflows": "Aplica a los flujos nuevos.",
  "next model choice": "Aplica a la próxima elección de modelo.",
  "next agent launch": "Aplica al próximo agente que arranque.",
  "next runtime start": "Aplica al próximo arranque del runtime.",
  "next research file": "Aplica al próximo archivo de investigación.",
  "next view refresh": "Aplica al próximo refresco de esta vista.",
};

export function effectText(effect: string): string {
  return EFFECTS[effect] ?? `Aplica en: ${effect}.`;
}

const SECRET_NAME = /(^|\.)(api-?key|management-?key|key|token|secret|password)$/i;

// The table holds no secret, and `haril config set` refuses a key name at any depth. Should one ever come, this shows
// that it is set and never what it is.
export function displayValue(field: SettingField, value: SettingValue): string {
  if (field.kind.type !== "env-name" && SECRET_NAME.test(field.path)) return "(oculto)";
  if (value === null) return field.kind.type === "integer" ? "heredado" : "sin valor";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (Array.isArray(value)) return value.length === 0 ? "ninguno" : value.join(", ");
  if (typeof value === "number") return numberText(field, value);
  return String(value);
}

function numberText(field: SettingField, value: number): string {
  if (field.kind.type === "percent") return `${value} %`;
  if (field.kind.type !== "integer") return String(value);
  if (field.kind.unit === "ms") {
    if (value >= 3_600_000) return `${Math.round((value / 3_600_000) * 10) / 10} h`;
    if (value >= 60_000) return `${Math.round((value / 60_000) * 10) / 10} min`;
    return `${value / 1000} s`;
  }
  const text = String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return field.kind.unit === "tokens" ? `${text} tokens` : text;
}

// A slider's range, for what has one.
export function sliderRange(
  field: SettingField,
): { readonly min: number; readonly max: number; readonly step: number } | undefined {
  if (field.kind.type === "percent") return { min: 0, max: 100, step: 5 };
  if (field.kind.type !== "integer") return undefined;
  const span = field.kind.max - field.kind.min;
  const raw = span / 50;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  const step = Math.max(1, Math.round(raw / magnitude) * magnitude);
  return { min: field.kind.min, max: field.kind.max, step };
}

export function isEditable(field: SettingField): boolean {
  return field.kind.type !== "always-true";
}

// What a string typed for a field looks like when it is sent: lists go comma-separated, as haril config set reads them.
export function valueToText(value: SettingValue): string {
  if (value === null) return "";
  return Array.isArray(value) ? value.join(",") : String(value);
}

function healthOf(state: string | undefined, running: boolean, degraded: boolean): HealthState {
  if (state === undefined || (!running && state === "not_checked")) return "unknown";
  return degraded ? "down" : "ok";
}

// The tab's data, read once when it is needed and again after a change. Each part that fails only leaves its own gap.
export async function loadFactorySystem(deps: FactorySystemDeps): Promise<FactorySystemData> {
  const [config, tools, memory] = await Promise.all([
    deps.run(["config", "get", "delegation", "--json"]),
    deps.run(["tools", "status", "--json"]),
    deps.run(["memory", "status", "--json"]),
  ]);
  const settings = ((): DelegationView | null => {
    try {
      return decodeDelegationView(JSON.parse(config.stdout) as unknown) ?? null;
    } catch {
      return null;
    }
  })();
  const status = tools.ok ? parseToolsStatus(tools.stdout) : undefined;
  const view = memory.ok ? parseMemoryStatus(memory.stdout) : undefined;
  const catalog = deps.catalog();
  return {
    settings,
    skills: catalog.skills.map((skill) => skill.name),
    mcp: catalog.servers.map((server) => ({ name: server.name, state: server.state })),
    tools: [
      ...(status?.engram === undefined ? [] : [{ name: "Engram", state: status.engram.state }]),
      ...(status?.gentleAi === undefined
        ? []
        : [{ name: "Gentle AI", state: status.gentleAi.state }]),
    ],
    memory:
      view === undefined
        ? { state: "unknown", detail: "No se pudo preguntar por la memoria." }
        : {
            state: healthOf(view.health, view.running, view.degraded),
            detail: `${view.provider}: ${view.health}, ${view.outboxDepth} pendientes`,
          },
  };
}
