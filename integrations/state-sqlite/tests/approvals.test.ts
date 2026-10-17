import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type StoreError } from "../src/index.js";
import { fixedClock, sequentialIds, testRules } from "./support.js";

// Approvals (LD-T3, ARCH 4.3, 9.5; schemas 16): a plan is proposed as a requested approval, a human decides it once, and
// the runtime marks the decision applied. A decision is a declaration, not an authentication (ARCH 9.12).
const EXAMPLE_VALID = fileURLToPath(new URL("../../../examples/plan.valid.json", import.meta.url));
const EXAMPLE_CYCLE = fileURLToPath(new URL("../../../examples/plan.cycle.json", import.meta.url));

let store: Store;
let projectId: string;
let epoch: number;

function readPlan(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

beforeEach(() => {
  store = openMemoryStore({ clock: fixedClock(), ids: sequentialIds(), rules: testRules });
  projectId = store.projects.register({
    slug: "demo",
    name: "Demo",
    rootPath: "D:/demo",
  }).projectId;
  const grant = store.runtime.acquire({
    pid: 1,
    nodeVersion: "v24.19.0",
    sqliteVersion: "3.53.3",
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  epoch = grant.value.epoch;
});

afterEach(() => {
  store.close();
});

function eventTypes(aggregateId: string): string[] {
  return store.events.list({ aggregateId }).map((event) => event.type);
}

// Proposes the valid example plan and returns its approval id.
function proposeValid(): string {
  const proposed = store.approvals.proposePlan({
    projectId,
    plan: readPlan(EXAMPLE_VALID),
    requestedBy: "cli",
  });
  if (!proposed.ok) throw new Error("the example plan should be valid");
  return proposed.value.approval.approvalId;
}

function errorOf(work: () => unknown): StoreError {
  try {
    work();
  } catch (error) {
    return error as StoreError;
  }
  throw new Error("expected a store error");
}

describe("approvals.proposePlan", () => {
  it("creates a requested approval for a valid plan, with the plan as subject and its hash", () => {
    const result = store.approvals.proposePlan({
      projectId,
      plan: readPlan(EXAMPLE_VALID),
      requestedBy: "cli",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);
    const approval = result.value.approval;
    expect(approval).toMatchObject({
      projectId,
      kind: "plan",
      status: "requested",
      requestedBy: "cli",
      decidedAt: null,
      decidedBy: null,
      appliedAt: null,
    });
    expect(approval.subjectSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((approval.subject.tasks as unknown[]).length).toBe(4);
    expect(eventTypes(approval.approvalId)).toEqual(["approval.requested"]);
  });

  it("rejects an invalid plan with the reason plan.submit gives, and stores nothing", () => {
    const proposed = store.approvals.proposePlan({
      projectId,
      plan: readPlan(EXAMPLE_CYCLE),
      requestedBy: "cli",
    });
    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.error.code).toBe("plan.invalid");
    expect(proposed.error.message).toContain("cycle");

    store.commands.enqueue({
      type: "plan.submit",
      projectId,
      args: { plan: readPlan(EXAMPLE_CYCLE) },
      idempotencyKey: "cycle-submit",
      requestHash: "cycle-submit",
    });
    const applied = store.commands.applyNext(epoch);
    expect(applied?.outcome).toBe("rejected");
    expect(applied?.reason).toBe(proposed.error.message);
    expect(store.approvals.list()).toHaveLength(0);
  });

  it("returns the same pending approval when the same plan is proposed again", () => {
    const id = proposeValid();
    const again = store.approvals.proposePlan({
      projectId,
      plan: readPlan(EXAMPLE_VALID),
      requestedBy: "cli",
    });
    if (!again.ok) throw new Error("the example plan should be valid");
    expect(again.value.created).toBe(false);
    expect(again.value.approval.approvalId).toBe(id);
    expect(store.approvals.list({ status: "requested" })).toHaveLength(1);
    expect(eventTypes(id)).toEqual(["approval.requested"]);
  });

  it("creates a new approval for the same plan once the earlier one has been decided", () => {
    const id = proposeValid();
    store.approvals.decide({ approvalId: id, outcome: "denied", decidedBy: "ana" });
    const again = store.approvals.proposePlan({
      projectId,
      plan: readPlan(EXAMPLE_VALID),
      requestedBy: "cli",
    });
    if (!again.ok) throw new Error("the example plan should be valid");
    expect(again.value.created).toBe(true);
    expect(again.value.approval.approvalId).not.toBe(id);
  });
});

describe("approvals.decide", () => {
  it("grants a requested approval, records who decided and why, and emits approval.granted", () => {
    const id = proposeValid();
    const decided = store.approvals.decide({
      approvalId: id,
      outcome: "granted",
      decidedBy: "ana",
      reason: "looks right",
    });
    expect(decided).toMatchObject({
      status: "granted",
      decidedBy: "ana",
      reason: "looks right",
      appliedAt: null,
    });
    expect(decided.decidedAt).not.toBeNull();
    expect(eventTypes(id)).toEqual(["approval.requested", "approval.granted"]);
  });

  it("a second decision on the same approval is a store.conflict and changes nothing", () => {
    const id = proposeValid();
    store.approvals.decide({ approvalId: id, outcome: "denied", decidedBy: "ana" });
    const error = errorOf(() =>
      store.approvals.decide({ approvalId: id, outcome: "granted", decidedBy: "ben" }),
    );
    expect(error.code).toBe("store.conflict");
    expect(store.approvals.get(id)).toMatchObject({ status: "denied", decidedBy: "ana" });
  });

  it("an unknown approval is a store.not_found", () => {
    const error = errorOf(() =>
      store.approvals.decide({ approvalId: "missing", outcome: "granted", decidedBy: "ana" }),
    );
    expect(error.code).toBe("store.not_found");
  });

  it("lists by project and by status", () => {
    const other = store.projects.register({ slug: "other", name: "Other", rootPath: "D:/other" });
    const id = proposeValid();
    store.approvals.proposePlan({
      projectId: other.projectId,
      plan: readPlan(EXAMPLE_VALID),
      requestedBy: "cli",
    });
    store.approvals.decide({ approvalId: id, outcome: "granted", decidedBy: "ana" });
    expect(store.approvals.list({ projectId })).toHaveLength(1);
    expect(store.approvals.list({ status: "requested" })).toHaveLength(1);
    expect(store.approvals.list({ status: "granted" })).toHaveLength(1);
    expect(store.approvals.list()).toHaveLength(2);
  });
});

describe("approvals applied by the runtime", () => {
  it("a denied decision is applied without queuing anything", () => {
    const id = proposeValid();
    store.approvals.decide({ approvalId: id, outcome: "denied", decidedBy: "ana" });
    expect(store.approvals.listUnapplied().map((approval) => approval.approvalId)).toEqual([id]);

    expect(store.approvals.markApplied(id, epoch)).toBe(true);
    expect(store.approvals.listUnapplied()).toHaveLength(0);
    expect(store.commands.listQueued()).toHaveLength(0);
    expect(store.approvals.get(id)?.appliedAt).not.toBeNull();
    expect(eventTypes(id)).toEqual(["approval.requested", "approval.denied", "approval.applied"]);
  });

  it("marking an applied decision again changes nothing and emits no second event", () => {
    const id = proposeValid();
    store.approvals.decide({ approvalId: id, outcome: "granted", decidedBy: "ana" });
    expect(store.approvals.markApplied(id, epoch)).toBe(true);
    expect(store.approvals.markApplied(id, epoch)).toBe(false);
    expect(eventTypes(id).filter((type) => type === "approval.applied")).toHaveLength(1);
  });

  it("a requested approval is not unapplied and does not hold the lease", () => {
    proposeValid();
    expect(store.approvals.listUnapplied()).toHaveLength(0);
    expect(store.runtime.releaseIfIdle(epoch)).toBe(true);
  });

  it("a granted decision that is not applied yet keeps the lease, until it is applied", () => {
    const id = proposeValid();
    store.approvals.decide({ approvalId: id, outcome: "granted", decidedBy: "ana" });
    expect(store.runtime.releaseIfIdle(epoch)).toBe(false);
    expect(store.approvals.markApplied(id, epoch)).toBe(true);
    expect(store.runtime.releaseIfIdle(epoch)).toBe(true);
  });

  it("refuses to mark an approval applied with a fenced epoch", () => {
    const id = proposeValid();
    store.approvals.decide({ approvalId: id, outcome: "granted", decidedBy: "ana" });
    const error = errorOf(() => store.approvals.markApplied(id, epoch + 1));
    expect(error.code).toBe("store.fenced");
    expect(store.approvals.get(id)?.appliedAt).toBeNull();
  });
});
