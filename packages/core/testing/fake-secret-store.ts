import {
  checkSealedSecret,
  parseSecretRef,
  type SecretMaterial,
  type SecretRef,
  sealSecret,
} from "@haril/contracts";
import type {
  SecretDeleteReceipt,
  SecretFailure,
  SecretPutReceipt,
  SecretResult,
  SecretStore,
} from "../src/ports/index.js";

// In-memory SecretStore for tests (BL-024); it passes the same contract suite as EnvSecretStore. It may start with
// seeded values, read like EnvSecretStore reads the environment: surrounding whitespace dropped, a blank value unset.
// Tests seed fake values only (TEST_STRATEGY 1 row 10).
export class FakeSecretStore implements SecretStore {
  readonly #secrets = new Map<SecretRef, SecretMaterial>();

  constructor(seed: Readonly<Record<SecretRef, string>> = {}) {
    for (const [ref, value] of Object.entries(seed)) {
      const trimmed = value.trim();
      if (trimmed !== "") this.#secrets.set(ref as SecretRef, sealSecret(trimmed));
    }
  }

  get(ref: SecretRef): SecretResult<SecretMaterial> {
    const parsed = parseSecretRef(ref);
    if (!parsed.ok) return invalid(parsed.message);
    const material = this.#secrets.get(parsed.ref);
    if (material === undefined) {
      return {
        ok: false,
        error: {
          code: "secret.not_found",
          retryable: false,
          message: `no secret is stored under ${parsed.ref}`,
        },
      };
    }
    return { ok: true, value: material };
  }

  put(ref: SecretRef, material: SecretMaterial): SecretResult<SecretPutReceipt> {
    const parsed = parseSecretRef(ref);
    if (!parsed.ok) return invalid(parsed.message);
    const checked = checkSealedSecret(material);
    if (!checked.ok) return invalid(checked.message);
    const replaced = this.#secrets.has(parsed.ref);
    this.#secrets.set(parsed.ref, checked.material);
    return { ok: true, value: { ref: parsed.ref, replaced } };
  }

  delete(ref: SecretRef): SecretResult<SecretDeleteReceipt> {
    const parsed = parseSecretRef(ref);
    if (!parsed.ok) return invalid(parsed.message);
    return { ok: true, value: { ref: parsed.ref, existed: this.#secrets.delete(parsed.ref) } };
  }
}

function invalid(message: string): { readonly ok: false; readonly error: SecretFailure } {
  return { ok: false, error: { code: "contract.invalid", retryable: false, message } };
}
