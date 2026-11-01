import type {
  FactoryAgent,
  FactoryEvent,
  FactoryHumanRequest,
  FactoryModel,
  FactoryQuota,
  FactoryQuotaReading,
  FactoryTask,
  FactoryWorkflow,
} from "../src/factory-types.js";
import type { WaitExplanation } from "../src/orchestration-types.js";

// A FactoryModel as haril factory watch prints it, for the factory's tests: a workflow stopped at after_plan and one that
// failed, with a task in each column.

export const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function explanation(overrides: Partial<WaitExplanation> = {}): WaitExplanation {
  return {
    code: "running",
    what: "Trabajando",
    why: "Está en el intento 1.",
    systemAction: "El vigilante revisa que siga avanzando.",
    needsHuman: false,
    until: null,
    ...overrides,
  };
}

const STOPPED = explanation({
  code: "ready_stopped",
  what: "Detenida por una parada del flujo",
  why: "Se detuvo en la parada after_plan: el plan ya está hecho.",
  systemAction:
    "No arranca solo: ejecuta `haril workflow continue wf-stop` o pulsa c en la fábrica.",
  needsHuman: true,
});

export function workflow(overrides: Partial<FactoryWorkflow> = {}): FactoryWorkflow {
  return {
    id: "wf-stop",
    projectSlug: "demo",
    goal: "Ship the checkout",
    state: "awaiting_human",
    stopReason: "after_plan",
    explanation: STOPPED,
    startedAt: NOW - 30 * MINUTE,
    elapsedMs: 30 * MINUTE,
    tokensUsed: 123_456,
    tokensBudget: 200_000,
    agentsCreated: 5,
    agentsCap: 20,
    closedTasks: 1,
    totalTasks: 5,
    criteria: { passed: 3, total: 4 },
    ...overrides,
  };
}

export function task(overrides: Partial<FactoryTask> = {}): FactoryTask {
  return {
    id: "t-1",
    workflowId: "wf-stop",
    title: "Build the cart",
    state: "running",
    column: "en_curso",
    role: "executor",
    agent: "e1",
    delegatedBy: "d1",
    returnedTo: null,
    model: "fake/mid",
    attempts: 1,
    maxAttempts: 3,
    context: { used: 42_000, threshold: 100_000 },
    tokens: 12_345,
    criteria: null,
    explanation: explanation(),
    closedAt: null,
    updatedAt: NOW - MINUTE,
    ...overrides,
  };
}

function agentOf(row: FactoryTask, depth: number): FactoryAgent {
  return {
    workflowId: row.workflowId,
    code: row.agent,
    role: row.role,
    status: row.state,
    taskId: row.id,
    task: row.title,
    model: row.model,
    tokens: row.tokens,
    elapsedMs: 63_000,
    context: row.context,
    parent: row.delegatedBy,
    depth,
    waitingFor: [],
  };
}

export const TASKS: readonly FactoryTask[] = [
  task({
    id: "t-o1",
    agent: "o1",
    role: "orchestrator",
    delegatedBy: null,
    title: "Ship the checkout",
    state: "pending",
    column: "detenidas",
    explanation: STOPPED,
    tokens: 1_000,
    context: null,
  }),
  task({
    id: "t-d1",
    agent: "d1",
    role: "delegator",
    delegatedBy: "o1",
    title: "Plan the cart part",
    column: "hechas",
    state: "completed",
    closedAt: NOW - 20 * MINUTE,
    explanation: explanation({ code: "completed", what: "Terminada", why: "Cerró bien." }),
    tokens: 2_000,
    criteria: { passed: 2, total: 2 },
  }),
  task({ id: "t-e1", agent: "e1" }),
  task({
    id: "t-e2",
    agent: "e2",
    title: "Write the tax rules",
    state: "failed",
    column: "errores",
    returnedTo: "d1",
    explanation: explanation({
      code: "failed",
      what: "Falló",
      why: "Su último intento falló: agent.timeout.",
      systemAction: "Se le devolvió a d1, que decide qué hacer.",
    }),
    criteria: { passed: 1, total: 2 },
    tokens: 777,
  }),
  task({
    id: "t-e3",
    agent: "e3",
    title: "Add the receipts",
    state: "ready",
    column: "por_hacer",
    explanation: explanation({
      code: "ready_next",
      what: "Lista para arrancar",
      why: "Nada la detiene.",
      systemAction: "Arranca en el próximo ciclo del runtime.",
    }),
    tokens: 0,
    context: null,
  }),
];

const APPROVAL: FactoryHumanRequest = {
  kind: "approval",
  id: "ap-1",
  workflowId: null,
  projectSlug: "demo",
  title: "Plan de 2 tareas: Do it",
  explanation: explanation({
    code: "approval_requested",
    what: "Un plan espera tu aprobación",
    why: "Se propuso un plan de 2 tareas.",
    systemAction: "Pulsa a o d.",
    needsHuman: true,
  }),
  at: NOW - 2 * MINUTE,
};

const STOP: FactoryHumanRequest = {
  kind: "stop",
  id: "wf-stop",
  workflowId: "wf-stop",
  projectSlug: "demo",
  title: "Ship the checkout",
  explanation: STOPPED,
  at: NOW - 3 * MINUTE,
};

const EVENTS: readonly FactoryEvent[] = [
  {
    at: NOW - 5 * MINUTE,
    type: "run.started",
    text: "attempt=1",
    workflowId: "wf-stop",
    agent: "e1",
  },
  {
    at: NOW - 3 * MINUTE,
    type: "workflow.awaiting_human",
    text: "reason=after_plan",
    workflowId: "wf-stop",
    agent: null,
  },
];

const HOUR = 60 * MINUTE;

function apiReading(pct: number, resetIn: number): FactoryQuotaReading {
  return {
    pct,
    resetsAt: NOW + resetIn,
    source: "api",
    readAt: NOW - 3 * MINUTE,
    stale: false,
    state: null,
    estimatedTokens: null,
  };
}

// An account with two pools, one spent; another the provider cannot read, estimated from the usage log; and one whose
// provider does not report usage.
export const QUOTA: FactoryQuota = {
  accounts: [
    {
      id: "acct-aaa",
      provider: "cliproxy",
      label: "Anti1",
      kind: "antigravity",
      plan: "ultra",
      state: "Gemini: Evitada: pasó el 80 % de su ventana de 5 horas · Claude and GPT: Disponible",
      groups: [
        {
          name: "Gemini",
          models: ["gemini-3.8-flash"],
          state: "Evitada: pasó el 80 % de su ventana de 5 horas",
          window5h: apiReading(90, HOUR),
          weekly: apiReading(40, 24 * HOUR),
        },
        {
          name: "Claude and GPT",
          models: ["claude-opus-4-6-thinking", "gpt-6.1-sol"],
          state: "Disponible",
          window5h: apiReading(5, 2 * HOUR),
          weekly: {
            pct: null,
            resetsAt: null,
            source: "none",
            readAt: null,
            stale: false,
            state: "No aplica",
            estimatedTokens: null,
          },
        },
      ],
      successes: 12,
      failures: 1,
      holders: ["e1"],
      cachedTokens: 4_000,
      inputTokens: 10_000,
      readAt: NOW - 3 * MINUTE,
    },
    {
      id: "usage:cliproxy/Cl1",
      provider: "cliproxy",
      label: "Cl1",
      kind: null,
      plan: null,
      state: "Sin dato",
      groups: [
        {
          name: null,
          models: ["claude-sonnet-4-6"],
          state: "Sin dato",
          window5h: {
            pct: null,
            resetsAt: null,
            source: "estimated",
            readAt: null,
            stale: false,
            state: "Sin lectura: falta la clave de gestión",
            estimatedTokens: 12_300,
          },
          weekly: {
            pct: 55,
            resetsAt: NOW + 48 * HOUR,
            source: "api",
            readAt: NOW - 2 * HOUR,
            stale: true,
            state: "Sin lectura: el servidor de gestión no responde",
            estimatedTokens: null,
          },
        },
      ],
      successes: 0,
      failures: 0,
      holders: [],
      cachedTokens: null,
      inputTokens: 900,
      readAt: null,
    },
    {
      id: "acct-ccc",
      provider: "cliproxy",
      label: "Grok",
      kind: "xai",
      plan: null,
      state: "Sin dato",
      groups: [
        {
          name: null,
          models: [],
          state: "Sin dato",
          window5h: {
            pct: null,
            resetsAt: null,
            source: "none",
            readAt: null,
            stale: false,
            state: "El proveedor no permite ver este dato",
            estimatedTokens: null,
          },
          weekly: {
            pct: null,
            resetsAt: null,
            source: "none",
            readAt: null,
            stale: false,
            state: "El proveedor no permite ver este dato",
            estimatedTokens: null,
          },
        },
      ],
      successes: 0,
      failures: 0,
      holders: [],
      cachedTokens: null,
      inputTokens: 0,
      readAt: NOW - 3 * MINUTE,
    },
  ],
  unread: [{ provider: "other", state: "Sin lectura: falta la clave de gestión" }],
  thresholds: { switchAt5h: 80, stopAtWeekly: 80, warnPct: 70, dangerPct: 90 },
  history: [
    {
      key: "acct-aaa#Gemini",
      label: "Anti1 Gemini",
      points: [
        { at: NOW - 3 * HOUR, pct: 30 },
        { at: NOW - 2 * HOUR, pct: 55 },
        { at: NOW - HOUR, pct: 85 },
        { at: NOW, pct: 90 },
      ],
    },
  ],
};

export function model(overrides: Partial<FactoryModel> = {}): FactoryModel {
  return {
    schemaVersion: 1,
    generatedAt: NOW,
    project: "demo",
    workflows: [workflow()],
    tasks: TASKS,
    agents: TASKS.map((row) =>
      agentOf(row, row.delegatedBy === null ? 0 : row.agent === "d1" ? 1 : 2),
    ),
    edges: [
      { workflowId: "wf-stop", parent: "o1", child: "d1" },
      { workflowId: "wf-stop", parent: "d1", child: "e1" },
    ],
    events: EVENTS,
    handoffs: [],
    quota: QUOTA,
    humanRequests: [APPROVAL, STOP],
    ...overrides,
  };
}
