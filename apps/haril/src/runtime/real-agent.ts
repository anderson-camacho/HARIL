import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BridgeOperationEvent,
  CLAUDE_BRIDGE_PROVIDER,
  type ClaudeBridgeLaunch,
  createPiAgentRuntime,
  type ModelUsage,
  type PiAgentHandle,
  type PiAgentRuntimeOptions,
} from "@haril/agent-pi";
import { compactAtFor, type DelegationLayer, type DelegationSettings } from "@haril/contracts";
import type {
  AgentHandle,
  AgentOutcome,
  AgentProcess,
  AgentRuntime,
  AgentSpec,
  Clock,
  DelegationToolHandler,
  HarilError,
  PlanProposer,
  Result,
  Store,
} from "@haril/core/ports";
import type { Broker, UpstreamFailure } from "@haril/gateway";
import { createProcessControl } from "@haril/os";
import { startHarilBroker } from "../broker.js";
import type { HostInfo, RuntimeInspection } from "../context.js";
import { loadDelegationSettings } from "../delegation-config.js";
import { delegationSettingsOf } from "../delegation-section.js";
import {
  bareModelOf,
  loadProviderConfig,
  MODELS_TIMEOUT_MS,
  type ModelProblem,
  modelProblemOf,
  type ProviderEntry,
  resolveModelRef,
} from "../providers.js";
import { findPayloadFile, readRuntime, runtimeRootFor } from "../runtime.js";
import {
  CLAUDE_BRIDGE_PREFIX,
  type ClaudeBridgeInstall,
  type ClaudeBridgeLookup,
  claudeBridgeProblem,
  findClaudeBridge,
  isClaudeBridgeRef,
} from "./claude-bridge.js";
import type { ModelFacts } from "./live-models.js";
import { killTrees } from "./processes.js";
import { outcomeWithProvider } from "./provider-failure.js";

// The real lane of `haril start` (M2-T6, M2-D1..D7): the analyst agent runs in Pi 1.2.0 on the isolated Node,
// talks to the model only through one Broker, and holds one virtual key per run. This module is composition:
// it reads the environment and the runtime manifest, starts one Broker lazily and records run events. It never
// stores, logs or prints the gateway key or a virtual key.

// Test-only seam (M2-T6): a script run with the current Node instead of the isolated Pi. It also skips the
// manifest and INV-19 checks. Nothing in a real setup sets it.
const PI_CLI_OVERRIDE_ENV = "HARIL_PI_CLI_OVERRIDE";
const KEY_GRACE_MS = 30_000;
const UPSTREAM_TIMEOUT_MS = 120_000;
const RUNS_DIR = "runs";
const BRIDGE_FILE = join("integrations", "agent-pi-bridge", "dist", "bridge.mjs");

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
      // The pi-claude-bridge extension, or why it cannot serve a claude-bridge model (claude-bridge.ts).
      readonly claudeBridge: ClaudeBridgeLookup;
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
  // The host handler of the delegation tools (phase F2b), the one the fake workflow agents get, so a workflow turn's
  // calls land in the window the run loop opened for it whichever lane runs it. Without it, a real workflow turn's
  // delegation.call is unsupported and the turn cannot decide.
  readonly delegationTools?: DelegationToolHandler;
  // The live catalog's facts of a model (phase F7): its real context window, max output and published levels. Without
  // them, or for a model the catalog does not list, Pi gets the documented fallback limits (launch.ts).
  readonly modelFacts?: (ref: string) => ModelFacts | undefined;
}

// What a Pi agent is launched with beyond its model (docs/modos-y-delegacion.md 3.12, 7.10 item 6; phase F7).
export interface AgentLaunch {
  readonly modelContextWindow?: number;
  readonly modelMaxTokens?: number;
  readonly compactAtTokens: number;
  readonly thinkingLevel?: string;
  readonly modelLevels?: readonly string[];
}

function wholePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// The compaction threshold a workflow kept when it started (P11: haril workflow start snapshots delegation.context with
// the limits), for one layer: its own, else the general one; undefined when the snapshot holds none.
function snapshotCompactAt(limits: unknown, layer: DelegationLayer): number | undefined {
  const context =
    typeof limits === "object" && limits !== null
      ? (limits as Record<string, unknown>).context
      : undefined;
  if (typeof context !== "object" || context === null) return undefined;
  const { compactAtTokens, perLayer } = context as Record<string, unknown>;
  const own =
    typeof perLayer === "object" && perLayer !== null
      ? wholePositive((perLayer as Record<string, unknown>)[layer])
      : undefined;
  return own ?? wholePositive(compactAtTokens);
}

// A run's launch: the catalog's window and output for its model (else the fallback), its layer's compaction threshold
// (the workflow's snapshot, else haril.json's, else 300 000), and for a workflow turn its layer's level with the levels the
// model publishes (unknown levels: none asked for). A task outside a workflow has no layer: the general threshold and no
// level.
export function agentLaunchOf(input: {
  readonly settings: DelegationSettings;
  readonly facts: ModelFacts | undefined;
  readonly layer: DelegationLayer | undefined;
  readonly workflowLimits: unknown;
}): AgentLaunch {
  const { settings, facts, layer } = input;
  const compactAtTokens =
    layer === undefined
      ? settings.context.compactAtTokens
      : (snapshotCompactAt(input.workflowLimits, layer) ?? compactAtFor(settings, layer));
  const level = layer === undefined ? null : settings.models.layers[layer].level;
  return {
    ...(facts?.contextWindow == null ? {} : { modelContextWindow: facts.contextWindow }),
    ...(facts?.maxTokens == null ? {} : { modelMaxTokens: facts.maxTokens }),
    compactAtTokens,
    ...(level === null ? {} : { thinkingLevel: level }),
    ...(level === null || facts === undefined ? {} : { modelLevels: facts.levels }),
  };
}

export function createRealAgents(options: RealAgentsOptions): RealAgents {
  const { host, store, clock } = options;
  const dataDir = resolve(options.dataDir);
  let brokerStart: Promise<Broker> | undefined;
  // The OS side of 3.14: each agent's boot ticks are read right after its spawn (Linux), so a clock step never hides it.
  const processControl = host.processControl ?? createProcessControl();
  // The last upstream failure the Broker heard for each run in flight (3.11): it reaches the run's failed outcome, so the
  // runtime can cool the model down and retry the turn.
  const upstreamFailures = new Map<string, UpstreamFailure>();

  // One Broker per `haril start`, on the first real task (M2-T6): the upstream is the OpenAI-compatible gateway.
  // One upstream per configured provider (M3-T7); the providers are read once per run.
  function ensureBroker(providers: readonly ProviderEntry[]): Promise<Broker> {
    if (brokerStart === undefined) {
      brokerStart = startHarilBroker({
        store,
        clock,
        providers,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        onUpstreamFailure: (failure) => upstreamFailures.set(failure.runId, failure),
      });
    }
    return brokerStart;
  }

  // The project's and the task's token budgets (M2-D5), which every model call of the run is charged to. The project's
  // limit is haril.json's delegation.limits.projectTokens as it is at this launch, also for a budget created before.
  function budgetsOf(spec: AgentSpec, projectId: string, maxTokens: number) {
    const projectTokens = delegationSettings().limits.projectTokens;
    const ensured = store.budgets.ensure({
      scopeType: "project",
      scopeId: projectId,
      projectId,
      hardLimit: projectTokens,
    });
    const projectBudget =
      ensured.hardLimit === projectTokens
        ? ensured
        : store.budgets.setHardLimit(ensured.budgetId, projectTokens);
    const taskBudget = store.budgets.ensure({
      scopeType: "task",
      scopeId: spec.taskId,
      projectId,
      hardLimit: maxTokens,
    });
    return { projectBudget, taskBudget };
  }

  // haril.json's delegation section as it is now; a file the rules refuse gives the defaults.
  function delegationSettings(): DelegationSettings {
    const delegation = loadDelegationSettings(host);
    return delegation.ok ? delegation.settings : delegationSettingsOf(undefined);
  }

  // The run's launch for its layer (3.12, 7.10), with its model's catalog facts when the catalog lists it.
  function launchFor(spec: AgentSpec, facts: ModelFacts | undefined): AgentLaunch {
    return agentLaunchOf({
      settings: delegationSettings(),
      facts,
      layer: spec.delegation?.role,
      workflowLimits:
        spec.delegation === undefined
          ? undefined
          : store.workflows.get(spec.delegation.workflowId)?.limits,
    });
  }

  // What the Pi adapter gets on either lane besides the model: the runtime's paths, the project, the host's handlers and
  // the verified tree kill.
  function piBase(spec: AgentSpec, paths: RealAgentPaths, rootPath: string) {
    return {
      nodePath: paths.nodePath,
      piCliPath: paths.piCliPath,
      bridgePath: paths.bridgePath,
      projectRoot: resolve(rootPath),
      runsDir: join(dataDir, RUNS_DIR),
      onBridgeOperation: (event: BridgeOperationEvent) => recordBridgeOperation(store, spec, event),
      bootStartOf: (pid: number) => processControl.bootStarts?.([pid])?.get(pid),
      // Every kill of the run walks the verified tree (start times checked), never taskkill /T on its own.
      killTree: async (target: AgentProcess): Promise<"killed" | "gone" | "unreadable"> => {
        const result = await killTrees(processControl, [target]);
        if (result === undefined) return "unreadable";
        return result.roots.length > 0 ? "killed" : "gone";
      },
      ...(options.proposePlan === undefined ? {} : { proposePlan: options.proposePlan }),
      ...(options.delegationTools === undefined
        ? {}
        : { delegationTools: options.delegationTools }),
    };
  }

  // What the agent was launched with (3.12, 7.10): its model's window and output and where they came from, the
  // compaction point of its layer and the level Pi runs at (null: the gateway's default level). A claude-bridge run says
  // so; its limits are the extension's own (limitsSource "bridge", null window and output).
  function recordStarted(
    runSpec: AgentSpec,
    handle: AgentHandle,
    source: {
      readonly limitsSource: string;
      readonly compactAtTokens: number;
      readonly lane?: string;
    },
  ): void {
    const launched = (handle as Partial<PiAgentHandle>).diagnostics?.launch;
    recordEvent(store, runSpec, "run.started", {
      agentRuntime: "pi",
      ...(source.lane === undefined ? {} : { lane: source.lane }),
      ...(launched === undefined
        ? {}
        : {
            contextWindow: launched.contextWindow,
            maxTokens: launched.maxTokens,
            limitsSource: source.limitsSource,
            compactAtTokens:
              launched.contextWindow === null
                ? null
                : Math.min(source.compactAtTokens, launched.contextWindow),
            reserveTokens: launched.compactionReserveTokens,
            thinkingLevel: launched.thinkingLevel,
          }),
    });
  }

  // The claude-bridge lane (claude-bridge.ts): Pi runs the bare Claude model id on the extension's provider. No Broker
  // meters the run, so each model call's usage, as Pi reports it, is charged to the budgets afterwards (a reservation of
  // what the budgets still hold, settled with the real count: an overrun goes to the ledger's overrun). Once a budget is
  // spent, a reply that asks for a tool ends the run as insufficient_quota, as the Broker refuses the next request.
  async function startOnClaudeBridge(
    spec: AgentSpec,
    ref: string,
    maxTokens: number,
    paths: RealAgentPaths,
    project: { readonly projectId: string; readonly rootPath: string },
    install: ClaudeBridgeInstall,
  ): Promise<Result<AgentHandle, HarilError>> {
    const { projectBudget, taskBudget } = budgetsOf(spec, project.projectId, maxTokens);
    const budgetIds = [projectBudget.budgetId, taskBudget.budgetId];
    let calls = 0;
    const roomOf = (budgetId: string): number => {
      const budget = store.budgets.get(budgetId);
      return budget === undefined
        ? 0
        : Math.max(0, budget.hardLimit - budget.spent - budget.reserved);
    };
    const charge = (usage: ModelUsage): "ok" | "exhausted" => {
      const spend = usage.inputTokens + usage.outputTokens;
      try {
        const reservation = store.budgets.reserve({
          budgetIds,
          amount: Math.min(spend, ...budgetIds.map(roomOf)),
          idempotencyKey: `claude-bridge:${spec.runId}:${++calls}`,
          runId: spec.runId,
          taskId: spec.taskId,
          routeId: ref,
        });
        if (reservation.ok) {
          store.budgets.commit({
            reservationId: reservation.reservationId,
            usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
            upperBound: spend,
            modelRequested: ref,
            modelServed: ref,
          });
        }
      } catch {
        // The ledger describes the run; a failed write must not change its outcome.
      }
      return budgetIds.some((budgetId) => roomOf(budgetId) === 0) ? "exhausted" : "ok";
    };
    const launch = launchFor(spec, undefined);
    const claudeBridge: ClaudeBridgeLaunch = {
      entryPath: install.entryPath,
      config: install.config,
    };
    const started = await createPiAgentRuntime({
      ...piBase(spec, paths, project.rootPath),
      compactAtTokens: launch.compactAtTokens,
      ...(launch.thinkingLevel === undefined ? {} : { thinkingLevel: launch.thinkingLevel }),
      model: ref.slice(CLAUDE_BRIDGE_PREFIX.length),
      claudeBridge,
      onModelUsage: charge,
    }).start(spec);
    if (!started.ok) return started;
    recordStarted(spec, started.value, {
      lane: CLAUDE_BRIDGE_PROVIDER,
      limitsSource: "bridge",
      compactAtTokens: launch.compactAtTokens,
    });
    return { ok: true, value: wrapHandle(started.value, spec, store, upstreamFailures) };
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

      // The claude-bridge lane (claude-bridge.ts): the extension serves the model, with no provider file, key or Broker.
      if (isClaudeBridgeRef(spec.model)) {
        const lookup = ready.claudeBridge;
        const problem = claudeBridgeProblem(spec.model, lookup);
        if (problem !== undefined) {
          return {
            ok: false,
            error: { code: "agent.not_ready", message: `${problem.what}: ${problem.fix}` },
          };
        }
        // claudeBridgeProblem reports a lookup that failed, so the extension is installed here.
        if (lookup.ok) {
          return startOnClaudeBridge(
            spec,
            spec.model,
            spec.maxTokens,
            ready.paths,
            project,
            lookup,
          );
        }
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

      const { projectBudget, taskBudget } = budgetsOf(spec, projectId, spec.maxTokens);
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

      const launch = launchFor(spec, options.modelFacts?.(resolved.ref));
      const piOptions: PiAgentRuntimeOptions = {
        ...launch,
        ...piBase(spec, ready.paths, project.rootPath),
        brokerUrl: activeBroker.url,
        model: runModel,
        virtualKey,
      };
      const started = await createPiAgentRuntime(piOptions).start(runSpec);
      if (!started.ok) {
        activeBroker.revokeRun(runSpec.runId);
        return started;
      }
      recordStarted(runSpec, started.value, {
        limitsSource: launch.modelContextWindow === undefined ? "fallback" : "catalog",
        compactAtTokens: launch.compactAtTokens,
      });
      return {
        ok: true,
        value: wrapHandle(started.value, runSpec, store, upstreamFailures, activeBroker),
      };
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

// What keeps a real workflow from running on `model` now, the check `haril workflow start --preflight` makes: the
// runtime's own readiness and, for a namespaced model, its provider key, or for a claude-bridge model its id and the
// installed extension. Undefined when nothing does; an empty model is not checked (the card picks it after the preflight
// and checks again). A runtime would leave such a workflow's turns ready and skipped, so it would wait queued for a
// setup nobody is told about.
export function realAgentProblem(host: HostInfo, model: string): ModelProblem | undefined {
  const ready = readinessOf(host);
  if (!ready.ok) return { what: ready.what, fix: ready.fix };
  return model === "" ? undefined : realModelProblem(model, ready);
}

// What the project's token budget (M2-D5) leaves for a turn of `needed` tokens under the limit haril.json sets now, or
// undefined when it is enough. A spent budget ends every real agent at its first tool call, so a workflow started on it
// would fail at once. Reads only: the first launch creates the budget and sets its limit.
export function projectBudgetProblem(
  store: Store,
  projectId: string,
  limit: number,
  needed: number,
): ModelProblem | undefined {
  const budget = store.budgets.find("project", projectId);
  const left = Math.max(0, limit - (budget === undefined ? 0 : budget.spent + budget.reserved));
  if (left >= needed) return undefined;
  return {
    what: `the project's token budget has ${left} of ${limit} tokens left and the orchestrator's turn takes ${needed}`,
    fix: "raise it with haril config set delegation.limits.projectTokens <tokens>",
  };
}

// What stops a real task's model before its claim (M3-T7): the provider key of a namespaced model, or for a
// claude-bridge model its id and the installed extension.
export function realModelProblem(
  model: string | null,
  ready: Extract<RealAgentReadiness, { ok: true }>,
): ModelProblem | undefined {
  return isClaudeBridgeRef(model)
    ? claudeBridgeProblem(model, ready.claudeBridge)
    : modelProblemOf(model, ready.providers);
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
  return { ok: true, paths, providers: providers.providers, claudeBridge: findClaudeBridge(host) };
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
  return findPayloadFile(BRIDGE_FILE, dirname(fileURLToPath(import.meta.url)));
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// The handle reports the run's events and closes its virtual key when it is disposed (M2-T6). A claude-bridge run has
// no Broker and no key.
function wrapHandle(
  handle: AgentHandle,
  spec: AgentSpec,
  store: Store,
  upstreamFailures: Map<string, UpstreamFailure>,
  broker?: Broker,
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
          : outcomeWithProvider(outcome, upstreamFailures.get(spec.runId));
      upstreamFailures.delete(spec.runId);
      recordEvent(store, spec, "run.settled", {
        status: final.status,
        ...(final.status === "failed" ? { code: final.code } : {}),
      });
      return final;
    }),
    // The Pi process and its immediate kill reach the run loop (3.14): it records the process and kills on a stop.
    ...(handle.process === undefined ? {} : { process: handle.process }),
    prompt: (text) => handle.prompt(text),
    abort: () => handle.abort(),
    kill: () => (handle.kill === undefined ? handle.abort() : handle.kill()),
    dispose: async () => {
      try {
        await handle.dispose();
      } finally {
        broker?.revokeRun(spec.runId);
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
// A delegation call (phase F2b) is tool.<its tool> (tool.haril_delegate...) with the input's hash and size and the
// capped reason of a refusal, never the input. Every other bridge operation keeps its tool.<op> record.
function recordBridgeOperation(store: Store, spec: AgentSpec, event: BridgeOperationEvent): void {
  if (event.tool !== undefined) {
    recordEvent(store, spec, `tool.${event.tool === "" ? event.op : event.tool}`, {
      outcome: event.outcome,
      inputSha256: event.inputSha256 ?? "",
      inputBytes: event.inputBytes ?? 0,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    });
    return;
  }
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
