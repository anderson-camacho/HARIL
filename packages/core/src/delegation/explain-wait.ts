import type { BlockReason, RetryReason, TaskState, WaitExplanation } from "@haril/contracts";

// Why a turn is where it is, in words for the person who watches it (feature haril-factory, F2). Every state a turn can
// be in has an explanation, built only from stored facts: no model writes these lines. Each block reason has its own
// entry in a Record and each task state its own case, so a new reason or state does not compile until it is explained.
// Pure: the clock comes in as `now`.

export const WAIT_CODES = [
  "blocked_awaiting_human",
  "blocked_needs_authorization",
  "blocked_budget",
  "blocked_cooldown",
  "blocked_no_capacity",
  "blocked_surface_conflict",
  "blocked_dep_failed",
  "blocked_memory_unavailable",
  "blocked_no_route",
  "blocked_sandbox_unavailable",
  "blocked_block_unavailable",
  "blocked_unknown",
  "pending_deps",
  "pending_children",
  "pending_stopped",
  "ready_next",
  "ready_retry",
  "ready_no_capacity",
  "ready_no_runtime",
  "ready_model_cooldown",
  "ready_stopped",
  "workflow_ended",
  "running",
  "completed",
  "completed_waits_audit",
  "completed_escalated",
  "completed_waits_final_audit",
  "failed",
  "failed_audit",
  "audit_rejected",
  "closed_idle",
  "cancelled",
] as const;
type WaitCode =
  | (typeof WAIT_CODES)[number]
  | "workflow_running"
  | "workflow_stop"
  | "workflow_completed"
  | "workflow_failed"
  | "workflow_stopped";

// How a turn that ended sits in its delegation, as its audits and usage tell it.
export type WaitSettled =
  | "waits_audit"
  | "escalated"
  | "waits_final_audit"
  | "audit_failed"
  | "audit_rejected"
  | "closed_idle";

export interface WaitWorkflowInput {
  readonly id: string;
  readonly state: "running" | "awaiting_human" | "completed" | "failed" | "stopped";
  readonly stopReason: string | null;
}

export interface CapacityWait {
  readonly tried: readonly {
    readonly model: string;
    readonly cause: string;
    readonly until: number | null;
  }[];
  readonly holders: readonly { readonly model: string; readonly agent: string }[];
  // The earliest known moment one of them frees; null when none is known.
  readonly frees: number | null;
}

export interface WaitInput {
  readonly task: {
    readonly state: TaskState;
    readonly blockReason: BlockReason | null;
    readonly cooldownUntil: number | null;
    readonly retryReason: RetryReason | null;
    readonly attempt: number;
    // Null when the store keeps no limit of attempts for the turn.
    readonly maxAttempts: number | null;
    readonly model: string | null;
    // The agent the turn answers to; null for the root, which answers to the person.
    readonly parentCode: string | null;
    // The stored code of its last failure.
    readonly failure: string | null;
    readonly settled: WaitSettled | null;
  };
  readonly workflow: WaitWorkflowInput | null;
  readonly dependencies: readonly { readonly code: string; readonly state: TaskState }[];
  readonly cooldowns: readonly {
    readonly model: string;
    readonly until: number;
    readonly reason: string;
  }[];
  // The agent that holds what this turn waits for (a surface it writes), when known.
  readonly holder: { readonly code: string; readonly model: string | null } | null;
  // The live and maximum agents of the turn's role; null when the workflow sets no limit.
  readonly capacity: { readonly live: number; readonly max: number } | null;
  // False when no runtime holds the lease, so nothing can start; null when unknown.
  readonly runtimeAlive: boolean | null;
  // The last time the turn found no model that could run it: what it tried and who holds it. Absent or null otherwise.
  readonly capacityWait?: CapacityWait | null;
  readonly now: number;
}

const OPEN_STATES: ReadonlySet<TaskState> = new Set([
  "pending",
  "ready",
  "running",
  "blocked",
] as const);
const MINUTE_MS = 60_000;

function explanation(
  code: WaitCode,
  what: string,
  why: string,
  systemAction: string,
  needsHuman: boolean,
  until: number | null = null,
): WaitExplanation {
  return { code, what, why, systemAction, needsHuman, until };
}

function continueHint(workflowId: string): string {
  return `No arranca solo: ejecuta \`haril workflow continue ${workflowId}\` o pulsa c en la fábrica (Alt+G).`;
}

// A stop in words; the stop's own name is always there, so the person can tell which one to remove.
function stopInWords(stopReason: string | null): string {
  if (stopReason === null) return "El flujo se detuvo en una parada sin motivo registrado.";
  if (stopReason === "after_plan")
    return "Se detuvo en la parada after_plan: el plan ya está hecho y espera tu revisión antes de lanzar a los delegados.";
  if (stopReason === "before_merge")
    return "Se detuvo en la parada before_merge: el trabajo está listo y espera tu revisión antes de integrarse.";
  if (stopReason === "on_audit_failure")
    return "Se detuvo en la parada on_audit_failure: una auditoría agotó sus reintentos.";
  if (stopReason === "at_end")
    return "Se detuvo en la parada at_end: todo terminó y espera tu visto bueno para cerrar.";
  if (stopReason === "human_request")
    return "Un agente hizo una petición a una persona y el flujo espera la respuesta.";
  if (stopReason.startsWith("council_below_minimum:")) {
    const [valid, min] = stopReason.slice("council_below_minimum:".length).split("/");
    return `Una discusión necesita al menos ${min} opiniones válidas y solo hay ${valid}: no sigue con menos. Falta capacidad de modelos o un consejero respondió vacío.`;
  }
  if (stopReason.startsWith("handoff_cap:"))
    return `${stopReason.slice("handoff_cap:".length)} ya pasó por el máximo de relevos de una tarea y no cambia de modelo otra vez.`;
  if (stopReason.startsWith("after_node:"))
    return `Se detuvo en la parada ${stopReason}: ese nodo cerró y espera tu revisión.`;
  if (stopReason.startsWith("on_budget_pct:"))
    return `Se detuvo en la parada ${stopReason}: el flujo llegó a ese porcentaje de su presupuesto.`;
  return `Se detuvo en la parada ${stopReason}.`;
}

function minutesLeft(until: number, now: number): string {
  const minutes = Math.ceil((until - now) / MINUTE_MS);
  return minutes <= 1 ? "en menos de 1 min" : `en ${minutes} min`;
}

const CAUSE_TEXT: Readonly<Record<string, string>> = {
  not_allowed: "no permitido en esta capa",
  not_in_catalog: "no está en el catálogo",
  no_key: "su proveedor no tiene clave",
  cooldown: "en enfriamiento",
  window_5h: "pasó su ventana de 5 horas",
  weekly: "pasó su semana",
  large_task: "no le queda para una tarea grande",
  below_floor: "por debajo del piso de su rol",
};

function capacityExplanation(wait: CapacityWait, now: number): WaitExplanation {
  const tried = wait.tried.map((row) => `${row.model} (${CAUSE_TEXT[row.cause] ?? row.cause})`);
  const holders = wait.holders.map((row) => `${row.model} lo usa ${row.agent}`);
  const when =
    wait.frees === null
      ? "No se sabe cuándo se libera alguno."
      : wait.frees <= now
        ? "Uno ya debería estar libre."
        : `El primero se libera ${minutesLeft(wait.frees, now)}.`;
  return explanation(
    "blocked_no_capacity",
    "Sin modelo disponible",
    [
      tried.length === 0 ? "Ninguno de sus modelos está conectado." : `Probó ${tried.join(", ")}.`,
      ...(holders.length === 0 ? [] : [`${holders.join(", ")}.`]),
      when,
    ].join(" "),
    "Reintenta sola y sigue en cuanto haya un modelo; si no llega, el flujo falla al pasar su tiempo máximo.",
    false,
    wait.frees,
  );
}

function cooldownExplanation(input: WaitInput): WaitExplanation {
  const { task, cooldowns, now } = input;
  if (input.capacityWait !== undefined && input.capacityWait !== null) {
    return capacityExplanation(input.capacityWait, now);
  }
  const own = cooldowns.find((row) => row.model === task.model);
  const until = task.cooldownUntil ?? own?.until ?? null;
  const model = task.model ?? "su modelo";
  const cause = own === undefined ? "" : ` (${own.reason})`;
  if (until === null) {
    return explanation(
      "blocked_cooldown",
      "Espera a que su modelo se enfríe",
      `${model} está en enfriamiento${cause} y no se sabe hasta cuándo.`,
      "Reintenta solo cuando el proveedor vuelva a aceptar.",
      false,
    );
  }
  const when =
    until <= now
      ? `El enfriamiento de ${model} ya venció${cause}.`
      : `${model} está en enfriamiento${cause}; termina ${minutesLeft(until, now)}.`;
  return explanation(
    "blocked_cooldown",
    "Espera a que su modelo se enfríe",
    when,
    "Vuelve a la cola sola cuando termine.",
    false,
    until,
  );
}

const BLOCK_EXPLAINERS: Readonly<Record<BlockReason, (input: WaitInput) => WaitExplanation>> = {
  awaiting_human: (input) =>
    explanation(
      "blocked_awaiting_human",
      "Espera una decisión tuya",
      input.workflow?.state === "awaiting_human"
        ? stopInWords(input.workflow.stopReason)
        : "La tarea pidió una decisión de la persona.",
      input.workflow?.state === "awaiting_human"
        ? continueHint(input.workflow.id)
        : "No sigue hasta que respondas.",
      true,
    ),
  needs_authorization: () =>
    explanation(
      "blocked_needs_authorization",
      "Necesita tu autorización",
      "Va a hacer algo que su modo no permite sin autorización.",
      "No sigue hasta que autorices; revisa `haril approvals`.",
      true,
    ),
  budget: () =>
    explanation(
      "blocked_budget",
      "Se quedó sin presupuesto",
      "Gastó los tokens que tenía asignados.",
      "No gasta más hasta que amplíes su presupuesto o la detengas.",
      true,
    ),
  cooldown: cooldownExplanation,
  surface_conflict: (input) =>
    explanation(
      "blocked_surface_conflict",
      "Espera a que se libere un archivo",
      input.holder === null
        ? "Otro agente está escribiendo en los mismos archivos."
        : `${input.holder.code} está escribiendo en los mismos archivos.`,
      "Arranca sola cuando el otro agente termine.",
      false,
    ),
  dep_failed: (input) =>
    explanation(
      "blocked_dep_failed",
      "Una dependencia falló",
      `Falló una tarea de la que depende${failedDependencies(input)}.`,
      input.task.parentCode === null
        ? "Quedó en tus manos: nada la va a relanzar."
        : `Se le devolvió a ${input.task.parentCode}, que decide qué hacer.`,
      input.task.parentCode === null,
    ),
  memory_unavailable: () =>
    explanation(
      "blocked_memory_unavailable",
      "Espera a la memoria",
      "Necesita la memoria del proyecto y el servicio no responde.",
      "Sigue sola cuando la memoria vuelva; `haril doctor` dice qué le pasa.",
      false,
    ),
  no_route: (input) =>
    explanation(
      "blocked_no_route",
      "No hay ruta a su modelo",
      `Ninguna cuenta conectada da acceso a ${input.task.model ?? "su modelo"}.`,
      "Conecta una cuenta o elige otro modelo: no sigue por sí sola.",
      true,
    ),
  sandbox_unavailable: () =>
    explanation(
      "blocked_sandbox_unavailable",
      "No hay aislamiento disponible",
      "La tarea exige un entorno aislado y no se pudo crear.",
      "`haril doctor` dice qué falta: no sigue por sí sola.",
      true,
    ),
  block_unavailable: () =>
    explanation(
      "blocked_block_unavailable",
      "Falta una pieza que necesita",
      "Una integración que la tarea exige no está disponible.",
      "`haril doctor` dice cuál falta: no sigue por sí sola.",
      true,
    ),
};

function failedDependencies(input: WaitInput): string {
  const failed = input.dependencies.filter(
    (dependency) => dependency.state === "failed" || dependency.state === "cancelled",
  );
  return failed.length === 0 ? "" : `: ${failed.map((row) => row.code).join(", ")}`;
}

function explainBlocked(input: WaitInput): WaitExplanation {
  const reason = input.task.blockReason;
  if (reason !== null) return BLOCK_EXPLAINERS[reason](input);
  return explanation(
    "blocked_unknown",
    "Está bloqueada",
    "El almacén no registró el motivo del bloqueo.",
    "No sigue por sí sola: revisa `haril events`.",
    true,
  );
}

// A workflow that does not run holds its queued turns, whatever they wait for. Undefined while it runs.
function heldByWorkflow(
  input: WaitInput,
  stoppedCode: "pending_stopped" | "ready_stopped",
): WaitExplanation | undefined {
  const { workflow } = input;
  if (workflow === null || workflow.state === "running") return undefined;
  if (workflow.state === "awaiting_human") {
    return explanation(
      stoppedCode,
      "Detenida por una parada del flujo",
      stopInWords(workflow.stopReason),
      continueHint(workflow.id),
      true,
    );
  }
  return explanation(
    "workflow_ended",
    "Su flujo ya terminó",
    `El flujo está ${workflow.state}${workflow.stopReason === null ? "" : ` (${workflow.stopReason})`} y esta tarea no llegó a correr.`,
    "No va a correr: inicia otro flujo si la necesitas.",
    false,
  );
}

function explainPending(input: WaitInput): WaitExplanation {
  const held = heldByWorkflow(input, "pending_stopped");
  if (held !== undefined) return held;
  const open = input.dependencies.filter((dependency) => OPEN_STATES.has(dependency.state));
  if (open.length === 0) {
    return explanation(
      "pending_children",
      "Espera su turno",
      "Sus dependencias ya cerraron.",
      "Pasa a la cola en el próximo ciclo.",
      false,
    );
  }
  return explanation(
    "pending_deps",
    "Espera a otras tareas",
    `Depende de ${open.map((dependency) => dependency.code).join(", ")}.`,
    "Pasa a la cola cuando terminen.",
    false,
  );
}

function explainReady(input: WaitInput): WaitExplanation {
  const held = heldByWorkflow(input, "ready_stopped");
  if (held !== undefined) return held;
  const { task, cooldowns, capacity, runtimeAlive, now } = input;
  if (runtimeAlive === false) {
    return explanation(
      "ready_no_runtime",
      "Lista, pero nada la ejecuta",
      "No hay un runtime en marcha.",
      "Arráncalo con `haril start`.",
      true,
    );
  }
  const cooling = cooldowns.find((row) => row.model === task.model && row.until > now);
  if (cooling !== undefined) {
    return explanation(
      "ready_model_cooldown",
      "Lista, su modelo se está enfriando",
      `${cooling.model} está en enfriamiento (${cooling.reason}); termina ${minutesLeft(cooling.until, now)}.`,
      "Arranca sola cuando termine.",
      false,
      cooling.until,
    );
  }
  if (capacity !== null && capacity.max > 0 && capacity.live >= capacity.max) {
    return explanation(
      "ready_no_capacity",
      "Lista, sin espacio libre",
      `Ya corren ${capacity.live} de ${capacity.max} agentes de su rol.`,
      "Arranca sola cuando termine uno.",
      false,
    );
  }
  if (task.retryReason !== null) {
    const limit = task.maxAttempts === null ? "" : ` de ${task.maxAttempts}`;
    return explanation(
      "ready_retry",
      "Espera su reintento",
      `El intento anterior no terminó (${task.retryReason}); va en el ${task.attempt}${limit}.`,
      "Vuelve a lanzarse sola.",
      false,
    );
  }
  return explanation(
    "ready_next",
    "Lista para arrancar",
    "Nada la detiene.",
    "Arranca en el próximo ciclo del runtime.",
    false,
  );
}

function explainFailed(input: WaitInput): WaitExplanation {
  const { failure, parentCode, settled } = input.task;
  const code = settled === "audit_failed" ? "failed_audit" : "failed";
  const cause =
    settled === "audit_failed"
      ? "La auditoría la rechazó y se agotaron sus reintentos."
      : failure === null
        ? "Su último intento falló sin un código registrado."
        : `Su último intento falló: ${failure}.`;
  return explanation(
    code,
    "Falló",
    cause,
    parentCode === null
      ? "Quedó en tus manos: nada la va a relanzar."
      : `Se le devolvió a ${parentCode}, que decide qué hacer.`,
    parentCode === null,
  );
}

function explainSettled(settled: WaitSettled, input: WaitInput): WaitExplanation {
  switch (settled) {
    case "waits_audit":
      return explanation(
        "completed_waits_audit",
        "Terminó, espera su auditoría",
        "El trabajo está hecho pero nadie lo ha revisado todavía.",
        "Un auditor lo revisa antes de darlo por cerrado.",
        false,
      );
    case "escalated":
      return explanation(
        "completed_escalated",
        "Escalada a quien la delegó",
        "La auditoría la rechazó y agotó los reintentos del ejecutor.",
        `${input.task.parentCode ?? "Su delegador"} la reformula.`,
        false,
      );
    case "waits_final_audit":
      return explanation(
        "completed_waits_final_audit",
        "Espera la auditoría final",
        "Sus tareas cerraron; falta revisar el resultado completo.",
        "El auditor final lo revisa antes de cerrar el flujo.",
        false,
      );
    case "audit_failed":
      return explainFailed(input);
    case "audit_rejected":
      return explanation(
        "audit_rejected",
        "Auditó y rechazó",
        "Su turno terminó con un rechazo: hizo su trabajo.",
        "El ejecutor auditado se reintenta o se escala.",
        false,
      );
    case "closed_idle":
      return explanation(
        "closed_idle",
        "Se cerró por inactividad",
        "El vigilante la cerró porque dejó de avanzar.",
        `${input.task.parentCode ?? "El flujo"} decide si la relanza.`,
        false,
      );
  }
}

export function explainWait(input: WaitInput): WaitExplanation {
  if (input.task.settled !== null) return explainSettled(input.task.settled, input);
  const { state } = input.task;
  switch (state) {
    case "blocked":
      return explainBlocked(input);
    case "pending":
      return explainPending(input);
    case "ready":
      return explainReady(input);
    case "running":
      return explanation(
        "running",
        "Trabajando",
        `Está en el intento ${Math.max(1, input.task.attempt)}${input.task.maxAttempts === null ? "" : ` de ${input.task.maxAttempts}`}.`,
        "El vigilante revisa que siga avanzando.",
        false,
      );
    case "completed":
      return explanation("completed", "Terminada", "Cerró bien.", "Nada más que hacer.", false);
    case "failed":
      return explainFailed(input);
    case "cancelled":
      return explanation(
        "cancelled",
        "Cancelada",
        "Se canceló antes de terminar.",
        "No va a correr: inicia otro flujo si la necesitas.",
        false,
      );
    default: {
      const unexplained: never = state;
      throw new Error(`no explanation for task state ${String(unexplained)}`);
    }
  }
}

export function explainWorkflow(workflow: WaitWorkflowInput): WaitExplanation {
  const { id, state, stopReason } = workflow;
  const reason = (none: string): string => (stopReason === null ? none : `Motivo: ${stopReason}.`);
  switch (state) {
    case "running":
      return explanation(
        "workflow_running",
        "En marcha",
        "Sus agentes están trabajando o en cola.",
        "El runtime los lanza según haya espacio.",
        false,
      );
    case "awaiting_human":
      return explanation(
        "workflow_stop",
        "Detenido, espera tu revisión",
        stopInWords(stopReason),
        continueHint(id),
        true,
      );
    case "completed":
      return explanation(
        "workflow_completed",
        "Terminado",
        "Cerró con todas sus auditorías.",
        "Nada más que hacer.",
        false,
      );
    case "failed":
      return explanation(
        "workflow_failed",
        "Falló",
        reason("Terminó sin un motivo registrado."),
        "Quedó en tus manos: nada lo va a relanzar.",
        true,
      );
    case "stopped":
      return explanation(
        "workflow_stopped",
        "Detenido",
        reason("Se detuvo sin un motivo registrado."),
        "No sigue: inicia otro flujo si lo necesitas.",
        false,
      );
    default: {
      const unexplained: never = state;
      throw new Error(`no explanation for workflow state ${String(unexplained)}`);
    }
  }
}
