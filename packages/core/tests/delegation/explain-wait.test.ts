import { BlockReasonSchema, TaskStateSchema } from "@haril/contracts";
import { describe, expect, it } from "vitest";
import {
  explainWait,
  explainWorkflow,
  WAIT_CODES,
  type WaitInput,
} from "../../src/delegation/explain-wait.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function input(overrides: {
  task?: Partial<WaitInput["task"]>;
  workflow?: Partial<NonNullable<WaitInput["workflow"]>> | null;
  rest?: Partial<Omit<WaitInput, "task" | "workflow">>;
}): WaitInput {
  return {
    task: {
      state: "ready",
      blockReason: null,
      cooldownUntil: null,
      retryReason: null,
      attempt: 1,
      maxAttempts: 3,
      model: "fake/high",
      parentCode: "d1",
      failure: null,
      settled: null,
      ...overrides.task,
    },
    workflow:
      overrides.workflow === null
        ? null
        : { id: "wf-1", state: "running", stopReason: null, ...overrides.workflow },
    dependencies: [],
    cooldowns: [],
    holder: null,
    capacity: { live: 0, max: 2 },
    runtimeAlive: true,
    now: NOW,
    ...overrides.rest,
  };
}

const blockReasons = BlockReasonSchema.anyOf.map((item) => String(item.const));
const taskStates = TaskStateSchema.anyOf.map((item) => String(item.const));

describe("explainWait with no capacity", () => {
  const stopped = (capacityWait: Parameters<typeof explainWait>[0]["capacityWait"]) =>
    explainWait(
      input({
        task: { state: "blocked", blockReason: "cooldown", cooldownUntil: NOW + 60_000 },
        rest: { capacityWait },
      }),
    );

  it("names what was tried, who holds it and when one frees", () => {
    const out = stopped({
      tried: [
        { model: "a/one", cause: "cooldown", until: NOW + 1_800_000 },
        { model: "b/two", cause: "window_5h", until: null },
        { model: "c/three", cause: "below_floor", until: null },
      ],
      holders: [{ model: "a/one", agent: "e3" }],
      frees: NOW + 1_800_000,
    });
    expect(out.code).toBe("blocked_no_capacity");
    expect(out.why).toContain("a/one (en enfriamiento)");
    expect(out.why).toContain("b/two (pasó su ventana de 5 horas)");
    expect(out.why).toContain("c/three (por debajo del piso de su rol)");
    expect(out.why).toContain("a/one lo usa e3");
    expect(out.why).toContain("se libera en 30 min");
    expect(out.until).toBe(NOW + 1_800_000);
    expect(out.needsHuman).toBe(false);
    expect(out.systemAction).toContain("tiempo máximo");
  });

  it("says when it knows neither a model nor an end", () => {
    const out = stopped({ tried: [], holders: [], frees: null });
    expect(out.why).toContain("Ninguno de sus modelos está conectado");
    expect(out.why).toContain("No se sabe cuándo");
    expect(out.until).toBeNull();
  });

  it("does not change a plain cooldown", () => {
    expect(stopped(null).code).toBe("blocked_cooldown");
  });
});

describe("explainWait", () => {
  it("explains every block reason, in words and with a code of its own", () => {
    const codes = new Set<string>();
    for (const reason of blockReasons) {
      const out = explainWait(input({ task: { state: "blocked", blockReason: reason as never } }));
      expect(out.code, reason).toBe(`blocked_${reason}`);
      expect(out.what.length, reason).toBeGreaterThan(5);
      expect(out.why.length, reason).toBeGreaterThan(5);
      expect(out.systemAction.length, reason).toBeGreaterThan(5);
      codes.add(out.code);
    }
    expect(codes.size).toBe(blockReasons.length);
  });

  it("explains every task state in every workflow state, and never leaves a field empty", () => {
    for (const state of taskStates) {
      for (const workflow of ["running", "awaiting_human", "completed", "failed", "stopped"]) {
        const out = explainWait(
          input({
            task: { state: state as never, blockReason: state === "blocked" ? "budget" : null },
            workflow: { state: workflow as never, stopReason: "after_plan" },
          }),
        );
        expect(WAIT_CODES as readonly string[], `${state}/${workflow}`).toContain(out.code);
        expect(out.what, `${state}/${workflow}`).not.toBe("");
        expect(out.why, `${state}/${workflow}`).not.toBe("");
        expect(out.systemAction, `${state}/${workflow}`).not.toBe("");
      }
    }
  });

  it("explains a blocked task with no recorded reason instead of leaving it out", () => {
    const out = explainWait(input({ task: { state: "blocked", blockReason: null } }));
    expect(out.code).toBe("blocked_unknown");
    expect(out.needsHuman).toBe(true);
  });

  it("says exactly what to run or press under the default after_plan stop", () => {
    for (const state of ["ready", "pending"] as const) {
      const out = explainWait(
        input({ task: { state }, workflow: { state: "awaiting_human", stopReason: "after_plan" } }),
      );
      expect(out.code).toBe(`${state}_stopped`);
      expect(out.needsHuman).toBe(true);
      expect(out.systemAction).toContain("haril workflow continue wf-1");
      expect(out.systemAction).toContain("pulsa c");
      expect(out.why).toContain("after_plan");
    }
  });

  it("tells a capacity wait from a task about to start and from a runtime that is not there", () => {
    const full = explainWait(input({ rest: { capacity: { live: 2, max: 2 } } }));
    expect(full.code).toBe("ready_no_capacity");
    expect(full.why).toContain("2 de 2");
    expect(full.needsHuman).toBe(false);
    expect(explainWait(input({})).code).toBe("ready_next");
    const none = explainWait(input({ rest: { runtimeAlive: false } }));
    expect(none.code).toBe("ready_no_runtime");
    expect(none.needsHuman).toBe(true);
    expect(none.systemAction).toContain("haril start");
  });

  it("names the holder of a contended surface when it is known", () => {
    const out = explainWait(
      input({
        task: { state: "blocked", blockReason: "surface_conflict" },
        rest: { holder: { code: "e2", model: "fake/mid" } },
      }),
    );
    expect(out.why).toContain("e2");
  });

  it("gives a cooldown its end, from the task or from the model's cooldown", () => {
    const own = explainWait(
      input({ task: { state: "blocked", blockReason: "cooldown", cooldownUntil: NOW + MINUTE } }),
    );
    expect(own.until).toBe(NOW + MINUTE);
    expect(own.needsHuman).toBe(false);
    const fromModel = explainWait(
      input({
        task: { state: "blocked", blockReason: "cooldown" },
        rest: { cooldowns: [{ model: "fake/high", until: NOW + 5 * MINUTE, reason: "429" }] },
      }),
    );
    expect(fromModel.until).toBe(NOW + 5 * MINUTE);
    expect(fromModel.why).toContain("429");
    const ready = explainWait(
      input({ rest: { cooldowns: [{ model: "fake/high", until: NOW + MINUTE, reason: "402" }] } }),
    );
    expect(ready.code).toBe("ready_model_cooldown");
    expect(ready.until).toBe(NOW + MINUTE);
    const past = explainWait(
      input({ task: { state: "blocked", blockReason: "cooldown", cooldownUntil: NOW - MINUTE } }),
    );
    expect(past.why).toContain("ya venció");
  });

  it("lists the dependencies a pending task waits for, and only the open ones", () => {
    const out = explainWait(
      input({
        task: { state: "pending" },
        rest: {
          dependencies: [
            { code: "e1", state: "running" },
            { code: "e2", state: "completed" },
            { code: "e3", state: "ready" },
          ],
        },
      }),
    );
    expect(out.code).toBe("pending_deps");
    expect(out.why).toContain("e1, e3");
    expect(out.why).not.toContain("e2");
  });

  it("says who a failed task went back to, or that it came to the human", () => {
    const toParent = explainWait(input({ task: { state: "failed", failure: "agent.timeout" } }));
    expect(toParent.code).toBe("failed");
    expect(toParent.why).toContain("agent.timeout");
    expect(toParent.systemAction).toContain("d1");
    expect(toParent.needsHuman).toBe(false);
    const toHuman = explainWait(input({ task: { state: "failed", parentCode: null } }));
    expect(toHuman.needsHuman).toBe(true);
  });

  it("counts a retry while the task waits for its next attempt", () => {
    const out = explainWait(input({ task: { retryReason: "transient", attempt: 2 } }));
    expect(out.code).toBe("ready_retry");
    expect(out.why).toContain("2 de 3");
  });

  it("explains the turns that ended but still wait inside the delegation", () => {
    for (const [settled, code] of [
      ["waits_audit", "completed_waits_audit"],
      ["escalated", "completed_escalated"],
      ["waits_final_audit", "completed_waits_final_audit"],
      ["audit_failed", "failed_audit"],
      ["audit_rejected", "audit_rejected"],
      ["closed_idle", "closed_idle"],
    ] as const) {
      const out = explainWait(input({ task: { state: "completed", settled } }));
      expect(out.code).toBe(code);
    }
  });

  it("does not depend on a workflow: a loose task is explained too", () => {
    expect(explainWait(input({ workflow: null, task: { state: "ready" } })).code).toBe(
      "ready_next",
    );
  });
});

describe("explainWorkflow", () => {
  const base = { id: "wf-1" };

  it("names each kind of stop and the command that lifts it", () => {
    for (const stop of [
      "after_plan",
      "after_node:part-1",
      "before_merge",
      "on_audit_failure",
      "at_end",
      "on_budget_pct:80",
    ]) {
      const out = explainWorkflow({ ...base, state: "awaiting_human", stopReason: stop });
      expect(out.needsHuman, stop).toBe(true);
      expect(out.systemAction, stop).toContain("haril workflow continue wf-1");
      expect(out.why, stop).toContain(stop);
    }
  });

  it("explains a stop it does not know instead of leaving it out", () => {
    const out = explainWorkflow({ ...base, state: "awaiting_human", stopReason: null });
    expect(out.code).toBe("workflow_stop");
    expect(out.why).not.toBe("");
  });

  it("explains the other states", () => {
    expect(explainWorkflow({ ...base, state: "running", stopReason: null }).code).toBe(
      "workflow_running",
    );
    expect(explainWorkflow({ ...base, state: "completed", stopReason: null }).code).toBe(
      "workflow_completed",
    );
    const failed = explainWorkflow({ ...base, state: "failed", stopReason: "no_capacity" });
    expect(failed.code).toBe("workflow_failed");
    expect(failed.why).toContain("no_capacity");
    expect(failed.needsHuman).toBe(true);
    expect(explainWorkflow({ ...base, state: "stopped", stopReason: "user_stop" }).code).toBe(
      "workflow_stopped",
    );
  });
});
