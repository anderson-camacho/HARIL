import { envSecretRef, sealSecret } from "@haril/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { EnvSecretStore } from "../src/index.js";

// What EnvSecretStore adds to the SecretStore contract (ADR-0020 SEC-2; BL-075): the environment it reads is the one
// it is given, put and delete stay in this store, and the store never shows a value. The contract suite itself runs
// against it in env-secret-store-contract.test.ts. Every value here is a fake fixture.

const FAKE_SECRET = "fake-secret-fixture";
const FAKE_OTHER = "fake-secret-other";
const NAME = "HARIL_TEST_PROVIDER_KEY";
const REF = envSecretRef(NAME);
const PROBE = "HARIL_TEST_ENV_STORE_PROBE";

afterEach(() => {
  delete process.env[PROBE];
});

describe("EnvSecretStore", () => {
  it("reads a key by reference from the environment it is given, sealed", () => {
    const got = new EnvSecretStore({ [NAME]: FAKE_SECRET }).get(REF);
    expect(got.ok && got.value.reveal()).toBe(FAKE_SECRET);
    expect(JSON.stringify(got)).not.toContain(FAKE_SECRET);
  });

  it("drops surrounding whitespace and treats a blank value as nothing stored", () => {
    const store = new EnvSecretStore({ [NAME]: `  ${FAKE_SECRET}\n`, HARIL_TEST_BLANK: "  " });
    const got = store.get(REF);
    expect(got.ok && got.value.reveal()).toBe(FAKE_SECRET);
    expect(store.get(envSecretRef("HARIL_TEST_BLANK"))).toMatchObject({
      ok: false,
      error: { code: "secret.not_found" },
    });
  });

  it("never reads the process environment itself", () => {
    process.env[PROBE] = FAKE_SECRET;
    expect(new EnvSecretStore({}).get(envSecretRef(PROBE))).toMatchObject({
      ok: false,
      error: { code: "secret.not_found" },
    });
  });

  it("keeps put and delete in this store: the environment is unchanged and another store still reads it", () => {
    const env = { [NAME]: FAKE_SECRET };
    const store = new EnvSecretStore(env);

    expect(store.put(REF, sealSecret(FAKE_OTHER))).toEqual({
      ok: true,
      value: { ref: REF, replaced: true },
    });
    const replaced = store.get(REF);
    expect(replaced.ok && replaced.value.reveal()).toBe(FAKE_OTHER);
    expect(store.delete(REF)).toEqual({ ok: true, value: { ref: REF, existed: true } });
    expect(store.get(REF).ok).toBe(false);

    expect(env).toEqual({ [NAME]: FAKE_SECRET });
    const other = new EnvSecretStore(env).get(REF);
    expect(other.ok && other.value.reveal()).toBe(FAKE_SECRET);
  });

  it("shows no value and no environment when printed or serialized", () => {
    const store = new EnvSecretStore({ [NAME]: FAKE_SECRET });
    store.put(envSecretRef("HARIL_TEST_PUT"), sealSecret(FAKE_OTHER));
    for (const shown of [JSON.stringify(store), String(store), Object.keys(store).join(",")]) {
      expect(shown).not.toContain(FAKE_SECRET);
      expect(shown).not.toContain(FAKE_OTHER);
      expect(shown).not.toContain(NAME);
    }
  });
});
