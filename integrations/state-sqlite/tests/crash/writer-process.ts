import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Parent side of the writer children (writer.mjs): starts one, reads the ids it confirms, and kills it with SIGKILL.
const CRASH_DIR = fileURLToPath(new URL(".", import.meta.url));

export interface WriterProcess {
  readonly child: ChildProcess;
  // Task ids the child printed after their commit returned (complete lines only).
  readonly confirmed: string[];
  // Resolves once the child has opened the store and holds the lease.
  readonly ready: Promise<void>;
  // Resolves when the child has exited and its output is closed.
  readonly closed: Promise<void>;
  stderr(): string;
}

export function startWriter(dataDir: string, projectId: string): WriterProcess {
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(join(CRASH_DIR, "register.mjs")).href,
      join(CRASH_DIR, "writer.mjs"),
      dataDir,
      projectId,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const confirmed: string[] = [];
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
    const lines = pending.split("\n");
    // The last element is an incomplete line (or ""): it is not a confirmed id.
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "ready") markReady();
      else if (line !== "") confirmed.push(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString("utf8");
  });
  const closed = new Promise<void>((resolve) => {
    child.on("close", () => {
      failReady(new Error(`writer exited before ready: ${errors}`));
      resolve();
    });
    child.on("error", (error) => failReady(error));
  });
  // A ready promise that nobody awaits must not surface as an unhandled rejection after the child exits.
  ready.catch(() => undefined);
  return {
    child,
    confirmed,
    ready,
    closed,
    stderr: () => errors,
  };
}

// SIGKILL, then waits until the pipes are closed. Returns the ids confirmed before the kill. A child that had already
// exited on its own failed for a reason other than the kill, so it throws with the child's stderr.
export async function killWriter(writer: WriterProcess): Promise<readonly string[]> {
  if (writer.child.exitCode !== null) {
    await writer.closed;
    throw new Error(
      `writer exited before the kill (code ${writer.child.exitCode}): ${writer.stderr()}`,
    );
  }
  writer.child.kill("SIGKILL");
  await writer.closed;
  return [...writer.confirmed];
}

// Polls a condition the test can reason about (for example "the child confirmed N more tasks"), never a fixed sleep.
export async function waitUntil(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
