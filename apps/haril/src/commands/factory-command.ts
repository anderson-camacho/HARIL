import {
  type FactoryColumn,
  type FactoryModel,
  HUMAN_REQUEST_KIND,
  type WorkflowSnapshot,
  WRITTEN_ANSWER_PREFIX,
} from "@haril/contracts";
import { type ControlClient, connect } from "@haril/control";
import { visibleText } from "@haril/core";
import type { ProjectRecord, Store, WorkflowTaskRecord } from "@haril/core/ports";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { loadDelegationSettings } from "../delegation-config.js";
import { delegationSettingsOf } from "../delegation-section.js";
import { clockFor, storeAccess } from "../host.js";
import { groupIndex, quotaByKey, quotaKeyFor } from "../quota-view.js";
import { appendAgentMessage } from "../runtime/agent-messages.js";
import { QUOTA_FRESH_MS } from "../runtime/model-context.js";
import { WorkflowView } from "../runtime/workflow-view.js";
import { decidedByOf } from "./approvals.js";
import { dataDirFor, nudgeQueued, openExisting } from "./common.js";
import { buildFactoryModel } from "./factory-model.js";
import { piContextUsed } from "./pi-context.js";
import { EXIT_ON_STDIN_END, onStdinEnd } from "./stdin-end.js";
import { threadsOf } from "./workflow-snapshot.js";

// `haril factory show` prints the factory's read model once; `haril factory watch` prints it as JSON lines for the
// console's factory view: one at once, one on each wake of the runtime's control channel (at most one per
// WAKE_INTERVAL_MS for a burst), and between wakes or without a runtime the store is read every --interval-ms and a line
// printed only when it changed (the clocks aside). Unlike haril workflow watch it follows no single workflow, so nothing
// ends it but Ctrl+C or, with --exit-on-stdin-end, its stdin ending (the console that runs it as a child went away). To
// lift a stop use haril workflow continue: it exists already. It reads the store only.

const USAGE = [
  "usage: haril factory show [--json] [--project <slug>] [--data-dir <path>]",
  "       haril factory watch [--json] [--project <slug>] [--interval-ms <n>] [--exit-on-stdin-end] [--data-dir <path>]",
  '       haril factory message <task> "<text>" [--urgent] [--json] [--data-dir <path>]',
  '       haril factory answer <request> approve|deny|write ["<text>"] [--json] [--data-dir <path>]',
  "       haril factory requests [--json] [--project <slug>] [--model <ref>] [--data-dir <path>]",
].join("\n");
const DEFAULT_INTERVAL_MS = 1_000;
const WAKE_INTERVAL_MS = 250;
const SETTINGS_TTL_MS = 5_000;
const NOT_INITIALIZED =
  "store not initialized (run haril project init <path> --name <name> --yes first)";
const COLUMNS: readonly FactoryColumn[] = [
  "por_hacer",
  "en_curso",
  "detenidas",
  "errores",
  "hechas",
];

function fail(io: CliIo, message: string): number {
  io.err(message.startsWith("usage:") ? message : `haril: ${message}`);
  return EXIT_USAGE;
}

// What makes two models different: everything but the clocks that run while nothing happens.
function fingerprint(model: FactoryModel): string {
  return JSON.stringify({
    ...model,
    generatedAt: 0,
    workflows: model.workflows.map((row) => ({ ...row, elapsedMs: 0 })),
  });
}

function opened(
  parsed: ReturnType<typeof parseArgs>,
  io: CliIo,
  host: HostInfo,
):
  | { readonly store: Store; readonly dataDir: string; readonly project: ProjectRecord | undefined }
  | number {
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = openExisting(host, dataDir);
  if (store === undefined) return fail(io, NOT_INITIALIZED);
  const slug = lastValue(parsed, "--project");
  const project = slug === undefined ? undefined : store.projects.getBySlug(slug);
  if (slug !== undefined && project === undefined) {
    store.close();
    return fail(io, `no project with slug "${slug}"`);
  }
  return { store, dataDir, project };
}

function reader(
  store: Store,
  dataDir: string,
  project: ProjectRecord | undefined,
  host: HostInfo,
): (now: number) => FactoryModel {
  const endedSnapshots = new Map<string, WorkflowSnapshot>();
  // haril.json is user-edited, and an invalid one leaves the defaults in effect, as for the runtime.
  let settings: { value: ReturnType<typeof delegationSettingsOf>; at: number } | undefined;
  const settingsAt = (now: number) => {
    if (settings === undefined || now - settings.at > SETTINGS_TTL_MS) {
      const loaded = loadDelegationSettings(host);
      settings = { value: loaded.ok ? loaded.settings : delegationSettingsOf(undefined), at: now };
    }
    return settings.value;
  };
  return (now) =>
    buildFactoryModel(store, {
      now,
      ...(project === undefined ? {} : { project }),
      contextUsedOf: (runId) => piContextUsed(dataDir, runId),
      endedSnapshots,
      settings: settingsAt(now),
    });
}

function factoryShow(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--project", "--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) return fail(io, USAGE);
  const open = opened(parsed, io, host);
  if (typeof open === "number") return open;
  try {
    const model = reader(open.store, open.dataDir, open.project, host)(clockFor(host).now());
    if (parsed.flags.has("--json")) {
      io.out(JSON.stringify(model));
      return EXIT_OK;
    }
    for (const column of COLUMNS) {
      const rows = model.tasks.filter((task) => task.column === column);
      io.out(`${column}: ${rows.length}`);
      for (const task of rows) {
        io.out(visibleText(`  ${task.agent}  ${task.title}  (${task.explanation.what})`));
      }
    }
    for (const request of model.humanRequests) {
      io.out(visibleText(`te necesita: ${request.title}: ${request.explanation.systemAction}`));
    }
    return EXIT_OK;
  } finally {
    open.store.close();
  }
}

function factoryWatch(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
): number | Promise<number> {
  // --json is accepted as haril workflow watch accepts it: every line is JSON already.
  const parsed = parseArgs(args, {
    values: ["--project", "--interval-ms", "--data-dir"],
    flags: ["--json", EXIT_ON_STDIN_END],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) return fail(io, USAGE);
  const intervalText = lastValue(parsed, "--interval-ms");
  const intervalMs = intervalText === undefined ? DEFAULT_INTERVAL_MS : Number(intervalText);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) {
    return fail(io, "--interval-ms takes a whole number of milliseconds from 10 to 60000");
  }
  const open = opened(parsed, io, host);
  if (typeof open === "number") return open;
  return follow(open.store, open.dataDir, open.project, intervalMs, io, host, parsed);
}

function follow(
  store: Store,
  dataDir: string,
  project: ProjectRecord | undefined,
  intervalMs: number,
  io: CliIo,
  host: HostInfo,
  parsed: ReturnType<typeof parseArgs>,
): Promise<number> {
  const clock = clockFor(host);
  const connectControl = host.connectControl ?? connect;
  const signals = host.signals ?? process;
  const read = reader(store, dataDir, project, host);
  let last = "";
  const print = (force: boolean): void => {
    const model = read(clock.now());
    const current = fingerprint(model);
    if (force || current !== last) io.out(JSON.stringify(model));
    last = current;
  };
  print(true);
  return new Promise((resolve) => {
    let client: ControlClient | undefined;
    let connecting = false;
    let ended = false;
    let pendingWake: ReturnType<typeof setTimeout> | undefined;
    let lastWake = Number.NEGATIVE_INFINITY;
    let stopStdin: (() => void) | undefined;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      stopStdin?.();
      clearInterval(poll);
      if (pendingWake !== undefined) clearTimeout(pendingWake);
      signals.off("SIGINT", finish);
      signals.off("SIGTERM", finish);
      const openClient = client;
      client = undefined;
      openClient?.close();
      store.close();
      resolve(EXIT_OK);
    };
    const step = (force: boolean): void => {
      if (ended) return;
      try {
        print(force);
      } catch (error) {
        io.err(`haril: ${error instanceof Error ? error.message : String(error)}`);
        finish();
      }
    };
    const onWake = (): void => {
      if (ended || pendingWake !== undefined) return;
      const wait = lastWake + WAKE_INTERVAL_MS - Date.now();
      const now = (): void => {
        pendingWake = undefined;
        lastWake = Date.now();
        step(true);
      };
      if (wait <= 0) now();
      else pendingWake = setTimeout(now, wait);
    };
    const subscribe = async (): Promise<void> => {
      if (client !== undefined || connecting || ended) return;
      connecting = true;
      const next = await connectControl(dataDir, { subscribe: true }).catch(() => undefined);
      connecting = false;
      if (next === undefined) return;
      if (ended) {
        next.close();
        return;
      }
      client = next;
      next.onWake(onWake);
      next.onClose(() => {
        if (client === next) client = undefined;
      });
    };
    const poll = setInterval(() => {
      step(false);
      if (!ended && client === undefined) void subscribe();
    }, intervalMs);
    signals.on("SIGINT", finish);
    signals.on("SIGTERM", finish);
    if (parsed.flags.has(EXIT_ON_STDIN_END)) stopStdin = onStdinEnd(host, finish);
    void subscribe();
  });
}

// The thread a person names by a task id or by an agent's code, among the workflows that have not ended.
function targetOf(
  store: Store,
  name: string,
): { readonly view: WorkflowView; readonly task: WorkflowTaskRecord } | string {
  const open = store.workflows
    .list()
    .filter((row) => row.state === "running" || row.state === "awaiting_human");
  const found: { view: WorkflowView; task: WorkflowTaskRecord }[] = [];
  for (const workflow of open) {
    const view = WorkflowView.load(store, workflow.workflowId);
    if (view === undefined) continue;
    const byId = view.task(name);
    if (byId !== undefined) {
      const latest = view.latest(byId.threadId);
      if (latest !== undefined) found.push({ view, task: latest });
      continue;
    }
    const codes = threadsOf(view.tasks);
    const thread = codes.find((row) => row.code === name);
    const latest = thread === undefined ? undefined : view.latest(thread.threadId);
    if (latest !== undefined) found.push({ view, task: latest });
  }
  const [first, second] = found;
  if (first === undefined) return `no agent or task "${name}" in a workflow that is running`;
  if (second !== undefined)
    return `"${name}" names agents in more than one workflow: use a task id`;
  return first;
}

// What waits for a person, for the console's rail and its reminders. With --model, also how that model's account stands
// against the threshold: in ACTION mode the console tells the person and never switches by itself.
function factoryRequests(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: ["--project", "--model", "--data-dir"],
    flags: ["--json"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) return fail(io, USAGE);
  const open = opened(parsed, io, host);
  if (typeof open === "number") return open;
  try {
    const now = clockFor(host).now();
    const model = reader(open.store, open.dataDir, open.project, host)(now);
    const requests = model.humanRequests.map((row) => ({
      id: row.id,
      kind: row.kind,
      group: row.request?.reason ?? row.kind,
      title: row.title,
      at: row.at,
    }));
    const ref = lastValue(parsed, "--model");
    const payload = {
      count: requests.length,
      requests,
      quota: ref === undefined ? null : modelQuota(open.store, ref, now, host),
    };
    if (parsed.flags.has("--json")) io.out(JSON.stringify(payload));
    else io.out(`te necesitan: ${payload.count}`);
    return EXIT_OK;
  } finally {
    open.store.close();
  }
}

function modelQuota(store: Store, ref: string, now: number, host: HostInfo) {
  const loaded = loadDelegationSettings(host);
  const settings = loaded.ok ? loaded.settings : delegationSettingsOf(undefined);
  const records = store.quota.latest(now - QUOTA_FRESH_MS);
  const sample = quotaByKey(records, settings.quota)[quotaKeyFor(ref, groupIndex(records))];
  return sample?.available === true && sample.window5hUsedPct !== null
    ? { usedPct: sample.window5hUsedPct, switchAt: settings.quota.switchAtPercent5h }
    : null;
}

function factoryMessage(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--urgent", "--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [name, text, ...extra] = parsed.positionals;
  if (name === undefined || text === undefined || text.trim() === "" || extra.length > 0) {
    return fail(io, USAGE);
  }
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = openExisting(host, dataDir);
  if (store === undefined) return fail(io, NOT_INITIALIZED);
  try {
    const target = targetOf(store, name);
    if (typeof target === "string") return fail(io, target);
    const { view, task } = target;
    if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") {
      return fail(io, `${name} already ended (${task.state}): nothing will read this message`);
    }
    const id = storeAccess(host).ids.next();
    const urgent = parsed.flags.has("--urgent");
    appendAgentMessage(store, {
      id,
      workflowId: view.workflow.workflowId,
      projectId: view.workflow.projectId,
      threadId: task.threadId,
      taskId: task.taskId,
      text,
      urgent,
      from: decidedByOf(host),
    });
    nudgeQueued(dataDir);
    const state = urgent
      ? "el intento se detiene y sigue con tu mensaje"
      : "en espera del fin de turno";
    if (parsed.flags.has("--json")) io.out(JSON.stringify({ messageId: id, urgent, state }));
    else io.out(visibleText(`Mensaje para ${view.label(task.threadId)}: ${state}.`));
    return EXIT_OK;
  } finally {
    store.close();
  }
}

function factoryAnswer(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [id, answer, text, ...extra] = parsed.positionals;
  const known = answer === "approve" || answer === "deny" || answer === "write";
  if (id === undefined || !known || extra.length > 0) return fail(io, USAGE);
  if (answer === "write" && (text === undefined || text.trim() === "")) {
    return fail(io, "write needs your answer as text");
  }
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = openExisting(host, dataDir);
  if (store === undefined) return fail(io, NOT_INITIALIZED);
  try {
    const request = store.approvals.get(id);
    if (request === undefined || request.kind !== HUMAN_REQUEST_KIND) {
      return fail(io, `no request to a person with id "${id}"`);
    }
    const reason =
      answer === "write" ? `${WRITTEN_ANSWER_PREFIX}${text as string}` : (text ?? undefined);
    try {
      store.approvals.decide({
        approvalId: id,
        outcome: answer === "approve" ? "granted" : "denied",
        decidedBy: decidedByOf(host),
        ...(reason === undefined ? {} : { reason }),
      });
    } catch (error) {
      return fail(io, error instanceof Error ? error.message : String(error));
    }
    nudgeQueued(dataDir);
    if (parsed.flags.has("--json")) io.out(JSON.stringify({ requestId: id, answer }));
    else io.out(`Respuesta guardada: ${answer}.`);
    return EXIT_OK;
  } finally {
    store.close();
  }
}

export function factory(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
): number | Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "show") return factoryShow(rest, io, host);
  if (sub === "watch") return factoryWatch(rest, io, host);
  if (sub === "requests") return factoryRequests(rest, io, host);
  if (sub === "message") return factoryMessage(rest, io, host);
  if (sub === "answer") return factoryAnswer(rest, io, host);
  return fail(io, USAGE);
}
