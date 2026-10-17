import { envSecretRef, type SecretMaterial, type SecretRef, sealSecret } from "@haril/contracts";
import { describe, expect, it } from "vitest";
import type { SecretFailure, SecretStore } from "../src/ports/index.js";
import {
  ContractViolation,
  describeSecretStoreContract,
  FakeSecretStore,
  runSecretStoreContractCase,
  type SecretStoreFactory,
} from "../testing/index.js";

// The SecretStore contract suite (TEST_STRATEGY 5 row 10; ADR-0020 SEC-1, SEC-2; BL-024, BL-089) against the Core's
// fake, the fake's own seeding, and the seeded deviations that prove the suite can fail (V18-5).

const test = { describe, it };
const FAKE_SECRET = "fake-secret-fixture";
const REF = envSecretRef("HARIL_TEST_SECRET");

describeSecretStoreContract(test, "FakeSecretStore", () => new FakeSecretStore());

describe("FakeSecretStore", () => {
  it("starts with the secrets it is seeded with, sealed", () => {
    const store = new FakeSecretStore({ [REF]: FAKE_SECRET });
    const got = store.get(REF);
    expect(got.ok && got.value.reveal()).toBe(FAKE_SECRET);
    expect(JSON.stringify(got)).not.toContain(FAKE_SECRET);
  });
});

// A store that keeps every put in one place shared by all its instances: what writing the value to disk looks like
// to the suite (TEST_STRATEGY 5 row 10).
const disk = new Map<string, SecretMaterial>();
class PersistingStore extends FakeSecretStore {
  constructor() {
    super();
    for (const [ref, material] of disk) super.put(ref as SecretRef, material);
  }
  override put(ref: SecretRef, material: SecretMaterial) {
    const receipt = super.put(ref, material);
    if (receipt.ok) disk.set(ref, material);
    return receipt;
  }
}

// A store whose refusals quote the value they refused.
class EchoingStore extends FakeSecretStore {
  override put(ref: SecretRef, material: SecretMaterial) {
    const receipt = super.put(ref, material);
    if (receipt.ok) return receipt;
    const error: SecretFailure = { ...receipt.error, message: `refused ${String(material)}` };
    return { ok: false as const, error };
  }
}

// A store that hands out the plain value instead of a sealed one.
class PlainStore extends FakeSecretStore {
  override get(ref: SecretRef) {
    const got = super.get(ref);
    if (!got.ok) return got;
    return { ok: true as const, value: got.value.reveal() as unknown as SecretMaterial };
  }
}

// A store that throws on a malformed reference instead of answering contract.invalid.
class ThrowingStore extends FakeSecretStore {
  override get(ref: SecretRef) {
    if (!ref.startsWith("env:")) throw new Error("bad reference");
    return super.get(ref);
  }
}

describe("SecretStore contract: seeded deviations (V18-5)", () => {
  it.each([
    [
      "SS-08",
      "writes what it is given where a fresh store reads it",
      PersistingStore,
      "fresh store",
    ],
    ["SS-07", "quotes the value it refused", EchoingStore, "shows the value"],
    ["SS-02", "returns the plain value", PlainStore, "sealed"],
    ["SS-06", "throws on a malformed reference", ThrowingStore, "threw"],
  ] as const)("%s fails for a store that %s", async (id, _what, Store, fragment) => {
    disk.clear();
    const make: SecretStoreFactory = () => new Store() as SecretStore;
    const run = runSecretStoreContractCase(id, make);
    await expect(run).rejects.toBeInstanceOf(ContractViolation);
    await expect(run).rejects.toThrow(fragment);
  });

  it.each(["SS-02", "SS-06", "SS-07", "SS-08"])("%s passes for the honest store", async (id) => {
    await expect(runSecretStoreContractCase(id, () => new FakeSecretStore())).resolves.toBe(
      undefined,
    );
  });

  it("refuses an unknown case id", async () => {
    await expect(runSecretStoreContractCase("SS-99", () => new FakeSecretStore())).rejects.toThrow(
      "unknown secret store contract case SS-99",
    );
  });

  it("seals with the contracts helper, so a value given to put is never a plain string", () => {
    const store = new FakeSecretStore();
    expect(store.put(REF, sealSecret(FAKE_SECRET)).ok).toBe(true);
    expect(store.put(REF, FAKE_SECRET as unknown as SecretMaterial)).toMatchObject({
      ok: false,
      error: { code: "contract.invalid" },
    });
  });
});
