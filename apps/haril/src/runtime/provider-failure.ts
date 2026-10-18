import type { AgentOutcome, ProviderFailure } from "@haril/core/ports";
import type { UpstreamFailure } from "@haril/gateway";

// The Broker's view of a failed upstream call, as the runtime reads it (docs/modos-y-delegacion.md 3.11, phase F6): an
// HTTP 402 is the provider's quota, a 429 its rate limit, a 5xx, a timeout, an unreachable gateway or a broken stream a
// transient failure, and any other refusal (a 4xx, rejected credentials) is fatal and never retried.
export function providerFailureOf(failure: UpstreamFailure): ProviderFailure {
  const kind: ProviderFailure["kind"] =
    failure.code === "quota" || failure.httpStatus === 402
      ? "quota"
      : failure.code === "rate_limited" || failure.httpStatus === 429
        ? "rate_limited"
        : failure.code === "unreachable" ||
            failure.code === "upstream_stream_error" ||
            failure.code === "unknown" ||
            (failure.code === "upstream" &&
              (failure.httpStatus === null || failure.httpStatus >= 500))
          ? "transient"
          : "fatal";
  return {
    kind,
    httpStatus: failure.httpStatus,
    retryAfterMs: failure.retryAfterMs,
    model: failure.model,
  };
}

// A failed attempt carries the run's last upstream failure; any other outcome stays as it is.
export function outcomeWithProvider(
  outcome: AgentOutcome,
  failure: UpstreamFailure | undefined,
): AgentOutcome {
  if (outcome.status !== "failed" || failure === undefined) return outcome;
  return { ...outcome, provider: providerFailureOf(failure) };
}
