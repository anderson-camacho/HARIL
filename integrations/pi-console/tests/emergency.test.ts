import { describe, expect, it } from "vitest";
import type { CliResult } from "../src/cli.js";
import { STOP_ALL_TIMEOUT_MS, stopAll } from "../src/emergency.js";

// ■ STOP ALL (3.14.6, P20): no confirmation. It aborts the chat turn first, then runs `haril stop --now`, which stops
// every agent of every mode and leaves the runtime halted until haril resume. When the runtime does not answer, or the
// CLI fails, it says so plainly; the console kills no process itself (the CLI does, from the recorded pid and start).

interface Calls {
  aborts: number;
  runs: { args: readonly string[]; timeoutMs: number | undefined }[];
}

function deps(
  result: CliResult | (() => Promise<CliResult>),
  options: { cli?: boolean; abortThrows?: boolean } = {},
) {
  const calls: Calls = { aborts: 0, runs: [] };
  return {
    calls,
    deps: {
      abort() {
        calls.aborts++;
        if (options.abortThrows === true) throw new Error("no turn");
      },
      cliAvailable: () => options.cli !== false,
      async run(args: readonly string[], runOptions: { timeoutMs?: number }) {
        calls.runs.push({ args, timeoutMs: runOptions.timeoutMs });
        return typeof result === "function" ? result() : result;
      },
    },
  };
}

function report(change: Record<string, unknown> = {}): CliResult {
  return {
    ok: true,
    code: 0,
    stderr: "",
    stdout: `${JSON.stringify({
      commandId: "cmd-1",
      runtime: "stopped",
      queued: false,
      halted: true,
      cancelledTasks: 3,
      stoppedWorkflows: 1,
      processes: { recorded: 4, killed: 0, kept: 0, alive: 0 },
      ...change,
    })}\n`,
  };
}

describe("STOP ALL", () => {
  it("aborts the chat turn and runs haril stop --now, with no confirmation", async () => {
    const { calls, deps: d } = deps(report());
    const outcome = await stopAll(d);
    expect(calls.aborts).toBe(1);
    expect(calls.runs).toEqual([
      { args: ["stop", "--now", "--json"], timeoutMs: STOP_ALL_TIMEOUT_MS },
    ]);
    expect(outcome.level).toBe("info");
    expect(outcome.message).toMatch(/chat turn aborted/);
    expect(outcome.message).toMatch(/3 tasks cancelled, 1 workflow stopped/);
    expect(outcome.message).toMatch(/no agent process left alive/);
    expect(outcome.message).toMatch(/haril resume/);
  });

  it("aborts the chat before the runtime answers", async () => {
    const order: string[] = [];
    const d = {
      abort: () => order.push("abort"),
      cliAvailable: () => true,
      run: async () => {
        order.push("stop");
        return report();
      },
    };
    await stopAll(d);
    expect(order).toEqual(["abort", "stop"]);
  });

  it("still runs the stop when there is no chat turn to abort", async () => {
    const { calls, deps: d } = deps(report(), { abortThrows: true });
    const outcome = await stopAll(d);
    expect(calls.runs).toHaveLength(1);
    expect(outcome.level).toBe("info");
  });

  it("says clearly when the runtime did not answer in time", async () => {
    const { deps: d } = deps(
      report({
        runtime: "unresponsive",
        queued: true,
        processes: { recorded: 2, killed: 2, kept: 0, alive: 0 },
      }),
    );
    const outcome = await stopAll(d);
    expect(outcome.level).toBe("warning");
    expect(outcome.message).toMatch(/runtime did not answer in time/);
    expect(outcome.message).toMatch(/2 killed/);
  });

  it("says when no runtime was running and the stop waits queued", async () => {
    const { deps: d } = deps(
      report({
        runtime: "none",
        commandId: "cmd-2",
        queued: true,
        cancelledTasks: 0,
        stoppedWorkflows: 0,
      }),
    );
    const outcome = await stopAll(d);
    expect(outcome.level).toBe("info");
    expect(outcome.message).toMatch(/no runtime was running/);
    expect(outcome.message).toMatch(/queued/);
  });

  it("reports agent processes still alive as an error", async () => {
    const { deps: d } = deps({
      ...report({ processes: { recorded: 3, killed: 3, kept: 0, alive: 1 } }),
      ok: false,
      code: 1,
    });
    const outcome = await stopAll(d);
    expect(outcome.level).toBe("error");
    expect(outcome.message).toMatch(/1 agent process still alive/);
  });

  it("reports a CLI that timed out as a runtime that did not answer", async () => {
    const { deps: d } = deps({
      ok: false,
      code: null,
      stdout: "",
      stderr: "Command failed: spawn timed out",
    });
    const outcome = await stopAll(d);
    expect(outcome.level).toBe("error");
    expect(outcome.message).toMatch(/did not answer/);
    expect(outcome.message).toMatch(/chat turn aborted/);
  });

  it("reports a CLI failure with its first line", async () => {
    const { deps: d } = deps({
      ok: false,
      code: 2,
      stdout: "",
      stderr: "haril: the store is locked\nmore",
    });
    const outcome = await stopAll(d);
    expect(outcome.level).toBe("error");
    expect(outcome.message).toMatch(/haril stop --now failed: haril: the store is locked$/);
  });

  it("aborts the chat even when HARIL is out of reach", async () => {
    const { calls, deps: d } = deps(report(), { cli: false });
    const outcome = await stopAll(d);
    expect(calls.aborts).toBe(1);
    expect(calls.runs).toHaveLength(0);
    expect(outcome.level).toBe("warning");
    expect(outcome.message).toMatch(/not opened by haril/);
  });

  it("never throws, whatever the CLI does", async () => {
    const { deps: d } = deps(async () => {
      throw new Error("spawn EPERM");
    });
    const outcome = await stopAll(d);
    expect(outcome.level).toBe("error");
    expect(outcome.message).toMatch(/spawn EPERM/);
  });
});
