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
} from "@haril/core/ports";

// EnvSecretStore (ADR-0020 SEC-2; ARCH 9.7; BL-075 os/secrets): the MVP SecretStore. Real keys come from the Runtime's
// environment, which the composition root passes in: this class never reads process.env itself. env:<NAME> names a
// variable; surrounding whitespace is not part of a key and a blank value is nothing stored. put and delete change only
// this store's view, in process: nothing is written to the environment, the disk or another store, so a key lives no
// longer than the process. It never enumerates and hands a value out only sealed. Honesty (N0): another process of the
// same user can read the Runtime's environment (15 sec9.5.3), which is why an agent only ever gets a virtual key.
export class EnvSecretStore implements SecretStore {
  readonly #env: Readonly<Record<string, string | undefined>>;
  // What put and delete changed, by variable name: a sealed value, or null once deleted.
  readonly #changes = new Map<string, SecretMaterial | null>();

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.#env = env;
  }

  get(ref: SecretRef): SecretResult<SecretMaterial> {
    const parsed = parseSecretRef(ref);
    if (!parsed.ok) return invalid(parsed.message);
    const material = this.#lookup(parsed.name);
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
    const replaced = this.#lookup(parsed.name) !== undefined;
    this.#changes.set(parsed.name, checked.material);
    return { ok: true, value: { ref: parsed.ref, replaced } };
  }

  delete(ref: SecretRef): SecretResult<SecretDeleteReceipt> {
    const parsed = parseSecretRef(ref);
    if (!parsed.ok) return invalid(parsed.message);
    const existed = this.#lookup(parsed.name) !== undefined;
    this.#changes.set(parsed.name, null);
    return { ok: true, value: { ref: parsed.ref, existed } };
  }

  #lookup(name: string): SecretMaterial | undefined {
    if (this.#changes.has(name)) return this.#changes.get(name) ?? undefined;
    const value = this.#env[name]?.trim();
    return value === undefined || value === "" ? undefined : sealSecret(value);
  }
}

function invalid(message: string): { readonly ok: false; readonly error: SecretFailure } {
  return { ok: false, error: { code: "contract.invalid", retryable: false, message } };
}
