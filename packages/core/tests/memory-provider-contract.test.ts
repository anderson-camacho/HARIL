import { describe, it } from "vitest";
import { InMemoryMemoryProvider, NullMemoryProvider } from "../src/memory/index.js";
import {
  describeMemoryProviderContract,
  FakeMemoryProvider,
  fakeMemoryDeps,
} from "../testing/index.js";

// The MemoryProvider contract suite (memory.md 8.1; ADR-0008 T1; BL-047) against every provider of the Core: Null (the
// subset for a provider that discards), InMemory with and without a dedupe window, and the fault fake, which brings
// the controls of the Unavailable cases.

const test = { describe, it };

describeMemoryProviderContract(
  test,
  "NullMemoryProvider",
  () => {
    const deps = fakeMemoryDeps();
    return { provider: new NullMemoryProvider(deps), deps };
  },
  { retainsWrites: false },
);

describeMemoryProviderContract(
  test,
  "InMemoryMemoryProvider",
  () => {
    const deps = fakeMemoryDeps();
    return { provider: new InMemoryMemoryProvider(deps), deps };
  },
  { retainsWrites: true },
);

describeMemoryProviderContract(
  test,
  "InMemoryMemoryProvider with a 15-minute dedupe window",
  () => {
    const deps = fakeMemoryDeps();
    return { provider: new InMemoryMemoryProvider(deps, { dedupeWindowMs: 900_000 }), deps };
  },
  { retainsWrites: true },
);

describeMemoryProviderContract(
  test,
  "FakeMemoryProvider",
  () => {
    const deps = fakeMemoryDeps();
    const provider = new FakeMemoryProvider(deps);
    return { provider, deps, faults: provider };
  },
  { retainsWrites: true },
);
