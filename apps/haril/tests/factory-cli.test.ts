import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import type { Clock, Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factory } from "../src/commands/factory-command.js";
import { makeSandbox, type Sandbox, workflowIntake } from "./helpers.js";

// haril factory message and answer, as a person uses them: durable, and refused when nothing would read them.

const clock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
const rules = {
  canTransition,
  checkPlan: checkPlanSubmission,
  checkAcceptance,
  checkTaskKind,
  canonicalJson,
};

let sb: Sandbox;
let store: Store;
let projectId: string;

function run(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = factory(
    [...args, "--data-dir", sb.dataDir],
    { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } as never,
    { env: {}, cwd: sb.root } as never,
  );
  return { code, out, err };
}

beforeEach(() => {
  sb = makeSandbox();
  store = openStore({ dataDir: sb.dataDir, clock, ids: { next: () => randomUUID() }, rules });
  ({ projectId } = store.projects.register({ slug: "demo", name: "Demo", rootPath: sb.root }));
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      intake: workflowIntake(sb.root),
      goal: "Decide",
      model: "fake/opus",
      agent: "fake:orchestrate",
      autonomy: { mode: "autonomous", stops: [] },
      budgetTokens: 200_000,
      timeoutMs: 60_000,
    },
    idempotencyKey: "wf",
    requestHash: "wf",
  });
});

afterEach(() => {
  store.close();
  sb.cleanup();
});

describe("haril factory message and answer", () => {
  it("say how to use them, and refuse an unknown agent", () => {
    expect(run("message").code).not.toBe(0);
    expect(run("message", "nobody", "hola").code).not.toBe(0);
    expect(run("answer", "nothing", "maybe").code).not.toBe(0);
    expect(run("answer", "nothing", "approve").err.join(" ")).toContain("no request");
    expect(run("answer", "nothing", "write").err.join(" ")).toContain("needs your answer");
  });

  it("counts what waits for a person", () => {
    const read = run("requests", "--json");
    expect(read.code).toBe(0);
    expect(JSON.parse(read.out[0] as string)).toMatchObject({
      count: 0,
      requests: [],
      quota: null,
    });
  });

  it("does not lose a request that is answered once and refuses a second answer", () => {
    const raised = store.approvals.requestHuman({
      projectId,
      requestedBy: "run",
      request: {
        schemaVersion: 1,
        reason: "decision",
        who: "web/s",
        delegatedBy: "web",
        workflowId: "w",
        taskId: "t",
        task: "Paso",
        doing: "Espera",
        needs: "Una decisión",
        why: "Porque hay dos caminos",
        ifRefused: "Se queda como está",
        blocks: ["web"],
        action: null,
        notifyThreadId: null,
      },
    });
    expect(raised.ok).toBe(true);
    const id = raised.ok ? raised.value.approval.approvalId : "";
    expect(run("requests", "--json").out[0]).toContain("Una decisión");
    expect(run("answer", id, "write", "por el primero").code).toBe(0);
    expect(store.approvals.get(id)).toMatchObject({
      status: "denied",
      reason: "write: por el primero",
    });
    expect(run("answer", id, "approve").code).not.toBe(0);
  });
});
