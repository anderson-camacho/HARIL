import { type HarilStream, runHarilJson, streamHaril } from "./cli.js";
import type { WorkflowSnapshot } from "./orchestration-types.js";

// The ORCHESTRATION view's real data (spec 6 and 7.6, phase F5b). The console reads HARIL only through the `haril`
// CLI (check-layers R6): `haril workflow list --json` names the project's workflows, `haril workflow watch <id>` runs
// as a child and prints a WorkflowSnapshot v1 per line on every change of the workflow it follows (the latest of the
// project, or the one the user picked), and `haril workflow tail <id> <node> --follow --json` runs while the live view
// shows a node. Each child is ended through its own handle when it is no longer wanted and when the session ends. A line
// that is not what it should be is dropped: nothing made up reaches the view.

// One line of `haril workflow tail --json`: `at` is null for a line about the run itself.
export interface TailLine {
  readonly at: number | null;
  readonly kind: string;
  readonly text: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

// A workflow of the project, as `haril workflow list --json` lists it.
export interface WorkflowChoice {
  readonly id: string;
  readonly state: string;
  readonly goal: string;
  readonly createdAt: number | null;
  readonly stopReason: string | null;
}

const WORKFLOW_STATES = new Set(["running", "awaiting_human", "completed", "failed", "stopped"]);
const LIVE_STATES = new Set(["running", "awaiting_human"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// A snapshot line of haril workflow watch (or show --json): the shape the view draws, checked field by field where the
// view reads it without a fallback. Undefined for anything else.
export function parseSnapshotLine(line: string): WorkflowSnapshot | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  const snapshot = record(value);
  const workflow = record(snapshot?.workflow);
  const totals = record(snapshot?.totals);
  const capacity = record(snapshot?.capacity);
  if (
    snapshot === undefined ||
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.demo !== "boolean" ||
    workflow === undefined ||
    typeof workflow.id !== "string" ||
    typeof workflow.goal !== "string" ||
    !WORKFLOW_STATES.has(String(workflow.state)) ||
    !finite(workflow.elapsedMs) ||
    totals === undefined ||
    !finite(totals.tokensUsed) ||
    capacity === undefined ||
    !Array.isArray(snapshot.nodes) ||
    !Array.isArray(snapshot.quota) ||
    !Array.isArray(snapshot.events) ||
    !Array.isArray(snapshot.usage)
  ) {
    return undefined;
  }
  const nodesOk = snapshot.nodes.every((item) => {
    const node = record(item);
    return (
      node !== undefined &&
      typeof node.id === "string" &&
      (node.parentId === null || typeof node.parentId === "string") &&
      typeof node.label === "string" &&
      typeof node.goal === "string" &&
      typeof node.state === "string" &&
      typeof node.model === "string" &&
      finite(node.tokens) &&
      record(node.files) !== undefined
    );
  });
  return nodesOk ? (snapshot as unknown as WorkflowSnapshot) : undefined;
}

// A line of haril workflow tail --json; undefined for anything else.
export function parseTailLine(line: string): TailLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  const item = record(value);
  if (item === undefined || typeof item.kind !== "string" || typeof item.text !== "string")
    return undefined;
  if (item.at !== null && !finite(item.at)) return undefined;
  return {
    at: item.at as number | null,
    kind: item.kind,
    text: item.text,
    ...(finite(item.tokensIn) ? { tokensIn: item.tokensIn } : {}),
    ...(finite(item.tokensOut) ? { tokensOut: item.tokensOut } : {}),
  };
}

// The rows of haril workflow list --json (newest first); undefined when the answer is not that list.
export function parseWorkflowList(value: unknown): WorkflowChoice[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item): WorkflowChoice[] => {
    const row = record(item);
    if (row === undefined || typeof row.workflowId !== "string" || typeof row.state !== "string")
      return [];
    return [
      {
        id: row.workflowId,
        state: row.state,
        goal: typeof row.goal === "string" ? row.goal : "",
        createdAt: finite(row.createdAt) ? row.createdAt : null,
        stopReason: typeof row.stopReason === "string" ? row.stopReason : null,
      },
    ];
  });
}

// The workflow to follow: the one the user picked while it is listed, else the newest that runs or waits, else the
// newest of all.
export function chooseWorkflow(
  rows: readonly WorkflowChoice[],
  picked: string | undefined,
): WorkflowChoice | undefined {
  const byCreation = [...rows].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return (
    (picked === undefined ? undefined : byCreation.find((row) => row.id === picked)) ??
    byCreation.find((row) => LIVE_STATES.has(row.state)) ??
    byCreation[0]
  );
}

export interface WorkflowFeedHost {
  cwd(): string | undefined;
  projectSlug(): string | undefined;
  onWorkflows(rows: readonly WorkflowChoice[]): void;
  onSnapshot(snapshot: WorkflowSnapshot): void;
  onTail(nodeId: string, lines: readonly TailLine[]): void;
}

// How the feed reaches the CLI; tests and the console use the real one.
export interface WorkflowFeedCli {
  readonly listJson: (args: readonly string[]) => Promise<unknown>;
  readonly stream: typeof streamHaril;
}

const REAL_CLI: WorkflowFeedCli = {
  listJson: (args) => runHarilJson(args),
  stream: streamHaril,
};

export interface WorkflowFeed {
  // Reads the project's workflows again and follows the chosen one (a new watch only when it changed, or when the
  // previous watch of a live workflow ended).
  refresh(): Promise<void>;
  // Follows this workflow from now on (until it is no longer listed).
  pick(workflowId: string): Promise<void>;
  // The live view's node: its tail runs while one is given; undefined ends it.
  follow(target: { readonly workflowId: string; readonly nodeId: string } | undefined): void;
  // The workflow being watched, if any.
  readonly watching: string | undefined;
  // Ends every child; the feed does nothing after this.
  close(): void;
}

export function createWorkflowFeed(
  host: WorkflowFeedHost,
  cli: WorkflowFeedCli = REAL_CLI,
): WorkflowFeed {
  let closed = false;
  let picked: string | undefined;
  let listing: Promise<void> | undefined;
  let again = false;
  let watch: { readonly id: string; readonly stream: HarilStream } | undefined;
  // The workflows whose watch ended after it showed them ended: their last snapshot is final.
  const finished = new Set<string>();
  // The live view's tail child. Each child has its own id: a line is taken only from the current child, so a child
  // replaced (another node, or the same node again) that still flushes buffered lines adds nothing.
  let tail: { readonly key: string; readonly id: number; readonly stream: HarilStream } | undefined;
  let tailSeq = 0;

  const startWatch = (id: string): void => {
    watch?.stream.close();
    watch = undefined;
    const stream = cli.stream(["workflow", "watch", id], {
      cwd: host.cwd(),
      onLine: (line) => {
        if (closed || watch?.id !== id) return;
        const snapshot = parseSnapshotLine(line);
        if (snapshot === undefined || snapshot.workflow.id !== id) return;
        if (["completed", "failed", "stopped"].includes(snapshot.workflow.state)) finished.add(id);
        host.onSnapshot(snapshot);
      },
      onExit: () => {
        if (closed || watch?.id !== id) return;
        // A watch that ended before its workflow did (the CLI failed) is started again by the next refresh.
        watch = { id, stream: { running: false, close: () => undefined } };
      },
    });
    if (stream !== undefined) watch = { id, stream };
  };

  const listOnce = async (): Promise<void> => {
    const slug = host.projectSlug();
    const rows = parseWorkflowList(
      await cli.listJson([
        "workflow",
        "list",
        "--json",
        ...(slug === undefined ? [] : ["--project", slug]),
      ]),
    );
    if (closed || rows === undefined) return;
    host.onWorkflows(rows);
    const chosen = chooseWorkflow(rows, picked);
    if (chosen === undefined) {
      watch?.stream.close();
      watch = undefined;
      return;
    }
    if (picked !== undefined && chosen.id !== picked) picked = undefined;
    const current = watch;
    const stale = current === undefined || current.id !== chosen.id;
    const lost = current !== undefined && !current.stream.running && !finished.has(chosen.id);
    if (stale || lost) startWatch(chosen.id);
  };

  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (listing !== undefined) {
      again = true;
      return listing;
    }
    listing = (async () => {
      do {
        again = false;
        await listOnce();
      } while (again && !closed);
    })().finally(() => {
      listing = undefined;
    });
    return listing;
  };

  return {
    get watching() {
      return watch?.id;
    },
    refresh,
    async pick(workflowId) {
      if (closed) return;
      picked = workflowId;
      finished.delete(workflowId);
      if (watch?.id !== workflowId) {
        watch?.stream.close();
        watch = undefined;
      }
      await refresh();
    },
    follow(target) {
      if (closed) return;
      const key = target === undefined ? undefined : `${target.workflowId}\u0000${target.nodeId}`;
      // The same node again: its tail runs, or it printed the whole session and ended (its workflow ended).
      if (key === tail?.key) return;
      tail?.stream.close();
      tail = undefined;
      if (target === undefined || key === undefined) return;
      const id = ++tailSeq;
      const stream = cli.stream(
        ["workflow", "tail", target.workflowId, target.nodeId, "--follow", "--json"],
        {
          cwd: host.cwd(),
          onLine: (line) => {
            if (closed || tail?.id !== id) return;
            const parsed = parseTailLine(line);
            if (parsed !== undefined) host.onTail(target.nodeId, [parsed]);
          },
        },
      );
      if (stream !== undefined) tail = { key, id, stream };
    },
    close() {
      if (closed) return;
      closed = true;
      watch?.stream.close();
      tail?.stream.close();
      watch = undefined;
      tail = undefined;
    },
  };
}
