import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { planProcessKills, processStartWindow } from "@haril/core";
import { createProcessControl } from "@haril/os";

// Process helpers of the tests that run real agent processes (3.14). A test kills only processes it started, and only
// after their start time matched the one it noted: a pid freed by an earlier kill may already name another program.

export interface NotedProcess {
  readonly pid: number;
  readonly startedAt: number;
}

export const processControl = createProcessControl();

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The tool commands the fake Pi started (scenario hang_with_tool): each wrote its pid to <runsDir>/<runId>/fake-tool.pid
// as it started, so the file's time is its start time.
export function toolProcesses(runsDir: string): NotedProcess[] {
  if (!existsSync(runsDir)) return [];
  const found: NotedProcess[] = [];
  for (const runId of readdirSync(runsDir)) {
    const file = join(runsDir, runId, "fake-tool.pid");
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0)
      found.push({ pid, startedAt: statSync(file).mtimeMs });
  }
  return found;
}

// Kills the noted processes that still run as themselves; the rest is left alone.
export async function killNoted(noted: readonly NotedProcess[]): Promise<void> {
  if (noted.length === 0) return;
  const times = await processControl.startTimes(noted.map((item) => item.pid));
  if (times === undefined) return;
  const plan = planProcessKills(noted, times, processStartWindow(process.platform));
  if (plan.kill.length > 0) await processControl.killTrees(plan.kill);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function until(
  condition: () => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
