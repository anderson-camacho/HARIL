import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostInfo, run } from "../src/cli.js";
import { sessionLines } from "../src/commands/workflow-tail.js";
import { storeAccess } from "../src/host.js";
import { harness, makeSandbox, projectRoot, type Sandbox } from "./helpers.js";
import { until } from "./process-helpers.js";

// `haril workflow tail <workflowId> <node>` (docs/modos-y-delegacion.md 7.9, spike S7): what a node's agent wrote and
// called, read from the Pi session of its current or latest run (runs/<runId>/pi/<ts>_<uuid>.jsonl), which Pi appends
// one whole line per message. --follow keeps reading while the file grows, a half-written last line included, until the
// workflow ends. The session here is a file the test writes in Pi's format; its content is fixture text.

let sb: Sandbox;
const stores: Store[] = [];
const T0 = Date.UTC(2026, 9, 18, 10, 0, 0);

beforeEach(() => {
  sb = makeSandbox();
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    harness().io,
    sb.host,
  );
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  sb.cleanup();
});

function open(): Store {
  const store = storeAccess(sb.host).open(sb.dataDir);
  stores.push(store);
  return store;
}

function withLease<T>(store: Store, work: (epoch: number) => T): T {
  const grant = store.runtime.acquire({
    pid: process.pid,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  try {
    return work(grant.value.epoch);
  } finally {
    store.runtime.release(grant.value.epoch, true);
  }
}

// A workflow whose orchestrator turn was claimed by a runtime (its run exists) and never ends on its own.
function claimedOrchestrator(store: Store): { workflowId: string; runId: string } {
  expect(
    run(
      [
        "workflow",
        "start",
        "Tail me",
        "--model",
        "cliproxy/model-x",
        "--agent",
        "orchestrator",
        "--autonomous",
      ],
      harness().io,
      sb.host,
    ),
  ).toBe(0);
  return withLease(store, (epoch) => {
    while (store.commands.applyNext(epoch) !== undefined);
    const [workflow] = store.workflows.list();
    const root = workflow === undefined ? undefined : store.workflows.tasks(workflow.workflowId)[0];
    if (workflow === undefined || root === undefined) throw new Error("no workflow");
    const claimed = store.tasks.claimTask(epoch, root.taskId);
    if (claimed === undefined) throw new Error("not claimed");
    return { workflowId: workflow.workflowId, runId: claimed.runId };
  });
}

function stopWorkflow(store: Store, workflowId: string): void {
  store.commands.enqueue({
    type: "workflow.stop",
    projectId: store.projects.list()[0]?.projectId,
    args: { workflowId },
    idempotencyKey: `stop-${workflowId}`,
    requestHash: `stop-${workflowId}`,
  });
  withLease(store, (epoch) => {
    while (store.commands.applyNext(epoch) !== undefined);
  });
}

function sessionFile(runId: string): string {
  const dir = join(sb.dataDir, "runs", runId, "pi");
  mkdirSync(dir, { recursive: true });
  return join(dir, "2026-10-18T10-00-00-000Z_0000-session.jsonl");
}

const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const ENTRIES = [
  { type: "session", version: 3, id: "s1", timestamp: at(0), cwd: "D:/notes" },
  {
    type: "model_change",
    id: "m1",
    parentId: null,
    timestamp: at(0),
    provider: "haril",
    modelId: "model-x",
  },
  {
    type: "thinking_level_change",
    id: "t1",
    parentId: "m1",
    timestamp: at(0),
    thinkingLevel: "off",
  },
  {
    type: "message",
    id: "u0",
    parentId: "t1",
    timestamp: at(1),
    message: { role: "system", content: "You are the orchestrator. ".repeat(20), timestamp: T0 },
  },
  {
    type: "message",
    id: "u1",
    parentId: "u0",
    timestamp: at(1),
    message: { role: "user", content: [{ type: "text", text: "Report the facts\nof the notes" }] },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: at(2),
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I will read the notes first." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "notes/planets.md" } },
      ],
      usage: { input: 1324, output: 132, totalTokens: 1456 },
      stopReason: "toolUse",
    },
  },
  {
    type: "message",
    id: "r1",
    parentId: "a1",
    timestamp: at(3),
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "# Planets\u001b[31m\nMars has two moons.\u0007" }],
      isError: false,
    },
  },
];

interface TailJson {
  readonly at: number | null;
  readonly kind: string;
  readonly text: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

describe("sessionLines", () => {
  it("turns each Pi session entry into short lines: model, prompts, text, tool calls and results, tokens", () => {
    const lines = ENTRIES.flatMap((entry) => sessionLines(entry));
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ["session", "session started"],
      ["model", "haril/model-x"],
      ["thinking", "level off"],
      ["system", "system prompt, 520 characters"],
      ["user", "Report the facts of the notes"],
      ["assistant", "I will read the notes first."],
      ["tool", 'read {"path":"notes/planets.md"}'],
      ["tokens", "in 1324 · out 132"],
      ["result", "read ok · # Planets?[31m Mars has two moons.?"],
    ]);
    expect(lines.find((line) => line.kind === "tokens")).toMatchObject({
      at: T0 + 2000,
      tokensIn: 1324,
      tokensOut: 132,
    });
  });

  it("keeps no control character of what an agent wrote, and shortens a long text", () => {
    const [line] = sessionLines({
      type: "message",
      timestamp: at(4),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `x\u001b]0;title\u0007${"y".repeat(900)}` }],
      },
    });
    const controls = Array.from(line?.text ?? "").filter((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });
    expect(controls).toEqual([]);
    expect(line?.text.length).toBeLessThanOrEqual(300);
    expect(line?.text.endsWith("…")).toBe(true);
    expect(sessionLines("not an object")).toEqual([]);
  });
});

describe("haril workflow tail", () => {
  it("prints the node's latest run, as JSON lines", async () => {
    const store = open();
    const { workflowId, runId } = claimedOrchestrator(store);
    writeFileSync(
      sessionFile(runId),
      `${ENTRIES.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const out = harness();
    expect(await run(["workflow", "tail", workflowId, "o1", "--json"], out.io, sb.host)).toBe(0);
    const lines = out.out.map((line) => JSON.parse(line) as TailJson);
    expect(lines[0]).toMatchObject({ kind: "run", at: null });
    expect(lines[0]?.text).toContain(runId);
    expect(lines.slice(1).map((line) => line.kind)).toEqual([
      "session",
      "model",
      "thinking",
      "system",
      "user",
      "assistant",
      "tool",
      "tokens",
      "result",
    ]);
  });

  it("prints readable lines without --json, and says when a node has not run", async () => {
    const store = open();
    const { workflowId, runId } = claimedOrchestrator(store);
    writeFileSync(
      sessionFile(runId),
      `${ENTRIES.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const out = harness();
    expect(await run(["workflow", "tail", workflowId, "o1"], out.io, sb.host)).toBe(0);
    const text = out.out.join("\n");
    expect(text).toMatch(/^o1 · Orchestrator 1 · turn 1 of 1 · run /);
    expect(text).toMatch(/\d\d:\d\d:\d\d {2}tool {6}read \{"path":"notes\/planets.md"\}/);
    expect(text).toContain("tokens    in 1324 · out 132");

    const missing = harness();
    expect(await run(["workflow", "tail", workflowId, "e9"], missing.io, sb.host)).toBe(2);
    expect(missing.err.join("\n")).toContain('no node "e9" in workflow');
  });

  it("follows a session while Pi writes it, a half-written line included, and ends when the workflow ends", async () => {
    const store = open();
    const { workflowId, runId } = claimedOrchestrator(store);
    const file = sessionFile(runId);
    const lines: TailJson[] = [];
    const host: HostInfo = { ...sb.host, signals: new EventEmitter() };
    const io = {
      out: (line: string) => lines.push(JSON.parse(line) as TailJson),
      err: () => undefined,
      readFile: () => "",
    };
    const done = Promise.resolve(
      run(
        ["workflow", "tail", workflowId, "o1", "--follow", "--json", "--interval-ms", "30"],
        io,
        host,
      ),
    );
    await until(() => lines.length === 1, "the run line", 5000);
    // Pi has not written the session yet: nothing more.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lines).toHaveLength(1);

    writeFileSync(file, `${JSON.stringify(ENTRIES[0])}\n${JSON.stringify(ENTRIES[1])}\n`);
    await until(() => lines.length === 3, "the first two entries", 5000);
    // Half of the next line: nothing is printed until its end arrives.
    const next = JSON.stringify(ENTRIES[5]);
    appendFileSync(file, next.slice(0, 40));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(lines).toHaveLength(3);
    appendFileSync(file, `${next.slice(40)}\n`);
    await until(() => lines.some((line) => line.kind === "tokens"), "the assistant's reply", 5000);
    expect(lines.slice(3).map((line) => line.kind)).toEqual(["assistant", "tool", "tokens"]);

    stopWorkflow(store, workflowId);
    expect(await done).toBe(0);
  });
});
