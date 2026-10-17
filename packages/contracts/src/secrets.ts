// Secret references and sealed secret values (ARCH 5.1, 9.7; ADR-0020 SEC-1, SEC-5; model-provider.md 2.4). A
// reference names where a secret lives, never its value: env:<NAME> is an environment variable of the Runtime
// (EnvSecretStore, the MVP adapter). Other schemes (DPAPI, keyring) come with M4. The SecretStore port and its adapters
// share these, since the integrations may only value-import @haril/contracts.

export type SecretRef = `env:${string}`;

// The environment variable names haril.json accepts for keyEnv (config.ts).
const ENV_REF = /^env:([A-Z_][A-Z0-9_]{0,127})$/;

export type SecretRefParse =
  | { readonly ok: true; readonly ref: SecretRef; readonly scheme: "env"; readonly name: string }
  | { readonly ok: false; readonly message: string };

// The message never quotes the text: a malformed reference may be a value given by mistake.
export function parseSecretRef(text: unknown): SecretRefParse {
  const match = typeof text === "string" ? ENV_REF.exec(text) : null;
  if (match === null || match[1] === undefined) {
    return {
      ok: false,
      message:
        "a secret reference is env:<NAME>, with NAME an environment variable name (A-Z, 0-9, _)",
    };
  }
  return { ok: true, ref: match[0] as SecretRef, scheme: "env", name: match[1] };
}

export function envSecretRef(name: string): SecretRef {
  return `env:${name}`;
}

export const REDACTED = "[redacted]";

// The only form a secret value travels in: printed, interpolated, concatenated or serialized it reads "[redacted]",
// and reveal() gives the value. It holds the value in a closure, not in a property, so no inspection shows it.
export interface SecretMaterial {
  reveal(): string;
  toString(): typeof REDACTED;
  toJSON(): typeof REDACTED;
}

export function sealSecret(value: string): SecretMaterial {
  const material: SecretMaterial = {
    reveal: () => value,
    toString: () => REDACTED,
    toJSON: () => REDACTED,
  };
  return Object.freeze(material);
}

export type SealedSecretCheck =
  | { readonly ok: true; readonly material: SecretMaterial }
  | { readonly ok: false; readonly message: string };

// What a store keeps of a value it is given: a fresh sealed copy, read once. The value must arrive sealed (never as a
// plain string) and not be empty; the message never quotes what was given, nor what reading it threw.
export function checkSealedSecret(given: unknown): SealedSecretCheck {
  let value: unknown;
  try {
    const reveal: unknown =
      typeof given === "object" && given !== null && "reveal" in given ? given.reveal : undefined;
    if (typeof reveal !== "function") {
      return {
        ok: false,
        message: "a secret is given sealed (sealSecret), never as a plain value",
      };
    }
    value = reveal.call(given);
  } catch {
    return { ok: false, message: "a secret could not be read from what was given" };
  }
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, message: "a secret must be a non-empty string" };
  }
  return { ok: true, material: sealSecret(value) };
}
