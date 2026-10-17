// Typed results, input checks and UTF-8 helpers of the adapter. They mirror packages/core/src/memory/support.ts, which
// an integration cannot import: check-layers lets it type-import @haril/core only (ADR-0015 matrix).
import {
  type MemoryErrorCode,
  type MemorySchemaName,
  type MemorySchemaValue,
  validateMemoryValue,
} from "@haril/contracts";
import type { MemoryFailure, Result } from "@haril/core/ports";

export type Outcome<T> = Result<T, MemoryFailure>;

type Details = Readonly<Record<string, unknown>>;

export function ok<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

// Only Unavailable is retryable, except an unknown result: Unavailable that must not be resent blindly (R-O6).
export function memoryFailure(
  code: MemoryErrorCode,
  message: string,
  details?: Details,
): Outcome<never> {
  const error: MemoryFailure = {
    code,
    category: "memory",
    retryable: code === "Unavailable",
    message,
    ...(details === undefined ? {} : { details }),
  };
  return { ok: false, error };
}

export function unavailable(message: string, details?: Details): Outcome<never> {
  return memoryFailure("Unavailable", message, details);
}

// A write that may or may not have been applied and that the adapter cannot resolve: the outbox puts its row in
// needs_review instead of retrying it (memory.md 4.4; core/memory outboxTransitionOf).
export function unknownResult(message: string, details?: Details): Outcome<never> {
  const error: MemoryFailure = {
    code: "Unavailable",
    category: "memory",
    retryable: false,
    message,
    details: { ...details, unknownResult: true },
  };
  return { ok: false, error };
}

export function contractInvalid(message: string, details?: Details): Outcome<never> {
  const error: MemoryFailure = {
    code: "contract.invalid",
    category: "contract",
    retryable: false,
    message,
    ...(details === undefined ? {} : { details }),
  };
  return { ok: false, error };
}

// An input checked against its memory schema; contract.invalid names the first paths that do not validate.
export function checked<N extends MemorySchemaName>(
  name: N,
  value: unknown,
): Outcome<MemorySchemaValue<N>> {
  const validation = validateMemoryValue(name, value);
  if (validation.ok) return ok(validation.value);
  return contractInvalid(`the memory.${name} does not validate`, {
    errors: validation.errors.slice(0, 5),
  });
}

function charBytes(code: number): number {
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) bytes += charBytes(char.codePointAt(0) ?? 0);
  return bytes;
}

// The longest start of `text` within `maxBytes` UTF-8 bytes, cut between code points so it stays valid UTF-8.
export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += charBytes(char.codePointAt(0) ?? 0);
    if (bytes > maxBytes) break;
    end += char.length;
  }
  return text.slice(0, end);
}

// The lowercase terms of a search text, split on whitespace.
export function queryTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
}
