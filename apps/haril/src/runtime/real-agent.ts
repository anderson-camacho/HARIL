import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BridgeOperationEvent,
  createPiAgentRuntime,
  type PiAgentHandle,
  type PiAgentRuntimeOptions,
} from "@haril/agent-pi";
import type {
  AgentHandle,
  AgentOutcome,
  AgentRuntime,
  AgentSpec,
  Clock,
  HarilError,
  Result,
  Store,
} from "@haril/core/ports";
import type { Broker } from "@haril/gateway";
import { startHarilBroker } from "../broker.js";
import type { HostInfo, RuntimeInspection } from "../context.js";
import { GATEWAY_KEY_ENV, GATEWAY_URL_ENV, gatewaySettings } from "../gateway.js";
import { readRuntime, runtimeRootFor } from "../runtime.js";

// The real lane of `haril start` (M2-T6, M2-D1..D7): the analyst agent runs in Pi 1.2.0 on the isolated Node,
// talks to the model only through one Broker, and holds one virtual key per run. This module is composition:
// it reads the environment and the runtime manifest, starts one Broker lazily and records run events. It never
// stores, logs or prints the gateway key or a virtual key.

// Test-only seam (M2-T6): a script run with the current Node instead of the isolated Pi. It also skips the
// manifest and INV-19 checks. Nothing in a real setup sets it.
const PI_CLI_OVERRIDE_ENV = "HARIL_PI_CLI_OVERRIDE";
const PROJECT_TOKEN_BUDGET = 1_000_000; // M2-D5
const KEY_GRACE_MS = 30_000;
const UPSTREAM_TIMEOUT_MS = 120_000;
const RUNS_DIR = "runs";
const BRIDGE_FILE = join("integrations", "agent-pi-bridge", "dist", "bridge.mjs");
const BRIDGE_SEARCH_DEPTH = 6;

interface RealAgentPaths {
  readonly nodePath: string;
  readonly piCliPath: string;
  readonly bridgePath: string;
}

// Setup problems read as `needs setup (<what>: <fix>)`; `what` names the missing piece, `fix` says how to add it.
export type RealAgentReadiness =
  | { readonly ok: true; readonly paths: RealAgentPaths }
  | { readonly ok: false; readonly what: string; readonly fix: string };

export interface RealAgents {
  readonly readiness: () => RealAgentReadiness;
  readonly runtime: AgentRuntime;
  // Stops the Broker when one was started. Idempotent.
  readonly close: () => Promise<void>;
}

export interface RealAgentsOptions {
  readonly host: HostInfo;
  readonly store: Store;
  readonly clock: Clock;
  readonly dataDir: string;
}

export function createRealAgents(options: RealAgentsOptions): RealAgents {
  const { host, store, clock } = options;
  const dataDir = resolve(options.dataDir);
  let brokerStart: Promise<Broker> | undefined;

  // One Broker per `haril start`, on the first real task (M2-T6): the upstream is the OpenAI-compatible gateway.
  function ensureBroker(): Promise<Broker> {
    if (brokerStart === undefined) {
      const settings = gatewaySettings(host);
      brokerStart = startHarilBroker({
        store,
        clock,
        gateway: {
          baseUrl: settings.url,
          apiKey: settings.apiKey,
          timeoutMs: UPSTREAM_TIMEOUT_MS,
        },
      });
    }
    return brokerStart;
  }

  const runtime: AgentRuntime = {
    async start(spec: AgentSpec): Promise<Result<AgentHandle, HarilError>> {
      const ready = readinessOf(host);
      if (!ready.ok) {
        return {
          ok: false,
          error: { code: "agent.not_ready", message: `${ready.what}: ${ready.fix}` },
        };
      }
      if (
        spec.model === undefined ||
        spec.projectId === undefined ||
        spec.maxTokens === undefined ||
        spec.maxTokens < 1
      ) {
        return {
          ok: false,
          error: {
            code: "agent.invalid_spec",
            message: "a real agent needs a model, a project and a token ceiling",
          },
        };
      }
      const projectId = spec.projectId;
      const project = store.projects.list().find((candidate) => candidate.projectId === projectId);
      if (project === undefined) {
        return {
          ok: false,
          error: { code: "agent.invalid_spec", message: "the task's project is not registered" },
        };
      }

      let activeBroker: Broker;
      try {
        activeBroker = await ensureBroker();
      } catch {
        return {
          ok: false,
          error: { code: "agent.gateway_failed", message: "the Broker did not start" },
        };
      }

      const projectBudget = store.budgets.ensure({
        scopeType: "project",
        scopeId: projectId,
        projectId,
        hardLimit: PROJECT_TOKEN_BUDGET,
      });
      const taskBudget = store.budgets.ensure({
        scopeType: "task",
        scopeId: spec.taskId,
        projectId,
        hardLimit: spec.maxTokens,
      });
      const virtualKey = activeBroker.issueKey({
        runId: spec.runId,
        taskId: spec.taskId,
        projectId,
        models: [spec.model],
        maxTokensPerRequest: spec.maxTokens,
        budgetIds: [projectBudget.budgetId, taskBudget.budgetId],
        ttlMs: spec.timeoutMs + KEY_GRACE_MS,
      });

      const piOptions: PiAgentRuntimeOptions = {
        nodePath: ready.paths.nodePath,
        piCliPath: ready.paths.piCliPath,
        bridgePath: ready.paths.bridgePath,
        brokerUrl: activeBroker.url,
        projectRoot: resolve(project.rootPath),
        runsDir: join(dataDir, RUNS_DIR),
        model: spec.model,
        virtualKey,
        onBridgeOperation: (event) => recordBridgeOperation(store, spec, event),
      };
      const started = await createPiAgentRuntime(piOptions).start(spec);
      if (!started.ok) {
        activeBroker.revokeRun(spec.runId);
        return started;
      }
      recordEvent(store, spec, "run.started", { agentRuntime: "pi" });
      return { ok: true, value: wrapHandle(started.value, spec, activeBroker, store) };
    },
  };

  return {
    readiness: () => readinessOf(host),
    runtime,
    async close(): Promise<void> {
      if (brokerStart === undefined) return;
      try {
        await (await brokerStart).close();
      } catch {
        // The Broker never started, or it is already closed: nothing left to release.
      }
    },
  };
}

// What a real run needs before a task is claimed (M2-T6): the isolated runtime, the bridge and the gateway key.
function readinessOf(host: HostInfo): RealAgentReadiness {
  const env = host.env ?? {};
  const bridge = findBridge();
  const override = nonEmpty(env[PI_CLI_OVERRIDE_ENV]);
  let paths: RealAgentPaths;
  if (override !== undefined) {
    paths = { nodePath: process.execPath, piCliPath: override, bridgePath: bridge ?? override };
  } else {
    const inspection = (host.inspectRuntime ?? readRuntime)(runtimeRootFor(host), host.platform);
    const setup = runtimeSetupProblem(inspection, bridge);
    if (setup !== undefined) return setup;
    paths = {
      nodePath: inspection.node?.path ?? "",
      piCliPath: inspection.pi?.cliPath ?? "",
      bridgePath: bridge ?? "",
    };
  }
  const gateway = gatewaySettings(host);
  if (!gateway.urlValid) {
    return {
      ok: false,
      what: `${GATEWAY_URL_ENV} is not a valid URL`,
      fix: "use an http or https URL",
    };
  }
  if (gateway.apiKey === undefined) {
    return {
      ok: false,
      what: `${GATEWAY_KEY_ENV} is not set`,
      fix: "set it to your CLIProxyAPI client key",
    };
  }
  return { ok: true, paths };
}

function runtimeSetupProblem(
  inspection: RuntimeInspection,
  bridge: string | undefined,
): RealAgentReadiness | undefined {
  if (inspection.status !== "ok" || inspection.node === undefined || inspection.pi === undefined) {
    return { ok: false, what: "Pi runtime is not installed", fix: "run npm run runtime:install" };
  }
  if (!satisfiesPiNodeRange(inspection.node.version)) {
    return {
      ok: false,
      what: `isolated Node ${inspection.node.version} is below the Pi minimum`,
      fix: "run npm run runtime:install",
    };
  }
  if (bridge === undefined) {
    return { ok: false, what: "the agent-pi bridge is not built", fix: "run npm run build:bridge" };
  }
  return undefined;
}

// INV-19 for the Pi path (M2-D2): ^24.21.0 || >=26.8.0.
function satisfiesPiNodeRange(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 24 && minor >= 21) || major > 26 || (major === 26 && minor >= 8);
}

function findBridge(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth <= BRIDGE_SEARCH_DEPTH; depth++) {
    const candidate = join(dir, BRIDGE_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// The handle reports the run's events and closes its virtual key when it is disposed (M2-T6).
function wrapHandle(
  handle: AgentHandle,
  spec: AgentSpec,
  broker: Broker,
  store: Store,
): AgentHandle {
  const diagnostics = (handle as Partial<PiAgentHandle>).diagnostics;
  return {
    runId: handle.runId,
    hello: handle.hello.then((hello) => {
      recordEvent(store, spec, "run.handshake.ok", { tools: [...hello.tools] });
      return hello;
    }),
    settled: handle.settled.then((outcome): AgentOutcome => {
      const final: AgentOutcome =
        outcome.status === "succeeded"
          ? { ...outcome, model: spec.model, warnings: [...(diagnostics?.warnings ?? [])] }
          : outcome;
      recordEvent(store, spec, "run.settled", {
        status: final.status,
        ...(final.status === "failed" ? { code: final.code } : {}),
      });
      return final;
    }),
    prompt: (text) => handle.prompt(text),
    abort: () => handle.abort(),
    dispose: async () => {
      try {
        await handle.dispose();
      } finally {
        broker.revokeRun(spec.runId);
      }
    },
  };
}

// Run events carry identifiers and counts only: never prompts, replies, file content or keys (M2-T6).
function recordEvent(
  store: Store,
  spec: AgentSpec,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): void {
  try {
    store.events.append({
      aggregateType: "run",
      aggregateId: spec.runId,
      type,
      actorKind: "system",
      actorId: "runtime",
      payload,
      projectId: spec.projectId,
      taskId: spec.taskId,
      runId: spec.runId,
      agentId: spec.agentRef,
    });
  } catch {
    // The event log describes the run; a failed write must not change its outcome.
  }
}

function recordBridgeOperation(store: Store, spec: AgentSpec, event: BridgeOperationEvent): void {
  recordEvent(store, spec, `tool.${event.op}`, {
    pathSha256: event.pathSha256,
    outcome: event.outcome,
  });
}
