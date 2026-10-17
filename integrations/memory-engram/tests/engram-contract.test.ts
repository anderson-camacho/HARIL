import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryOperation, MemoryWriteOperation } from "@haril/core/ports";
import {
  describeMemoryProviderContract,
  fakeMemoryDeps,
  type MemoryFaultControls,
} from "@haril/core/testing";
import { afterAll, beforeAll, describe, it } from "vitest";
import { EngramMemoryProvider } from "../src/index.js";
import { FakeEngramServer, type FakeRoute } from "../testing/fake-engram-server.js";

// The MemoryProvider contract suite (memory.md 8.1; ADR-0008 T1; BL-121) against the Engram adapter over the fake
// Engram HTTP server: one fresh server on an ephemeral loopback port per case, never 7437. The fault controls of
// MP-17 and MP-18 act on the fake's routes.

const test = { describe, it };

// The routes each operation reaches; an unavailable operation answers 503 on them.
const ROUTES: Readonly<Record<MemoryOperation, readonly FakeRoute[]>> = {
  open: ["sessions.open"],
  store: ["observations.add", "observations.save-result"],
  search: ["search"],
  get: ["observations.get"],
  recall: ["context"],
  summarize: ["sessions.end", "sessions.get"],
  consolidate: [],
  forget: ["observations.delete"],
  export: ["export"],
  import: ["import"],
};

// The write each operation sends and the lookup that resolves it; an ambiguous write loses both answers.
const AMBIGUOUS: Readonly<
  Record<MemoryWriteOperation, readonly [FakeRoute, readonly FakeRoute[]] | undefined>
> = {
  store: ["observations.add", ["observations.save-result"]],
  summarize: ["sessions.end", ["sessions.get"]],
  forget: ["observations.delete", ["observations.get"]],
  consolidate: undefined,
};

function faultsOf(server: FakeEngramServer): MemoryFaultControls {
  return {
    makeUnavailable(operation) {
      const routes = operation === undefined ? (["all"] as const) : ROUTES[operation];
      for (const route of routes) server.setFault(route, "5xx");
    },
    restore() {
      server.clearFaults();
    },
    ambiguousNext(operation) {
      const plan = AMBIGUOUS[operation];
      if (plan === undefined) return;
      server.setFault(plan[0], "ambiguous", { times: 1, thenFail: plan[1] });
    },
  };
}

let dataRoot = "";
let subjects = 0;

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "haril-engram-contract-"));
});

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describeMemoryProviderContract(
  test,
  "EngramMemoryProvider over the fake Engram server",
  async () => {
    subjects += 1;
    const deps = fakeMemoryDeps(`mem${subjects}`);
    const server = new FakeEngramServer({ now: () => deps.clock.now() });
    await server.start();
    const provider = new EngramMemoryProvider(deps, {
      engramVersion: "3.4.0",
      // Every subject shares the data root, so MP-15 can import into a second subject what the first exported.
      harilDataDir: dataRoot,
      connect: async () => ({
        ok: true,
        value: {
          baseUrl: server.url,
          token: server.token,
          instanceId: server.instanceId,
          dataDir: null,
        },
      }),
    });
    return { provider, deps, faults: faultsOf(server), teardown: () => server.close() };
  },
  { retainsWrites: true },
);
