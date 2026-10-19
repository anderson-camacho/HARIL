import { validateWorkflowSnapshot, type WorkflowSnapshot } from "@haril/contracts";
import type { NewTurn, Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { storeAccess } from "../src/host.js";
import {
  harness,
  makeSandbox,
  parseJson,
  projectRoot,
  type Sandbox,
  withWorkflowIntake,
  workflowIntake,
} from "./helpers.js";

// The models and the quota in WorkflowSnapshot v1 (ADR-0021; phase F6): where each node's model came from (pinned by the
// user, proposed by its parent, or chosen by the difficulty table), the reasoning level its attempt ran at when known,
// each account's quota from the store's newest reading, and a turn that waits for a cooldown. null still means "not
// known": nothing is invented.

const PINNED = "cliproxy/Gemini1/gemini-3-pro";
const PARENT = "cliproxy/Gemini1/gemini-3-flash";
const TABLE = "cliproxy/Gemini2/gemini-3-flash";

let sb: Sandbox;
const stores: Store[] = [];

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

function delegator(key: string, model: string, parent: string): NewTurn {
  return {
    key,
    threadId: null,
    role: "delegator",
    layer: 2,
    kind: "plan",
    parentTaskId: parent,
    localId: key,
    goal: `Goal of ${key}`,
    description: "",
    agentRef: "delegator",
    model,
    modelPinned: false,
    difficulty: "medium",
    difficultyReason: "a few files",
    priority: 5,
    budgetTokens: 20_000,
    timeoutMs: 60_000,
    surfaceWrite: [],
    surfaceRead: [],
    dependsOn: [],
  };
}

function seed(): string {
  const store = storeAccess(sb.host).open(sb.dataDir);
  stores.push(store);
  const grant = store.runtime.acquire({
    pid: process.pid,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  const epoch = grant.value.epoch;
  store.commands.enqueue({
    type: "workflow.start",
    projectId: store.projects.list()[0]?.projectId,
    args: {
      intake: workflowIntake(store.projects.list()[0]?.rootPath as string),
      goal: "Answer from the notes",
      model: PINNED,
      agent: "orchestrator",
      autonomy: { mode: "autonomous", stops: [] },
      budgetTokens: 100_000,
      timeoutMs: 60_000,
    },
    idempotencyKey: "seed",
    requestHash: "seed",
  });
  store.commands.applyNext(epoch);
  const workflow = store.workflows.list()[0];
  const root = workflow === undefined ? undefined : store.workflows.tasks(workflow.workflowId)[0];
  if (workflow === undefined || root === undefined) throw new Error("no workflow");
  // The orchestrator proposed a model for part-a and none for part-b (the table chose it).
  const proposal = {
    schemaVersion: 1,
    memo: "two parts",
    delegations: [
      { localId: "part-a", model: PARENT },
      { localId: "part-b", model: null },
    ],
  };
  const applied = store.workflows.applyTurns(epoch, {
    workflowId: workflow.workflowId,
    turns: [delegator("part-a", PARENT, root.taskId), delegator("part-b", TABLE, root.taskId)],
    delegation: {
      threadId: root.threadId,
      parentTaskId: root.taskId,
      proposedByRunId: null,
      tool: "haril_delegate",
      payloadHash: "c".repeat(64),
      memo: "two parts",
      payload: proposal,
    },
  });
  // part-a's attempt ran at the gateway's default level.
  store.events.append({
    aggregateType: "task",
    aggregateId: applied.taskIds["part-a"] as string,
    type: "model.selected",
    actorKind: "system",
    actorId: "runtime",
    payload: { workflowId: workflow.workflowId, model: PARENT, thinkingLevel: "medium" },
    projectId: workflow.projectId,
    taskId: applied.taskIds["part-a"] as string,
  });
  // part-b waits for its model's cooldown.
  store.tasks.promote();
  store.workflows.deferTurn(epoch, applied.taskIds["part-b"] as string, Date.now() + 600_000);
  store.runtime.release(epoch, true);
  store.quota.recordSnapshot("cliproxy", {
    ok: true,
    sampledAt: Date.now(),
    source: "cliproxyapi-management/v0",
    accounts: [
      {
        credentialRef: "acct-0000000000a1",
        kind: "antigravity",
        prefix: "Gemini1",
        windows: [
          { name: "5h", usedPct: 83, resetsAt: Date.now() + 3_600_000 },
          { name: "7d", usedPct: 41, resetsAt: Date.now() + 86_400_000 },
        ],
        note: null,
      },
      {
        credentialRef: "acct-0000000000b2",
        kind: "codex",
        prefix: null,
        windows: [],
        note: "no usage probe for codex",
      },
    ],
  });
  return workflow.workflowId;
}

describe("the snapshot's models and quota", () => {
  it("says where each model came from, the level when known, each account's quota and a cooldown wait", async () => {
    const workflowId = seed();
    const out = harness();
    await run(["workflow", "show", workflowId, "--json"], out.io, sb.host);
    const snapshot = parseJson<WorkflowSnapshot>(out.out);
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
    const byId = new Map(snapshot.nodes.map((node) => [node.label, node]));
    expect(byId.get("Orchestrator 1")).toMatchObject({ model: PINNED, modelSource: "pinned" });
    expect(byId.get("Delegator 1")).toMatchObject({
      model: PARENT,
      modelSource: "parent",
      thinkingLevel: "medium",
      quota: { window5hPct: 83, weeklyPct: 41 },
    });
    expect(byId.get("Delegator 2")).toMatchObject({
      model: TABLE,
      modelSource: "table",
      thinkingLevel: null,
      // No reading covers the Gemini2 account: unknown, never a number.
      quota: null,
      state: "waiting",
    });
    expect(byId.get("Delegator 2")?.waitingReason).toMatch(/^cooldown until \d\d:\d\d/);
    expect(snapshot.quota).toEqual([
      expect.objectContaining({
        provider: "cliproxy",
        credential: "Gemini1",
        window5hPct: 83,
        weeklyPct: 41,
        note: "over 80% of its 5-hour window: avoided",
      }),
      expect.objectContaining({
        credential: "codex acct-0000000000b2",
        window5hPct: null,
        weeklyPct: null,
        resetAt: null,
        note: "sin dato: no usage probe for codex",
      }),
    ]);
  });

  it("lists no quota row and no node quota without a reading", async () => {
    const store = storeAccess(sb.host).open(sb.dataDir);
    stores.push(store);
    expect(
      await run(
        withWorkflowIntake(sb, projectRoot(sb, "demo"), [
          "workflow",
          "start",
          "Plain",
          "--read-only",
          "--model",
          PINNED,
          "--agent",
          "orchestrator",
          "--autonomous",
        ]),
        harness().io,
        sb.host,
      ),
    ).toBe(0);
    const grant = store.runtime.acquire({
      pid: process.pid,
      nodeVersion: process.version,
      sqliteVersion: store.info().sqliteVersion,
      ttlMs: 60_000,
    });
    if (!grant.ok) throw new Error("lease not granted");
    while (store.commands.applyNext(grant.value.epoch) !== undefined);
    store.runtime.release(grant.value.epoch, true);
    const workflowId = store.workflows.list()[0]?.workflowId ?? "";
    const out = harness();
    await run(["workflow", "show", workflowId, "--json"], out.io, sb.host);
    const snapshot = parseJson<WorkflowSnapshot>(out.out);
    expect(snapshot.quota).toEqual([]);
    expect(snapshot.nodes[0]).toMatchObject({
      quota: null,
      thinkingLevel: null,
      modelSource: "pinned",
    });
  });
});
