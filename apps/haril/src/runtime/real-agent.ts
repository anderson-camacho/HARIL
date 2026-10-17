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
  PlanProposer,
  Result,
  Store,
} from "@haril/core/ports";
import type { Broker } from "@haril/gateway";
import { startHarilBroker } from "../broker.js";
import type { HostInfo, RuntimeInspection } from "../context.js";
import {
  bareModelOf,
  loadProviderConfig,
  MODELS_TIMEOUT_MS,
  type ProviderEntry,
  resolveModelRef,
} from "../providers.js";
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
  | {
      readonly ok: true;
      readonly paths: RealAgentPaths;
      // The providers of this run: a task's model is checked against them before its claim (M3-T7).
      readonly providers: readonly ProviderEntry[];
    }
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
  // The host handler of haril_propose_plan (LD-T4), the one the hermetic lane gets, so both lanes share one attempt
  // window. Without it, the bridge's plan.propose is unsupported and a planner task cannot propose.
  readonly proposePlan?: PlanProposer;
}

export function createRealAgents(options: RealAgentsOptions): RealAgents {
  const { host, store, clock } = options;
  const dataDir = resolve(options.dataDir);
  let brokerStart: Promise<Broker> | undefined;

  // One Broker per `haril start`, on the first real task (M2-T6): the upstream is the OpenAI-compatible gateway.
  // One upstream per configured provider (M3-T7); the providers are read once per run.
  function ensureBroker(providers: readonly ProviderEntry[]): Promise<Broker> {
    if (brokerStart === undefined) {
      brokerStart = startHarilBroker({ store, clock, providers, timeoutMs: UPSTREAM_TIMEOUT_MS });
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
        // The refusal names only what this spec lacks (LD-T7a): a plan task can inherit a model and still have no
        // token ceiling.
        return {
          ok: false,
          error: {
            code: "agent.invalid_spec",
            message: `a real agent needs ${listed(missingSpecParts(spec))}`,
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

      // M3-T7: the task's model names its provider (or resolves to exactly one); that provider's key must be set.
      const loaded = loadProviderConfig(host);
      if (!loaded.ok) {
        return {
          ok: false,
          error: {
            code: "agent.not_ready",
            message: `${loaded.path}: ${loaded.errors.join("; ")}`,
          },
        };
      }
      const resolved = await resolveModelRef(spec.model, loaded.providers, MODELS_TIMEOUT_MS);
      if (!resolved.ok) {
        return { ok: false, error: { code: resolved.code, message: resolved.message } };
      }
      const provider = loaded.providers.find((entry) => entry.id === resolved.providerId);
      if (provider === undefined) {
        return {
          ok: false,
          error: { code: "agent.not_ready", message: "the provider is unknown" },
        };
      }
      if (provider.keyEnv !== undefined && provider.credential === undefined) {
        return {
          ok: false,
          error: {
            code: "agent.not_ready",
            message: `${provider.keyEnv} is not set (provider ${provider.id}): set it to the provider's key`,
          },
        };
      }
      // Pi and the virtual key get the bare id the upstream knows; the grant keeps providerId, and the Broker routes
      // by it. The namespaced ref stays on the spec, so results and metrics show <provider>/<model>.
      // UNVERIFIED: a bare id that itself contains "/" (for example OpenRouter's openai/gpt-4o) is not checked
      // against Pi 1.2.0, which may parse provider/model itself. bareModelOf keeps such an id whole here, but the
      // Broker's resolver strips a leading <provider>/ again, so the risk stays open until Pi is verified.
      const runModel: string = bareModelOf(resolved.ref, provider.id);
      const runSpec: AgentSpec = { ...spec, model: resolved.ref };

      let activeBroker: Broker;
      try {
        activeBroker = await ensureBroker(loaded.providers);
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
        providerId: provider.id,
        models: [runModel],
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
        model: runModel,
        virtualKey,
        onBridgeOperation: (event) => recordBridgeOperation(store, spec, event),
        ...(options.proposePlan === undefined ? {} : { proposePlan: options.proposePlan }),
      };
      const started = await createPiAgentRuntime(piOptions).start(runSpec);
      if (!started.ok) {
        activeBroker.revokeRun(runSpec.runId);
        return started;
      }
      recordEvent(store, runSpec, "run.started", { agentRuntime: "pi" });
      return { ok: true, value: wrapHandle(started.value, runSpec, activeBroker, store) };
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

// What a real agent's spec lacks, in the order the refusal names them.
function missingSpecParts(spec: AgentSpec): string[] {
  return [
    ...(spec.model === undefined ? ["a model"] : []),
    ...(spec.projectId === undefined ? ["a project"] : []),
    ...(spec.maxTokens === undefined || spec.maxTokens < 1
      ? ["a token ceiling (budget.maxTokens of at least 1)"]
      : []),
  ];
}

// "a", "a and b", "a, b and c".
function listed(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// What a real run needs before a task is claimed (M2-T6): the isolated runtime, the bridge and a valid provider file.
// A task's model and its provider key are checked before its claim (run-loop, M3-T7) and again at start.
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
  const providers = loadProviderConfig(host);
  if (!providers.ok) {
    return {
      ok: false,
      what: `${providers.path} is not a valid provider file`,
      fix: providers.errors.join("; "),
    };
  }
  return { ok: true, paths, providers: providers.providers };
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

// A PathGuard denial is a permission event (criterion 12): the path is hashed, never recorded.
// A plan proposal (LD-T4) is tool.plan.propose with the plan's hash and size and the approval it became, never the plan.
// Every other bridge operation keeps its tool.<op> record.
function recordBridgeOperation(store: Store, spec: AgentSpec, event: BridgeOperationEvent): void {
  if (event.outcome === "path_denied") {
    recordEvent(store, spec, "security.pathguard.denied", {
      tool: event.op,
      reason: event.reason ?? "unknown",
      pathHash: event.pathSha256,
    });
    return;
  }
  // A plan proposal keeps its fingerprint, the approval it became, or the capped reason it was refused (LD-T7c).
  if (event.planSha256 !== undefined) {
    recordEvent(store, spec, `tool.${event.op}`, {
      outcome: event.outcome,
      planSha256: event.planSha256,
      planBytes: event.planBytes ?? 0,
      ...(event.approvalId === undefined ? {} : { approvalId: event.approvalId }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    });
    return;
  }
  recordEvent(store, spec, `tool.${event.op}`, {
    pathSha256: event.pathSha256,
    outcome: event.outcome,
  });
}
