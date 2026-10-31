import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { estimateTokens } from "@haril/core";
import {
  createEngramServe,
  type EngramBinary,
  EngramMemoryProvider,
  type EngramSpawnFn,
} from "@haril/memory-engram";

// The real health check of a candidate Engram, before it replaces anything: it is started the way the runtime starts
// it, by the same supervisor and adapter, on a temporary data dir, loopback and a random port, and must prove it is the
// pinned version, the instance of that data dir, and able to answer a real read. Whatever happens, the process tree is
// killed and the data dir deleted.

export interface SmokeInput {
  readonly binary: EngramBinary;
  readonly version: string;
  // A folder of the caller's: the smoke creates <workDir>/data and deletes it again.
  readonly workDir: string;
  // The user's home, only for the guard that keeps the serve out of their ~/.engram.
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly readinessMs?: number;
  // A test's wrapper around the process start.
  readonly spawn?: EngramSpawnFn;
}

type SmokeResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type SmokeFn = (input: SmokeInput) => Promise<SmokeResult>;

const DEFAULT_READINESS_MS = 20_000;

export const engramSmoke: SmokeFn = async (input) => {
  const dataDir = join(input.workDir, "data");
  const serve = createEngramServe({
    binary: input.binary,
    harilDataDir: dataDir,
    homeDir: input.homeDir,
    osEnv: input.env,
    platform: input.platform,
    maxRestarts: 0,
    timings: { readinessMs: input.readinessMs ?? DEFAULT_READINESS_MS },
    ...(input.spawn === undefined ? {} : { spawn: input.spawn }),
  });
  try {
    await mkdir(dataDir, { recursive: true });
    // The serve is launched and proven first, with its own deadline: health() has a shorter one for a running serve.
    const connected = await serve.connect();
    if (!connected.ok) return { ok: false, reason: connected.error.message };
    const provider = new EngramMemoryProvider(
      {
        clock: {
          now: () => Date.now(),
          schedule: (ms, run) => {
            const timer = setTimeout(run, ms);
            return () => clearTimeout(timer);
          },
        },
        ids: { next: () => randomUUID() },
        hasher: { sha256: (text) => createHash("sha256").update(text, "utf8").digest("hex") },
        estimateTokens,
      },
      { connect: () => serve.connect(), engramVersion: input.version, harilDataDir: dataDir },
    );
    const health = await provider.health();
    if (health.state !== "active" || health.realReadOk !== true) {
      const read =
        health.realReadOk === null ? "no read" : health.realReadOk ? "read ok" : "read failed";
      return { ok: false, reason: `health is ${health.state} (${read})` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await serve.stop();
    try {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // The caller removes its whole work folder as well.
    }
  }
};
