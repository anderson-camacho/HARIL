// Typed failures of the OpenAI-compatible adapter. Messages never contain the credential (the adapter
// redacts anything the upstream echoes back before it reaches a message).

export type ProviderErrorCode =
  | "auth"
  | "quota"
  | "rate_limited"
  | "upstream"
  | "unreachable"
  | "upstream_stream_error";

export interface ProviderErrorOptions {
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
  }
}
