import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { validateHarilConfig } from "@haril/contracts";
import { canonicalJson, canTransition, checkAcceptance, checkPlanSubmission } from "@haril/core";
import type {
  Clock,
  EventRecord,
  MetricsSnapshot,
  ProjectRecord,
  RuntimeLeaseSummary,
  Store,
  TaskDetail,
  UsageSummary,
} from "@haril/core/ports";
import { inspectStore, openStore } from "@haril/state-sqlite";
import { readOptionalFile } from "./theme.js";

// Data access of the shell (TUI-D4). The store is opened the way the CLI's openExisting does it: inspect first, and
// an uninitialized data dir gives no store and no file. Only the read facets are used. Nothing here starts the
// runtime, writes a row, polls, or reads a run's files under data/runs/. Provider keys are read from the environment
// only to tell whether they are set; their values never leave this module.

const EVENT_LIMIT = 200;
const DEFAULT_GATEWAY_ID = "cliproxy";
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8317/v1";
const GATEWAY_URL_ENV = "HARIL_GATEWAY_URL";
const GATEWAY_KEY_ENV = "HARIL_CLIPROXYAPI_KEY";

export interface ShellPaths {
  // Undefined when no data dir is known: no store is opened.
  readonly dataDir: string | undefined;
  readonly runtimeRoot: string | undefined;
  readonly configPath: string | undefined;
}

interface ProviderRow {
  readonly id: string;
  readonly baseUrl: string;
  readonly keyEnv: string | undefined;
  // Whether the variable named by keyEnv holds a value. Undefined when the provider needs no key.
  readonly keySet: boolean | undefined;
}

interface ProviderSnapshot {
  // file: haril.json was read; defaults: no file, the built-in gateway applies.
  readonly source: "file" | "defaults";
  readonly error: string | undefined;
  readonly rows: readonly ProviderRow[];
}

interface ProjectMetrics {
  readonly projectId: string;
  readonly slug: string;
  readonly snapshot: MetricsSnapshot;
  readonly usage: UsageSummary | null;
}

export interface ShellSnapshot {
  // False when the data dir has no store: the data panels then show the empty state.
  readonly initialized: boolean;
  // Set when the store exists but could not be opened or read.
  readonly storeError: string | undefined;
  readonly loadedAt: number;
  readonly projects: readonly ProjectRecord[];
  // Every task of every project; the panels filter by the chosen project.
  readonly tasks: readonly TaskDetail[];
  // Newest events for the scope, oldest first.
  readonly events: readonly EventRecord[];
  readonly runtime: RuntimeLeaseSummary;
  // Approvals waiting for a decision, across every project (LD-T3): the banner shows this count.
  readonly pendingApprovals: number;
  readonly metrics: readonly ProjectMetrics[];
  readonly providers: ProviderSnapshot;
  readonly themes: { readonly user: readonly string[] };
}

export interface TaskDetailView {
  readonly detail: TaskDetail;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly unreconciled: number;
  } | null;
  readonly permissionDenials: number;
}

export interface ShellData {
  // Reads everything for the scope (a project id, or undefined for all projects).
  load(scope: string | undefined): ShellSnapshot;
  taskDetail(taskId: string): TaskDetailView | undefined;
  close(): void;
}

export interface OpenShellDataOptions {
  readonly paths: ShellPaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  // Reads a file as text, or undefined when it does not exist. Injected so tests can avoid the disk.
  readonly readFile?: (path: string) => string | undefined;
  // Names of the entries of a directory; empty when it does not exist.
  readonly listFiles?: (dir: string) => readonly string[];
}

export function openShellData(options: OpenShellDataOptions): ShellData {
  const now = options.now ?? (() => Date.now());
  const readFile = options.readFile ?? readOptionalFile;
  const listFiles = options.listFiles ?? listDirectory;
  const { paths, env } = options;
  const clock: Clock = {
    now,
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
  };

  let store: Store | undefined;
  let initialized = false;
  let storeError: string | undefined;
  if (paths.dataDir !== undefined) {
    try {
      initialized = inspectStore({ dataDir: paths.dataDir }).initialized;
      if (initialized) {
        store = openStore({
          dataDir: paths.dataDir,
          clock,
          ids: { next: () => randomUUID() },
          rules: { canTransition, checkPlan: checkPlanSubmission, checkAcceptance, canonicalJson },
          isPidAlive: defaultPidAlive,
        });
      }
    } catch (error) {
      storeError = messageOf(error);
    }
  }

  const themes = (): { readonly user: readonly string[] } => ({
    user:
      paths.runtimeRoot === undefined
        ? []
        : listFiles(join(paths.runtimeRoot, "config", "themes"))
            .filter((name) => name.endsWith(".json"))
            .map((name) => name.slice(0, -".json".length))
            .sort(),
  });

  return {
    load(scope) {
      const providers = readProviders(paths.configPath, env, readFile);
      const base = {
        initialized,
        storeError,
        loadedAt: now(),
        projects: [],
        tasks: [],
        events: [],
        runtime: { status: "none" } as const,
        pendingApprovals: 0,
        metrics: [],
        providers,
        themes: themes(),
      };
      const open = store;
      if (open === undefined) return base;
      try {
        const projects = open.projects.list();
        const tasks = open.tasks
          .list()
          .map((task) => open.tasks.get(task.taskId))
          .filter((task): task is TaskDetail => task !== undefined);
        return {
          ...base,
          projects,
          tasks,
          events: open.events.list({ projectId: scope, limit: EVENT_LIMIT }),
          runtime: open.runtime.leaseSummary(),
          pendingApprovals: open.approvals.list({ status: "requested" }).length,
          metrics: projects.map((project) => ({
            projectId: project.projectId,
            slug: project.slug,
            snapshot: open.metrics.snapshot(project.projectId),
            usage: open.budgets.usageSummary({ projectId: project.projectId }),
          })),
        };
      } catch (error) {
        return { ...base, storeError: messageOf(error) };
      }
    },
    taskDetail(taskId) {
      const open = store;
      if (open === undefined) return undefined;
      const detail = open.tasks.get(taskId);
      if (detail === undefined) return undefined;
      const usage = open.budgets.usageSummary({ taskId });
      const permissionDenials = open.events
        .list({ taskId })
        .filter((event) => event.type === "security.pathguard.denied").length;
      return {
        detail,
        tokens:
          usage === null
            ? null
            : {
                input: usage.inputTokens,
                output: usage.outputTokens,
                unreconciled: usage.unreconciled,
              },
        permissionDenials,
      };
    },
    close() {
      store?.close();
      store = undefined;
    },
  };
}

// The providers in effect (the same rules as haril models): haril.json when it exists, else the built-in gateway.
function readProviders(
  configPath: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string | undefined,
): ProviderSnapshot {
  const text = configPath === undefined ? undefined : readFile(configPath);
  if (text === undefined) return readProvidersDefaults(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { source: "file", error: "the file is not valid JSON", rows: [] };
  }
  // The same rules as the CLI (TUI-D14): ui is allowed, and a file without providers gives the built-in defaults.
  if (!isRecord(parsed))
    return { source: "file", error: "the file is not a JSON object", rows: [] };
  const unknownKeys = Object.keys(parsed).filter((key) => key !== "providers" && key !== "ui");
  if (unknownKeys.length > 0) {
    return {
      source: "file",
      error: unknownKeys.map((key) => `/${key}: unknown key`).join("; "),
      rows: [],
    };
  }
  if (!("providers" in parsed)) return readProvidersDefaults(env);
  const checked = validateHarilConfig({ providers: parsed.providers });
  if (!checked.ok) return { source: "file", error: checked.errors.join("; "), rows: [] };
  return {
    source: "file",
    error: undefined,
    rows: checked.config.providers.map((entry) =>
      providerRow(entry.id, entry.baseUrl, entry.keyEnv, env),
    ),
  };
}

function readProvidersDefaults(
  env: Readonly<Record<string, string | undefined>>,
): ProviderSnapshot {
  const url = nonEmpty(env[GATEWAY_URL_ENV]) ?? DEFAULT_GATEWAY_URL;
  return {
    source: "defaults",
    error: undefined,
    rows: [providerRow(DEFAULT_GATEWAY_ID, url, GATEWAY_KEY_ENV, env)],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerRow(
  id: string,
  baseUrl: string,
  keyEnv: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): ProviderRow {
  return {
    id,
    baseUrl,
    keyEnv,
    keySet: keyEnv === undefined ? undefined : nonEmpty(env[keyEnv]) !== undefined,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function listDirectory(dir: string): readonly string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Liveness of a lease holder, as the CLI checks it. EPERM means the process exists but belongs to another user.
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
