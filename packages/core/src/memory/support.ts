// What the Core's memory providers share: typed failures, input checks against the memory schemas, cancellation and
// UTF-8 byte counting. Pure.
import {
  type ConsolidationRequest,
  type ExportArtifact,
  type ExportFormat,
  type MemoryCapabilities,
  type MemoryErrorCode,
  type MemoryHealth,
  type MemoryQuery,
  type MemoryRef,
  type MemorySchemaName,
  type MemorySchemaValue,
  type ScopeRef,
  type SummarizeWrite,
  validateMemoryValue,
} from "@haril/contracts";
import type {
  EpochMs,
  Hasher,
  MemoryCallOptions,
  MemoryFailure,
  Result,
  TokenEstimator,
} from "../ports/index.js";

export type MemoryOutcome<T> = Result<T, MemoryFailure>;

// The Core's providers report the version of the memory contract they implement, so their optional capabilities are
// not forced false (MP-01).
export const CORE_PROVIDER_VERSION = "1";

type Details = Readonly<Record<string, unknown>>;

export function ok<T>(value: T): MemoryOutcome<T> {
  return { ok: true, value };
}

export function memoryFailure(
  code: MemoryErrorCode,
  message: string,
  details?: Details,
): MemoryOutcome<never> {
  const error: MemoryFailure = {
    code,
    category: "memory",
    retryable: code === "Unavailable",
    message,
    ...(details === undefined ? {} : { details }),
  };
  return { ok: false, error };
}

export function contractInvalid(message: string, details?: Details): MemoryOutcome<never> {
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
): MemoryOutcome<MemorySchemaValue<N>> {
  const validation = validateMemoryValue(name, value);
  if (validation.ok) return ok(validation.value);
  return contractInvalid(`the memory.${name} does not validate`, {
    errors: validation.errors.slice(0, 5),
  });
}

// The failure of a call whose signal is cancelled. For a write it is ambiguous, so it is Unavailable and the outbox
// retries it with the same operationId (memory.md 4.1).
function cancelledCall(options: MemoryCallOptions | undefined): MemoryOutcome<never> | undefined {
  if (options?.signal?.cancelled !== true) return undefined;
  return memoryFailure("Unavailable", "the memory call was cancelled", { cancelled: true });
}

// personal and global need an opt-in the provider declares in capabilities().visibilities (MP-22).
function unsupportedVisibility(
  capabilities: MemoryCapabilities,
  scope: ScopeRef,
): MemoryOutcome<never> | undefined {
  if (capabilities.visibilities.includes(scope.visibility)) return undefined;
  return memoryFailure("Unsupported", `the visibility ${scope.visibility} is not supported`);
}

// Why a scoped call is refused before it is looked at: a visibility without opt-in, or a cancelled signal.
export function refusal(
  capabilities: MemoryCapabilities,
  scope: ScopeRef,
  options: MemoryCallOptions | undefined,
): MemoryOutcome<never> | undefined {
  return unsupportedVisibility(capabilities, scope) ?? cancelledCall(options);
}

// The health of a provider in the Runtime's process: always active, its own memory always readable.
export function inProcessHealth(provider: string, now: EpochMs): MemoryHealth {
  return {
    schemaVersion: 1,
    provider,
    state: "active",
    checkedAt: now,
    realReadOk: true,
    version: CORE_PROVIDER_VERSION,
    instanceId: null,
    dataDir: null,
    lastError: null,
  };
}

// consolidate, export and import of a provider without the capability: the input is checked, then Unsupported.
export function unsupportedConsolidation(
  capabilities: MemoryCapabilities,
  request: ConsolidationRequest,
  options: MemoryCallOptions | undefined,
  message: string,
): MemoryOutcome<never> {
  const input = checked("consolidation-request", request);
  if (!input.ok) return input;
  return refusal(capabilities, input.value.scope, options) ?? memoryFailure("Unsupported", message);
}

export function unsupportedExport(
  capabilities: MemoryCapabilities,
  scope: ScopeRef | "all",
  format: ExportFormat,
  options: MemoryCallOptions | undefined,
  message: string,
): MemoryOutcome<never> {
  if (scope !== "all") {
    const input = checked("scope-ref", scope);
    if (!input.ok) return input;
    const refused = refusal(capabilities, input.value, options);
    if (refused !== undefined) return refused;
  }
  const formatInput = checked("export-format", format);
  if (!formatInput.ok) return formatInput;
  return memoryFailure("Unsupported", message);
}

export function unsupportedImport(artifact: ExportArtifact, message: string): MemoryOutcome<never> {
  const input = checked("export-artifact", artifact);
  if (!input.ok) return input;
  return memoryFailure("Unsupported", message);
}

// A copy, so a caller cannot change the provider's capabilities.
export function copyCapabilities(capabilities: MemoryCapabilities): MemoryCapabilities {
  return {
    ...capabilities,
    importVersions: [...capabilities.importVersions],
    visibilities: [...capabilities.visibilities],
  };
}

// contract.invalid for a ref of another provider (memory.md 4.2: ref.provider is this provider).
export function foreignRef(ref: MemoryRef, provider: string): MemoryOutcome<never> | undefined {
  if (ref.provider === provider) return undefined;
  return contractInvalid(`the ref belongs to the provider ${ref.provider}, not ${provider}`);
}

// contract.invalid for a summary whose session is not the session of its scope or not this provider's.
export function foreignSession(
  write: SummarizeWrite,
  provider: string,
): MemoryOutcome<never> | undefined {
  if (write.session.provider === provider && write.session.sessionId === write.scope.sessionId) {
    return undefined;
  }
  return contractInvalid("the summary's session is not the session of its scope in this provider");
}

// The lowercase terms of a search text, split on whitespace.
export function queryTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
}

// contract.invalid for a search without terms or with a limit over maxSearchResults (memory.md 4.2).
export function searchBounds(
  capabilities: MemoryCapabilities,
  query: MemoryQuery,
): MemoryOutcome<never> | undefined {
  if (queryTerms(query.text).length === 0) return contractInvalid("the search text has no terms");
  if (query.limit <= capabilities.maxSearchResults) return undefined;
  return contractInvalid(`the search limit is over ${capabilities.maxSearchResults}`);
}

// contract.invalid when the hash a write carries is not the hash of its text (memory.md 4.2 preconditions).
export function mismatchedHash(
  hasher: Hasher,
  text: string,
  sha256: string,
): MemoryOutcome<never> | undefined {
  if (hasher.sha256(text) === sha256) return undefined;
  return contractInvalid("the SHA-256 does not match the text it was sent with");
}

// UTF-8 bytes per code point; a lone surrogate counts as the three bytes of U+FFFD.
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

// The fallback TokenEstimator (memory.md 4.3, CM-03): the UTF-8 bytes of the text. A token never takes less than a
// byte, so it bounds the real tokens from above until a measured bytes-per-token ratio replaces it (MH-06).
export const estimateTokens: TokenEstimator = (text) => utf8Length(text);
