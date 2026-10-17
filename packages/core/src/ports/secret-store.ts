// SecretStore port (ARCH 5.1, 9.7; ADR-0020 SEC-1, SEC-2; TEST_STRATEGY 5 row 10). Real keys by reference: get, put
// and delete, never an enumeration. A value only ever travels sealed (SecretMaterial: printed, interpolated or
// serialized it reads "[redacted]") and only reveal() gives it, inside the adapter that sets the header
// (model-provider.md 2.4). No operation hands a secret to an agent, the bridge or the shell tool; R5 limits who may
// import the port: the composition roots, never the process adapter, agent-pi, the Store or the Executor. The MVP
// adapter is EnvSecretStore in integrations/os; DPAPI or a keyring come with M4 (U-03(b), U-12).
import type { SecretMaterial, SecretRef } from "@haril/contracts";
import type { Result } from "./result.js";

// The reference and the sealed value are shared with the integrations, which may only value-import @haril/contracts.
export type { SecretMaterial, SecretRef } from "@haril/contracts";

// A failure of a secret operation. secret.not_found: nothing is stored under a well-formed reference;
// contract.invalid: the reference or the value does not validate. Neither is retryable, and the message never holds a
// secret value nor the text of a malformed reference (it could be a value given by mistake).
export interface SecretFailure {
  readonly code: "secret.not_found" | "contract.invalid";
  readonly retryable: false;
  readonly message: string;
}

export type SecretResult<T> = Result<T, SecretFailure>;

export interface SecretPutReceipt {
  readonly ref: SecretRef;
  // Whether a secret was already stored under the reference.
  readonly replaced: boolean;
}

export interface SecretDeleteReceipt {
  readonly ref: SecretRef;
  // Whether a secret was stored under the reference; deleting what is not there is not an error.
  readonly existed: boolean;
}

// Synchronous: the MVP adapter reads an in-process map, and the composition root resolves the references the user
// declared when it starts (ARCH 9.7). An asynchronous source, such as a DPAPI helper (M4), pre-resolves those
// references at startup and serves them through this same port. Every expected failure is a typed result, never a
// throw.
export interface SecretStore {
  get(ref: SecretRef): SecretResult<SecretMaterial>;
  // Keeps a sealed, non-empty value under the reference for the life of the store.
  put(ref: SecretRef, material: SecretMaterial): SecretResult<SecretPutReceipt>;
  delete(ref: SecretRef): SecretResult<SecretDeleteReceipt>;
}
