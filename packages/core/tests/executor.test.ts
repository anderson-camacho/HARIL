import { describe, expect, it } from "vitest";
import {
  buildAgentSpec,
  checkHandshake,
  completionFor,
  M1_ALLOWED_TOOLS,
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
