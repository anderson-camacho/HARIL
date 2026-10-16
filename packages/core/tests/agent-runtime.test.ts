import { describe, expect, it } from "vitest";
import type { AgentHandle, AgentSpec } from "../src/ports/index.js";
import { FakeAgentRuntime, FakeClock } from "../testing/index.js";

// Contract suite for the AgentRuntime port, run against FakeAgentRuntime (M1-D7).
// Time is virtual: FakeClock.advance(ms) fires the timers the fake scheduled.

const TOOLS = ["read", "write"];

function spec(agentRef: string, timeoutMs = 1000): AgentSpec {
  return {
    runId: "run-1",
    taskId: "task-1",
    attempt: 1,
    agentRef,
    allowedTools: TOOLS,
    prompt: "do the work",
    timeoutMs,
  };
}

function setup(helloTools?: (allowed: readonly string[]) => readonly string[]) {
  const clock = new FakeClock();
  const runtime = new FakeAgentRuntime({ clock, helloTools });
  return { clock, runtime };
}

async function startHandle(runtime: FakeAgentRuntime, agentSpec: AgentSpec): Promise<AgentHandle> {
  const result = await runtime.start(agentSpec);
  if (!result.ok) throw new Error(`start failed: ${result.error.code}`);
  return result.value;
}

// Lets pending promise continuations run without relying on host timers.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("AgentRuntime contract (FakeAgentRuntime)", () => {
  it("hello lists exactly the allowedTools of the spec", async () => {
    const { runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:succeed"));
    expect((await handle.hello).tools).toEqual(TOOLS);
  });

  it("fake:succeed settles succeeded once the prompt is accepted", async () => {
    const { runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:succeed"));
    const prompted = await handle.prompt("go");
    expect(prompted.ok).toBe(true);
    expect((await handle.settled).status).toBe("succeeded");
  });

  it("fake:fail settles failed with a stable code", async () => {
    const { runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:fail"));
    await handle.prompt("go");
    const outcome = await handle.settled;
    expect(outcome).toMatchObject({ status: "failed", code: "fake.failed" });
  });

  it("fake:slow:<ms> settles succeeded only after that much virtual time", async () => {
    const { clock, runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:slow:500", 1000));
    await handle.prompt("go");
    let settled = false;
    void handle.settled.then(() => {
      settled = true;
    });

    clock.advance(499);
    await flush();
    expect(settled).toBe(false);

    clock.advance(1);
    await flush();
    expect(settled).toBe(true);
    expect((await handle.settled).status).toBe("succeeded");
  });

  it("settles timed_out at timeoutMs when the work is slower than the timeout", async () => {
    const { clock, runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:slow:5000", 1000));
    await handle.prompt("go");
    clock.advance(1000);
    expect(await handle.settled).toEqual({ status: "timed_out" });
  });

  it("abort settles aborted and cancels the pending work", async () => {
    const { clock, runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:slow:500", 1000));
    await handle.prompt("go");
    await handle.abort();
    expect(await handle.settled).toEqual({ status: "aborted" });
    clock.advance(2000);
    await flush();
    expect((await handle.settled).status).toBe("aborted");
  });

  it("a hello list that differs from allowedTools rejects the prompt and fails the run", async () => {
    const { runtime } = setup(() => ["read", "delete_everything"]);
    const handle = await startHandle(runtime, spec("fake:succeed"));
    const prompted = await handle.prompt("go");
    expect(prompted.ok).toBe(false);
    if (!prompted.ok) expect(prompted.error.code).toBe("agent.handshake_mismatch");
    expect(await handle.settled).toMatchObject({
      status: "failed",
      code: "agent.handshake_mismatch",
    });
  });

  it("dispose is idempotent and never throws", async () => {
    const { runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:slow:500", 1000));
    await handle.prompt("go");
    await handle.dispose();
    await handle.dispose();
    expect(await handle.settled).toEqual({ status: "aborted" });
  });

  it("start rejects an agentRef the fake does not know, with a typed error", async () => {
    const { runtime } = setup();
    const result = await runtime.start(spec("fake:teleport"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("agent.unknown_ref");
  });
});

describe("FakeClock", () => {
  it("runs scheduled callbacks in due order and honours cancellation", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.schedule(20, () => fired.push("b"));
    clock.schedule(10, () => fired.push("a"));
    const cancel = clock.schedule(15, () => fired.push("cancelled"));
    cancel();
    clock.advance(30);
    expect(fired).toEqual(["a", "b"]);
    expect(clock.now()).toBe(30);
  });
});
