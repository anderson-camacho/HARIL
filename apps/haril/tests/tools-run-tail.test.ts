import { describe, expect, it } from "vitest";
import { runTail } from "../src/tools/system.js";

// The runner behind `go install`, exercised with real node child processes: no shell, the last lines of the output,
// a timeout, an abort and the exact environment.

const NODE = process.execPath;
const script = (code: string) => ["-e", code];

describe("runTail", () => {
  it("keeps only the last 20 lines of the output", async () => {
    const code = `for (let i = 1; i <= 50; i++) process.stdout.write("line " + i + "\\n");`;
    const result = await runTail(NODE, script(code), { timeoutMs: 15_000 });
    expect(result.code).toBe(0);
    const lines = result.output.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(20);
    expect(lines[19]).toBe("line 50");
    expect(lines[0]).toBe("line 31");
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBeUndefined();
  });

  it("reports a non-zero exit with the output that explains it", async () => {
    const code = `console.error("go: no such module"); process.exit(3);`;
    const result = await runTail(NODE, script(code), { timeoutMs: 15_000 });
    expect(result.code).toBe(3);
    expect(result.output).toContain("go: no such module");
  });

  it("bounds a very long line so one line cannot fill the report", async () => {
    const code = `process.stdout.write("x".repeat(100000) + "\\nend\\n");`;
    const result = await runTail(NODE, script(code), { timeoutMs: 15_000 });
    expect(result.output.length).toBeLessThan(5000);
    expect(result.output).toContain("end");
  });

  it("passes arguments to the program without a shell", async () => {
    const code = `console.log(process.argv[1]);`;
    const result = await runTail(NODE, [...script(code), "a & echo injected"], {
      timeoutMs: 15_000,
    });
    expect(result.output.trim()).toBe("a & echo injected");
  });

  it("gives the child exactly the environment it is given", async () => {
    const code = `console.log(JSON.stringify([process.env.HARIL_TAIL_A, process.env.HARIL_TAIL_B ?? null]));`;
    const env = { ...process.env, HARIL_TAIL_A: "one" } as Record<string, string>;
    delete env.HARIL_TAIL_B;
    const result = await runTail(NODE, script(code), { timeoutMs: 15_000, env });
    expect(JSON.parse(result.output.trim())).toEqual(["one", null]);
  });

  it("kills a program that outlives its timeout", async () => {
    const started = Date.now();
    const result = await runTail(NODE, script(`setInterval(() => {}, 1000);`), { timeoutMs: 400 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("kills a program when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = runTail(NODE, script(`setInterval(() => {}, 1000);`), {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("does not start a program when the signal is already aborted", async () => {
    const marker = `HARIL_TAIL_${Date.now()}`;
    const result = await runTail(NODE, script(`console.log("${marker}")`), {
      timeoutMs: 15_000,
      signal: AbortSignal.abort(),
    });
    expect(result.aborted).toBe(true);
    expect(result.output).not.toContain(marker);
  });

  it("reports a program that cannot start instead of throwing", async () => {
    const result = await runTail("haril-no-such-program-xyz", [], { timeoutMs: 5_000 });
    expect(result.code).toBeNull();
    expect(result.error).toBeDefined();
  });
});
