import { describe, expect, it } from "vitest";
import {
  buildAgentSpec,
  checkHandshake,
  completionFor,
  M1_ALLOWED_TOOLS,
  PLAN_ALLOWED_TOOLS,
  PROPOSE_PLAN_TOOL,
  planAttemptOutcome,
  REAL_AGENT_REFS,
} from "../src/executor/index.js";

// Pure executor rules (M1-T5): the AgentSpec built from a task, the handshake check and the
// mapping of an agent outcome to the run completion persisted by the Store.

const task = {
  taskId: "t-1",
  goal: "Survey the README",
  description: "List the headings.",
  agentRef: "fake:succeed",
  timeoutMs: 5000,
};

describe("buildAgentSpec", () => {
  it("builds the spec with the fixed M1 tool list and the task prompt", () => {
    const spec = buildAgentSpec(task, { runId: "run-1", attempt: 2 });
    expect(spec).toEqual({
      runId: "run-1",
      taskId: "t-1",
      attempt: 2,
      agentRef: "fake:succeed",
      allowedTools: ["read"],
      prompt: "Survey the README\n\nList the headings.",
      timeoutMs: 5000,
    });
    expect(M1_ALLOWED_TOOLS).toEqual(["read"]);
  });

  it("omits the blank line when the description is empty", () => {
    const spec = buildAgentSpec({ ...task, description: "" }, { runId: "r", attempt: 1 });
    expect(spec.prompt).toBe("Survey the README");
  });

  // LD-T4: a plan task reads and proposes; every other kind keeps the single read tool and the plain prompt.
  it("keeps the read tool and the task prompt for a work task, and carries the kind", () => {
    const spec = buildAgentSpec({ ...task, kind: "work" }, { runId: "r", attempt: 1 });
    expect(spec.kind).toBe("work");
    expect(spec.allowedTools).toEqual(["read"]);
    expect(spec.prompt).toBe("Survey the README\n\nList the headings.");
  });

  it("gives a plan task the proposal tool and a planner prompt that states the goal and the plan shape", () => {
    const spec = buildAgentSpec(
      { ...task, kind: "plan", agentRef: "fake:plan" },
      { runId: "r", attempt: 1 },
    );
    expect(PROPOSE_PLAN_TOOL).toBe("haril_propose_plan");
    expect(PLAN_ALLOWED_TOOLS).toEqual(["read", "haril_propose_plan"]);
    expect(spec.kind).toBe("plan");
    expect(spec.allowedTools).toEqual(["read", "haril_propose_plan"]);
    // The goal comes first, as in every prompt, then the description and the instructions.
    expect(spec.prompt.split("\n")[0]).toBe("Survey the README");
    expect(spec.prompt).toContain("List the headings.");
    expect(spec.prompt).toContain("haril_propose_plan");
    expect(spec.prompt).toContain('"schemaVersion": 1');
    expect(spec.prompt).toContain("1 to 5 tasks");
    expect(spec.prompt).toContain("read-only");
    for (const field of [
      "localId",
      "dependsOn",
      "goal",
      "description",
      "priority",
      "kind",
      "agent",
      "requires",
      "context",
      "surface",
      "budget",
      "timeoutMs",
      "maxAttempts",
      "acceptance",
    ]) {
      expect(spec.prompt).toContain(`"${field}"`);
    }
  });

  // LD-T7c: the first real demo planned a task that drafted a file for an agent that cannot write. The planner is told
  // what the analyst can do, where the content of a file goes, and what a description must add.
  it("tells the planner what the analyst can and cannot do, and where the content of a file goes", () => {
    const { prompt } = buildAgentSpec(
      { ...task, kind: "plan", agentRef: "planner" },
      { runId: "r", attempt: 1 },
    );
    expect(prompt).toMatch(/"analyst" reads project files and answers in its result text/);
    expect(prompt).toMatch(/cannot write files or run commands/);
    expect(prompt).toMatch(/never a copy of the goal/);
    // LD-T7c fix: the read surface reaches the agent as the files to read, and it is not an access limit.
    expect(prompt).toMatch(
      /"surface\.read" lists the files the task tells it to read; it is not an access limit/,
    );
    // The second real demo's planner said "write CONTRIBUTING.md" to an agent that cannot write.
    expect(prompt).toContain(
      'the goal of the last task says "Return the full content of <file> as the result", never "write"',
    );
    // The third real demo planned a task that only read the README, with a check on the later file's name: tasks do not
    // see each other's results, so that task could never pass and the whole plan failed.
    expect(prompt).toMatch(/Tasks do not see each other's results/);
    expect(prompt).toMatch(/a task that only reads produces nothing/);
    expect(prompt).toMatch(/An acceptance check tests the text of that task's own result/);
  });

  // LD-T7c fix: the planner's surface.read reaches the agent; without one the prompt is the goal and the description.
  it("names the files of the read surface in the prompt, after the description", () => {
    const reads = buildAgentSpec(
      { ...task, surfaceRead: ["README.md", "docs/guide.md"] },
      { runId: "r", attempt: 1 },
    );
    expect(reads.prompt).toBe(
      "Survey the README\n\nList the headings.\n\nFiles to read: README.md, docs/guide.md",
    );
    const none = buildAgentSpec({ ...task, surfaceRead: [] }, { runId: "r", attempt: 1 });
    expect(none.prompt).toBe("Survey the README\n\nList the headings.");
  });

  // LD-T7c fix: the analyst of the second real demo wrapped the requested file in chat and a code fence.
  it("tells the analyst to answer in its result, and to return a requested file's content alone", () => {
    const { prompt } = buildAgentSpec(
      { ...task, agentRef: "analyst", surfaceRead: ["README.md"] },
      { runId: "r", attempt: 1 },
    );
    expect(
      prompt.startsWith("Survey the README\n\nList the headings.\n\nFiles to read: README.md"),
    ).toBe(true);
    expect(prompt).toContain(
      "Do what the goal asks and put your complete answer in your result text; you cannot write files or run commands.",
    );
    expect(prompt).toContain(
      "When the goal asks for the content of a file, the result is that content alone: no preamble, no closing remarks and no code fence around it.",
    );
  });

  it("serves the planner archetype in the real lane, like the analyst", () => {
    expect(REAL_AGENT_REFS).toEqual(["analyst", "planner"]);
  });
});

describe("planAttemptOutcome", () => {
  const succeeded = { status: "succeeded", summary: "done" } as const;

  it("fails a succeeded plan attempt that proposed nothing as plan.not_proposed", () => {
    expect(planAttemptOutcome("plan", succeeded, false)).toEqual({
      status: "failed",
      code: "plan.not_proposed",
      message: expect.stringContaining("haril_propose_plan"),
    });
  });

  it("fails a succeeded plan attempt whose every proposal was refused with the last refusal as plan.refused", () => {
    expect(
      planAttemptOutcome("plan", succeeded, false, "invalid plan: schemaVersion must be 1"),
    ).toEqual({
      status: "failed",
      code: "plan.refused",
      message: "invalid plan: schemaVersion must be 1",
    });
    // A refusal before an accepted proposal does not matter: the attempt proposed.
    expect(planAttemptOutcome("plan", succeeded, true, "an earlier refusal")).toBe(succeeded);
  });

  it("keeps a plan attempt that proposed, any other kind, and every unsuccessful outcome", () => {
    expect(planAttemptOutcome("plan", succeeded, true)).toBe(succeeded);
    expect(planAttemptOutcome("work", succeeded, false)).toBe(succeeded);
    expect(planAttemptOutcome(undefined, succeeded, false)).toBe(succeeded);
    const failed = { status: "failed", code: "fake.failed", message: "no" } as const;
    expect(planAttemptOutcome("plan", failed, false)).toBe(failed);
    expect(planAttemptOutcome("plan", { status: "timed_out" }, false)).toEqual({
      status: "timed_out",
    });
  });
});

describe("checkHandshake", () => {
  it("accepts an announced list equal to allowedTools, in any order", () => {
    expect(checkHandshake(["read", "grep"], ["grep", "read"])).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("rejects a list with an extra or missing tool as handshake_mismatch", () => {
    const extra = checkHandshake(["read"], ["read", "write"]);
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error.code).toBe("handshake_mismatch");
    const missing = checkHandshake(["read", "grep"], ["read"]);
    expect(missing.ok).toBe(false);
  });
});

describe("completionFor", () => {
  it("maps a success to a succeeded completion carrying the summary as result", () => {
    expect(completionFor("run-1", { status: "succeeded", summary: "done" })).toEqual({
      runId: "run-1",
      outcome: "succeeded",
      result: { summary: "done" },
    });
  });

  it("maps a simulated success to a result that marks the run as simulated (M1 fix a)", () => {
    expect(
      completionFor("run-1", {
        status: "succeeded",
        summary: "simulated: no real agent until M2",
        simulated: true,
      }),
    ).toEqual({
      runId: "run-1",
      outcome: "succeeded",
      result: { simulated: true },
    });
  });

  it("maps a failure to a failed completion with the exit end cause", () => {
    expect(
      completionFor("run-1", { status: "failed", code: "fake.failed", message: "boom" }),
    ).toEqual({
      runId: "run-1",
      outcome: "failed",
      error: { code: "fake.failed", message: "boom" },
      endCause: "exit",
    });
  });

  it("maps a timeout to a failed completion with the timeout end cause", () => {
    expect(completionFor("run-1", { status: "timed_out" })).toMatchObject({
      outcome: "failed",
      error: { code: "timeout" },
      endCause: "timeout",
    });
  });

  it("maps an abort to a failed completion with code aborted", () => {
    expect(completionFor("run-1", { status: "aborted" })).toMatchObject({
      outcome: "failed",
      error: { code: "aborted" },
      endCause: "exit",
    });
  });
});
