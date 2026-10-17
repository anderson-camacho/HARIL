import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Starts a test-only child script with the shared loader (register.mjs, which maps `.js` to `.ts`), collects the
// complete lines it prints, and reports its exit. Used by the multi-process tests; the crash harness uses the same
// loader through writer-process.ts and apps/haril/tests/crash.
const CRASH_DIR = fileURLToPath(new URL(".", import.meta.url));

export interface ChildRun {
  readonly child: ChildProcess;
  // Complete stdout lines, in print order.
  readonly lines: string[];
  // Resolves on the first line equal to `readyLine`.
  readonly ready: Promise<void>;
  // Resolves with the exit code (null when killed by a signal).
  readonly exited: Promise<number | null>;
  stderr(): string;
}

export function startChild(script: string, args: readonly string[], readyLine = "ready"): ChildRun {
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(join(CRASH_DIR, "register.mjs")).href,
      join(CRASH_DIR, script),
      ...args,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines: string[] = [];
  let pending = "";
  let errors = "";
  let markReady: () => void = () => undefined;
  let failReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) {
      if (line === readyLine) markReady();
      lines.push(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      failReady(new Error(`${script} exited before ready (code ${code}): ${errors}`));
      resolve(code);
    });
    child.on("error", (error) => failReady(error));
  });
  // Nobody may await `ready` in every test; an unhandled rejection would fail an unrelated test.
  ready.catch(() => undefined);
  return { child, lines, ready, exited, stderr: () => errors };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
