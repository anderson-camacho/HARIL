import {
  envSecretRef,
  REDACTED,
  type SecretMaterial,
  type SecretRef,
  sealSecret,
} from "@haril/contracts";
import type { SecretFailure, SecretResult, SecretStore } from "../src/ports/index.js";
import { type ContractTestApi, ContractViolation } from "./contract-api.js";

// Contract suite of the SecretStore port (TEST_STRATEGY 5 row 10; ADR-0020 SEC-1, SEC-2; BL-024, BL-089). It is written
// once and run against every implementation: FakeSecretStore in packages/core/tests and EnvSecretStore in
// integrations/os. get, put and delete by reference; a value only ever comes back sealed; every expected failure is a
// typed result; no value shows in an answer, a refusal or the store itself; nothing is persisted.

// A fresh store for each case. Two calls must give two stores over the same backing source (for EnvSecretStore, the
// same environment map), so that a store which persists what it is given is caught (SS-08). The source must hold
// nothing under the references the suite uses (HARIL_CONTRACT_SECRET_A and HARIL_CONTRACT_SECRET_B).
export type SecretStoreFactory = () => SecretStore;

const CANARY = "fake-secret-contract-canary";
const OTHER = "fake-secret-contract-other";
const VALUES = [CANARY, OTHER] as const;
const REF_A = envSecretRef("HARIL_CONTRACT_SECRET_A");
const REF_B = envSecretRef("HARIL_CONTRACT_SECRET_B");
// Malformed references, the last one a value given where a reference belongs.
const MALFORMED: readonly unknown[] = [
  "",
  "env:",
  "env:lower_case",
  "ENV:HARIL_CONTRACT_SECRET_A",
  "keyring:HARIL_CONTRACT_SECRET_A",
  "env:HARIL CONTRACT",
  undefined,
  CANARY,
];

interface ContractCase {
  readonly id: string;
  readonly title: string;
  run(make: SecretStoreFactory): void;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ContractViolation(message);
}

// A thrown error is a contract violation; its message is not quoted, since it could hold a value.
function attempt<T>(what: string, call: () => T): T {
  try {
    return call();
  } catch (error) {
    const kind = error instanceof Error ? error.name : typeof error;
    throw new ContractViolation(`${what} threw (${kind}): an expected failure is a typed result`);
  }
}

function expectOk<T>(what: string, result: SecretResult<T>): T {
  if (!result.ok) throw new ContractViolation(`${what}: expected ok, got ${result.error.code}`);
  return result.value;
}

function expectFailure(
  what: string,
  result: SecretResult<unknown>,
  code: SecretFailure["code"],
): SecretFailure {
  if (result.ok) throw new ContractViolation(`${what}: expected ${code}, got ok`);
  check(result.error.code === code, `${what}: expected ${code}, got ${result.error.code}`);
  check(result.error.retryable === false, `${what}: a secret failure is never retryable`);
  check(
    typeof result.error.message === "string" && result.error.message.length > 0,
    `${what}: a failure says what went wrong`,
  );
  return result.error;
}

function checkSealed(what: string, material: unknown, value: string): void {
  check(
    typeof material === "object" &&
      material !== null &&
      typeof (material as { reveal?: unknown }).reveal === "function",
    `${what}: must return a sealed SecretMaterial, never the plain value`,
  );
  const sealed = material as SecretMaterial;
  check(sealed.reveal() === value, `${what}: reveal() must give the stored value`);
  check(
    String(sealed) === REDACTED &&
      `${sealed}` === REDACTED &&
      JSON.stringify(sealed) === JSON.stringify(REDACTED),
    `${what}: a sealed value reads ${REDACTED} when printed, interpolated or serialized`,
  );
}

function shownForms(value: unknown): string[] {
  const forms: string[] = [];
  try {
    forms.push(JSON.stringify(value) ?? "");
  } catch {
    forms.push("");
  }
  try {
    forms.push(String(value));
  } catch {
    forms.push("");
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) forms.push(key);
  }
  return forms;
}

function checkHidden(what: string, value: unknown): void {
  for (const form of shownForms(value)) {
    for (const secret of VALUES) check(!form.includes(secret), `${what} shows the value`);
  }
}

const CASES: readonly ContractCase[] = [
  {
    id: "SS-01",
    title: "with nothing stored, get is secret.not_found and delete is ok with existed false",
    run(make) {
      const store = make();
      expectFailure(
        "get of a reference with nothing stored",
        attempt("get", () => store.get(REF_A)),
        "secret.not_found",
      );
      const removed = expectOk(
        "delete of a reference with nothing stored",
        attempt("delete", () => store.delete(REF_A)),
      );
      check(
        removed.ref === REF_A && removed.existed === false,
        "delete of a reference with nothing stored: expected { ref, existed: false }",
      );
    },
  },
  {
    id: "SS-02",
    title: "put then get gives back the value, sealed, as often as it is read",
    run(make) {
      const store = make();
      const put = expectOk(
        "put",
        attempt("put", () => store.put(REF_A, sealSecret(CANARY))),
      );
      check(
        put.ref === REF_A && put.replaced === false,
        "put of a new reference: expected { ref, replaced: false }",
      );
      for (const read of ["first", "second"]) {
        const got = expectOk(
          `${read} get after put`,
          attempt("get", () => store.get(REF_A)),
        );
        checkSealed(`${read} get after put`, got, CANARY);
      }
    },
  },
  {
    id: "SS-03",
    title: "a second put under the same reference replaces the value",
    run(make) {
      const store = make();
      expectOk(
        "first put",
        attempt("put", () => store.put(REF_A, sealSecret(CANARY))),
      );
      const again = expectOk(
        "second put",
        attempt("put", () => store.put(REF_A, sealSecret(OTHER))),
      );
      check(again.replaced === true, "second put under the same reference: expected replaced true");
      checkSealed(
        "get after the second put",
        expectOk("get after the second put", store.get(REF_A)),
        OTHER,
      );
    },
  },
  {
    id: "SS-04",
    title: "delete removes the secret, and deleting it again is ok with existed false",
    run(make) {
      const store = make();
      expectOk(
        "put",
        attempt("put", () => store.put(REF_A, sealSecret(CANARY))),
      );
      const removed = expectOk(
        "delete",
        attempt("delete", () => store.delete(REF_A)),
      );
      check(removed.ref === REF_A && removed.existed === true, "delete: expected existed true");
      expectFailure(
        "get after delete",
        attempt("get", () => store.get(REF_A)),
        "secret.not_found",
      );
      const again = expectOk(
        "second delete",
        attempt("delete", () => store.delete(REF_A)),
      );
      check(again.existed === false, "second delete: expected existed false");
    },
  },
  {
    id: "SS-05",
    title: "references are independent",
    run(make) {
      const store = make();
      expectOk(
        "put under A",
        attempt("put", () => store.put(REF_A, sealSecret(CANARY))),
      );
      expectFailure(
        "get of B after a put under A",
        attempt("get", () => store.get(REF_B)),
        "secret.not_found",
      );
      expectOk(
        "put under B",
        attempt("put", () => store.put(REF_B, sealSecret(OTHER))),
      );
      expectOk(
        "delete of A",
        attempt("delete", () => store.delete(REF_A)),
      );
      checkSealed(
        "get of B after A was deleted",
        expectOk("get of B after A was deleted", store.get(REF_B)),
        OTHER,
      );
    },
  },
  {
    id: "SS-06",
    title: "a malformed reference is contract.invalid for get, put and delete, never thrown",
    run(make) {
      const store = make();
      for (const [index, text] of MALFORMED.entries()) {
        const ref = text as SecretRef;
        const calls: readonly (readonly [string, () => SecretResult<unknown>])[] = [
          ["get", () => store.get(ref)],
          ["put", () => store.put(ref, sealSecret(OTHER))],
          ["delete", () => store.delete(ref)],
        ];
        for (const [operation, call] of calls) {
          const what = `${operation} of malformed reference #${index + 1}`;
          const error = expectFailure(what, attempt(what, call), "contract.invalid");
          checkHidden(`the refusal of ${what}`, error);
        }
      }
      expectFailure(
        "get after puts under malformed references",
        attempt("get", () => store.get(REF_A)),
        "secret.not_found",
      );
    },
  },
  {
    id: "SS-07",
    title:
      "put refuses a plain or empty value as contract.invalid, without quoting it, and keeps nothing",
    run(make) {
      const store = make();
      const refused: readonly unknown[] = [CANARY, { reveal: CANARY }, sealSecret(""), null];
      for (const [index, given] of refused.entries()) {
        const what = `put of refused value #${index + 1}`;
        const error = expectFailure(
          what,
          attempt(what, () => store.put(REF_A, given as SecretMaterial)),
          "contract.invalid",
        );
        checkHidden(`the refusal of ${what}`, error);
      }
      expectFailure(
        "get after refused puts",
        attempt("get", () => store.get(REF_A)),
        "secret.not_found",
      );
    },
  },
  {
    id: "SS-08",
    title:
      "nothing is persisted: a fresh store from the factory does not see what another store put",
    run(make) {
      const first = make();
      expectOk(
        "put",
        attempt("put", () => first.put(REF_A, sealSecret(CANARY))),
      );
      const got = attempt("get from a fresh store", () => make().get(REF_A));
      check(
        !got.ok,
        "a fresh store from the factory sees a secret another store put: the value was persisted",
      );
    },
  },
  {
    id: "SS-09",
    title: "no value shows in an answer, a refusal or the store itself",
    run(make) {
      const store = make();
      const answers: unknown[] = [
        store.put(REF_A, sealSecret(CANARY)),
        store.get(REF_A),
        store.put(REF_A, sealSecret(OTHER)),
        store.get(REF_A),
        store.get(REF_B),
        store.put("env:" as SecretRef, sealSecret(CANARY)),
        store.put(REF_B, CANARY as unknown as SecretMaterial),
        store.delete(REF_A),
        store,
      ];
      for (const [index, answer] of answers.entries()) checkHidden(`answer #${index + 1}`, answer);
    },
  },
];

// Registers one test per case, each on fresh stores from `make`.
export function describeSecretStoreContract(
  test: ContractTestApi,
  name: string,
  make: SecretStoreFactory,
): void {
  test.describe(`SecretStore contract: ${name}`, () => {
    for (const contractCase of CASES) {
      test.it(`${contractCase.id}: ${contractCase.title}`, async () => contractCase.run(make));
    }
  });
}

// Runs one case by id; it rejects with a ContractViolation when the store breaks the contract. A seeded deviation
// proves a case can fail (V18-5).
export async function runSecretStoreContractCase(
  id: string,
  make: SecretStoreFactory,
): Promise<void> {
  const contractCase = CASES.find((candidate) => candidate.id === id);
  if (contractCase === undefined) throw new Error(`unknown secret store contract case ${id}`);
  contractCase.run(make);
}
