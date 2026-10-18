import { describe, expect, it } from "vitest";
import { createProcessControl } from "../src/index.js";

// The start-time query in batches (docs/modos-y-delegacion.md 3.14): every pid in one PowerShell command line failed
// silently past 32,767 characters (about 4,600 pids), and every recorded process then stayed unverified forever. The
// query now asks a bounded batch per call, and a batch that fails leaves only its own pids unchecked (null). The command
// runner is injected, so no process starts here.

const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;

function fileTime(ms: number): string {
  return String(BigInt(ms + FILETIME_EPOCH_OFFSET_MS) * 10_000n);
}

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

function windowsRunner(failWhenAsked: ReadonlySet<number>) {
  const calls: Call[] = [];
  const run = async (command: string, args: readonly string[]): Promise<string> => {
    calls.push({ command, args });
    const script = args[args.length - 1] ?? "";
    const match = /Get-Process -Id ([\d,]+)/.exec(script);
    const pids = match === null ? [] : (match[1] as string).split(",").map(Number);
    if (pids.some((pid) => failWhenAsked.has(pid))) return "";
    return pids.map((pid) => `${pid} ${fileTime(1_800_000_000_000 + pid)}`).join("\r\n");
  };
  return { calls, run };
}

describe("startTimes on Windows", () => {
  it("asks for the pids in batches whose command lines stay short", async () => {
    const pids = Array.from({ length: 5_000 }, (_, index) => 10_000 + index);
    const runner = windowsRunner(new Set());
    const control = createProcessControl({ platform: "win32", env: {}, run: runner.run });
    const times = await control.startTimes(pids);
    expect(runner.calls.length).toBe(Math.ceil(pids.length / 500));
    for (const call of runner.calls) {
      expect([call.command, ...call.args].join(" ").length).toBeLessThan(32_767);
    }
    expect(times?.size).toBe(pids.length);
    expect(times?.get(10_000)).toBe(1_800_000_000_000 + 10_000);
  });

  it("leaves only a failed batch's pids unchecked", async () => {
    const pids = Array.from({ length: 1_200 }, (_, index) => 20_000 + index);
    const runner = windowsRunner(new Set([20_700]));
    const control = createProcessControl({ platform: "win32", env: {}, run: runner.run });
    const times = await control.startTimes(pids);
    expect(times).toBeDefined();
    const unchecked = pids.filter((pid) => times?.get(pid) === null);
    expect(unchecked).toContain(20_700);
    expect(unchecked.length).toBeGreaterThan(0);
    expect(unchecked.length).toBeLessThanOrEqual(500);
    expect(times?.get(20_000)).toBe(1_800_000_000_000 + 20_000);
    expect(times?.get(21_199)).toBe(1_800_000_000_000 + 21_199);
  });

  it("says the OS could not be read when every batch failed", async () => {
    const runner = windowsRunner(new Set([process.pid]));
    const control = createProcessControl({ platform: "win32", env: {}, run: runner.run });
    expect(await control.startTimes([30_000, 30_001])).toBeUndefined();
  });
});
