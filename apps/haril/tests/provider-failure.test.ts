import { describe, expect, it } from "vitest";
import { outcomeWithProvider, providerFailureOf } from "../src/runtime/provider-failure.js";

// What the Broker heard from the gateway reaches a real agent's failed outcome (3.11, phase F6), so the runtime can cool
// the model down and retry the turn: a 402 is quota, a 429 rate_limited, a 5xx, a timeout or a broken stream transient,
// and any other refusal fatal.

const base = { runId: "r1", taskId: "t1", providerId: "cliproxy", model: "cliproxy/Acct1/m" };

describe("a provider failure", () => {
  it("is read from the Broker's code and status", () => {
    expect(
      providerFailureOf({ ...base, code: "rate_limited", httpStatus: 429, retryAfterMs: 30_000 }),
    ).toEqual({
      kind: "rate_limited",
      httpStatus: 429,
      retryAfterMs: 30_000,
      model: "cliproxy/Acct1/m",
    });
    expect(
      providerFailureOf({ ...base, code: "quota", httpStatus: 402, retryAfterMs: null }).kind,
    ).toBe("quota");
    for (const transient of [
      { code: "upstream", httpStatus: 503 },
      { code: "unreachable", httpStatus: null },
      { code: "upstream_stream_error", httpStatus: null },
    ]) {
      expect(providerFailureOf({ ...base, ...transient, retryAfterMs: null }).kind).toBe(
        "transient",
      );
    }
    expect(
      providerFailureOf({ ...base, code: "upstream", httpStatus: 400, retryAfterMs: null }).kind,
    ).toBe("fatal");
    expect(
      providerFailureOf({ ...base, code: "auth", httpStatus: 401, retryAfterMs: null }).kind,
    ).toBe("fatal");
  });

  it("is attached to a failed outcome only", () => {
    const failure = { ...base, code: "rate_limited", httpStatus: 429, retryAfterMs: null };
    expect(
      outcomeWithProvider({ status: "failed", code: "provider_error", message: "429" }, failure),
    ).toMatchObject({ status: "failed", provider: { kind: "rate_limited" } });
    expect(outcomeWithProvider({ status: "succeeded", summary: "ok" }, failure)).toEqual({
      status: "succeeded",
      summary: "ok",
    });
    expect(outcomeWithProvider({ status: "failed", code: "x", message: "y" }, undefined)).toEqual({
      status: "failed",
      code: "x",
      message: "y",
    });
  });
});
