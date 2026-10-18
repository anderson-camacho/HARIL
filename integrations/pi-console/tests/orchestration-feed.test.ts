import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chooseWorkflow,
  createWorkflowFeed,
  parseSnapshotLine,
  parseTailLine,
  parseWorkflowList,
  type TailLine,
  type WorkflowChoice,
  type WorkflowFeed,
} from "../src/orchestration-feed.js";
import type { WorkflowSnapshot } from "../src/orchestration-types.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";

// The ORCHESTRATION view's real data comes from the haril CLI (spec 6): haril workflow list --json, then haril workflow
// watch <id> as a child whose lines are snapshots, and haril workflow tail <id> <node> --follow --json for the live
// view. The CLI is the fake of fake-cli.ts here, answering with lines the real CLI printed (fixtures/).

const HERE = dirname(fileURLToPath(import.meta.url));
const completedText = JSON.stringify(
  JSON.parse(readFileSync(join(HERE, "fixtures", "snapshot-completed.json"), "utf8")),
);
const awaitingText = JSON.stringify(
  JSON.parse(readFileSync(join(HERE, "fixtures", "snapshot-awaiting.json"), "utf8")),
);
const tailText = readFileSync(join(HERE, "fixtures", "tail-e1.jsonl"), "utf8");
const WORKFLOW_ID = (JSON.parse(completedText) as WorkflowSnapshot).workflow.id;

let cli: FakeCli;
let feed: WorkflowFeed | undefined;
let rows: WorkflowChoice[][];
let snapshots: WorkflowSnapshot[];
let tails: { nodeId: string; lines: readonly TailLine[] }[];

beforeEach(() => {
  cli = installFakeCli();
  rows = [];
  snapshots = [];
  tails = [];
});

afterEach(() => {
  feed?.close();
  feed = undefined;
  cli.restore();
});

function open(): WorkflowFeed {
  feed = createWorkflowFeed({
    cwd: () => undefined,
    projectSlug: () => "notes",
    onWorkflows: (list) => rows.push([...list]),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onTail: (nodeId, lines) => tails.push({ nodeId, lines }),
  });
  return feed;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function listed(id: string, state: string, createdAt: number) {
  return { workflowId: id, state, goal: `Goal of ${id}`, createdAt, stopReason: null };
}

describe("the lines the console reads", () => {
  it("takes a snapshot the CLI printed, and nothing else", () => {
    expect(parseSnapshotLine(completedText)?.workflow.id).toBe(WORKFLOW_ID);
    expect(parseSnapshotLine(awaitingText)?.workflow.state).toBe("awaiting_human");
    expect(parseSnapshotLine("not json")).toBeUndefined();
    expect(parseSnapshotLine(JSON.stringify({ schemaVersion: 2 }))).toBeUndefined();
    const broken = JSON.parse(completedText) as { nodes: unknown[] };
    broken.nodes = [{ id: 5 }];
    expect(parseSnapshotLine(JSON.stringify(broken))).toBeUndefined();
  });

  it("takes a tail line and a workflow list, and drops the rest", () => {
    const lines = tailText.split("\n").filter((line) => line !== "");
    expect(lines.map((line) => parseTailLine(line)?.kind)).toContain("tool");
    expect(parseTailLine(lines.find((line) => line.includes('"tokens"')) ?? "")).toMatchObject({
      kind: "tokens",
      tokensIn: 1210,
      tokensOut: 48,
    });
    expect(parseTailLine('{"kind":1}')).toBeUndefined();
    expect(parseTailLine('{"kind":"note","text":"x","at":"soon"}')).toBeUndefined();
    expect(parseWorkflowList([listed("wf-1", "running", 1), { nope: true }])).toEqual([
      { id: "wf-1", state: "running", goal: "Goal of wf-1", createdAt: 1, stopReason: null },
    ]);
    expect(parseWorkflowList({ rows: [] })).toBeUndefined();
  });

  it("follows the workflow picked, else the newest that runs or waits, else the newest", () => {
    const list = parseWorkflowList([
      listed("wf-new-done", "completed", 30),
      listed("wf-waiting", "awaiting_human", 20),
      listed("wf-old-running", "running", 10),
    ]) as WorkflowChoice[];
    expect(chooseWorkflow(list, undefined)?.id).toBe("wf-waiting");
    expect(chooseWorkflow(list, "wf-old-running")?.id).toBe("wf-old-running");
    expect(chooseWorkflow(list, "wf-gone")?.id).toBe("wf-waiting");
    expect(chooseWorkflow([list[0] as WorkflowChoice], undefined)?.id).toBe("wf-new-done");
    expect(chooseWorkflow([], undefined)).toBeUndefined();
  });
});

describe("the workflow feed", () => {
  it("lists the project's workflows and watches the chosen one, its snapshots reaching the view", async () => {
    cli.answer("workflow list", { stdout: JSON.stringify([listed(WORKFLOW_ID, "running", 1)]) });
    cli.answer("workflow watch", { stdout: `${awaitingText}\n${completedText}\n` });
    const watching = open();
    await watching.refresh();
    await waitFor(() => snapshots.length === 2, "two snapshots");
    expect(rows[0]?.map((row) => row.id)).toEqual([WORKFLOW_ID]);
    expect(snapshots.map((item) => item.workflow.state)).toEqual(["awaiting_human", "completed"]);
    const calls = cli.calls().map((call) => call.args.join(" "));
    expect(calls).toContain("workflow list --json --project notes");
    expect(calls).toContain(`workflow watch ${WORKFLOW_ID} --exit-on-stdin-end`);

    // The watch ended after the workflow did: a refresh does not start it again.
    await watching.refresh();
    expect(cli.calls().filter((call) => call.args[1] === "watch")).toHaveLength(1);
  });

  it("drops a snapshot of another workflow, and empties when no workflow is listed", async () => {
    cli.answer("workflow list", { stdout: JSON.stringify([listed("wf-other", "running", 1)]) });
    cli.answer("workflow watch", { stdout: `${completedText}\n` });
    const watching = open();
    await watching.refresh();
    await waitFor(() => cli.calls().some((call) => call.args[1] === "watch"), "the watch to start");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(snapshots).toEqual([]);
    cli.answer("workflow list", { stdout: "[]" });
    await watching.refresh();
    expect(rows.at(-1)).toEqual([]);
    expect(watching.watching).toBeUndefined();
  });

  it("tails the live view's node, once per node, and starts over for another", async () => {
    cli.answer("workflow tail", { stdout: tailText });
    const watching = open();
    watching.follow({ workflowId: WORKFLOW_ID, nodeId: "e1" });
    await waitFor(() => tails.some((item) => item.lines[0]?.kind === "tokens"), "the tail lines");
    expect(tails.every((item) => item.nodeId === "e1")).toBe(true);
    const call = cli.calls().find((item) => item.args[1] === "tail");
    expect(call?.args).toEqual([
      "workflow",
      "tail",
      WORKFLOW_ID,
      "e1",
      "--follow",
      "--json",
      "--exit-on-stdin-end",
    ]);
    watching.follow({ workflowId: WORKFLOW_ID, nodeId: "e1" });
    expect(cli.calls().filter((item) => item.args[1] === "tail")).toHaveLength(1);
    watching.follow({ workflowId: WORKFLOW_ID, nodeId: "e2" });
    await waitFor(() => tails.some((item) => item.nodeId === "e2"), "the other node's tail");
    expect(cli.calls().filter((item) => item.args[1] === "tail")).toHaveLength(2);
  });

  it("takes tail lines only from the current tail child, never from one it already replaced", () => {
    const children: { args: readonly string[]; onLine: (line: string) => void; closed: boolean }[] =
      [];
    const scripted = createWorkflowFeed(
      {
        cwd: () => undefined,
        projectSlug: () => "notes",
        onWorkflows: () => undefined,
        onSnapshot: () => undefined,
        onTail: (nodeId, lines) => tails.push({ nodeId, lines }),
      },
      {
        listJson: async () => [],
        stream: (args, options) => {
          const child = { args, onLine: options.onLine, closed: false };
          children.push(child);
          return {
            get running() {
              return !child.closed;
            },
            close: () => {
              child.closed = true;
            },
          };
        },
      },
    );
    const line = JSON.stringify({ at: 1, kind: "assistant", text: "hello" });
    scripted.follow({ workflowId: WORKFLOW_ID, nodeId: "e1" });
    scripted.follow({ workflowId: WORKFLOW_ID, nodeId: "e2" });
    scripted.follow({ workflowId: WORKFLOW_ID, nodeId: "e1" });
    expect(children).toHaveLength(3);
    // The first e1 child was closed, but its buffered lines still arrive: they belong to no current tail.
    children[0]?.onLine(line);
    children[1]?.onLine(line);
    expect(tails).toEqual([]);
    children[2]?.onLine(line);
    expect(tails).toEqual([{ nodeId: "e1", lines: [{ at: 1, kind: "assistant", text: "hello" }] }]);
    scripted.close();
  });

  it("restarts a tail child that died, a bounded number of times, then says the live feed ended", async () => {
    const children: { onExit?: (code: number | null) => void; closed: boolean }[] = [];
    const resets: string[] = [];
    const ended: string[] = [];
    const scripted = createWorkflowFeed(
      {
        cwd: () => undefined,
        projectSlug: () => "notes",
        onWorkflows: () => undefined,
        onSnapshot: () => undefined,
        onTail: (nodeId, lines) => tails.push({ nodeId, lines }),
        onTailReset: (nodeId) => resets.push(nodeId),
        onTailEnded: (nodeId) => ended.push(nodeId),
      },
      {
        listJson: async () => [],
        stream: (_args, options) => {
          const child = { onExit: options.onExit, closed: false };
          children.push(child);
          return {
            get running() {
              return !child.closed;
            },
            close: () => {
              child.closed = true;
            },
          };
        },
      },
      { tailRetryDelaysMs: [0, 0] },
    );
    scripted.follow({ workflowId: WORKFLOW_ID, nodeId: "e1" });
    children[0]?.onExit?.(1);
    await waitFor(() => children.length === 2, "the first restart");
    expect(resets).toEqual(["e1"]);
    children[1]?.onExit?.(null);
    await waitFor(() => children.length === 3, "the second restart");
    children[2]?.onExit?.(1);
    await waitFor(() => ended.length === 1, "the end of the live feed");
    expect(ended).toEqual(["e1"]);
    expect(children).toHaveLength(3);
    scripted.close();
  });

  it("never restarts a tail that ended normally (its workflow ended and it printed everything)", async () => {
    const children: { onExit?: (code: number | null) => void }[] = [];
    const ended: string[] = [];
    const scripted = createWorkflowFeed(
      {
        cwd: () => undefined,
        projectSlug: () => "notes",
        onWorkflows: () => undefined,
        onSnapshot: () => undefined,
        onTail: () => undefined,
        onTailEnded: (nodeId) => ended.push(nodeId),
      },
      {
        listJson: async () => [],
        stream: (_args, options) => {
          children.push({ onExit: options.onExit });
          return { running: true, close: () => undefined };
        },
      },
      { tailRetryDelaysMs: [0, 0] },
    );
    scripted.follow({ workflowId: WORKFLOW_ID, nodeId: "e1" });
    children[0]?.onExit?.(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(children).toHaveLength(1);
    expect(ended).toEqual([]);
    scripted.close();
  });

  it("ends its children when it closes, and reports nothing after", async () => {
    cli.answer("workflow list", { stdout: JSON.stringify([listed(WORKFLOW_ID, "running", 1)]) });
    cli.answer("workflow watch", { stdout: `${completedText}\n`, delayMs: 3000 });
    const watching = open();
    await watching.refresh();
    expect(watching.watching).toBe(WORKFLOW_ID);
    watching.close();
    expect(watching.watching).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(snapshots).toEqual([]);
  });
});
