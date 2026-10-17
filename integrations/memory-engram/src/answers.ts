// From an Engram answer to a typed failure (memory.md 4.4; MEMORY.md 4.2, a [S] table whose codes and JSON shapes are
// NOT VERIFIED until MC-T6 pins them against a real serve). Only Unavailable is retryable; an unknown result is
// Unavailable that must not be resent blindly (R-O6), so the outbox puts its row in needs_review.
import type { Answer, Exchange, Lost } from "./http.js";
import {
  contractInvalid,
  memoryFailure,
  type Outcome,
  unavailable,
  unknownResult,
} from "./support.js";
import { errorCodeOf } from "./wire.js";

const SCOPE_CODES = new Set([
  "ambiguous_project",
  "session_project_conflict",
  "observation_project_mismatch",
]);

export function cancelled(): Outcome<never> {
  return unavailable("the memory call was cancelled", { cancelled: true });
}

export function isSuccess(answer: Exchange): boolean {
  return answer.kind === "answer" && answer.status >= 200 && answer.status < 300;
}

// An answer that may hide an applied write: a server error, a throttle, or a redirect the adapter never follows.
export function isAmbiguous(answer: Answer): boolean {
  return (
    answer.status >= 500 || answer.status === 429 || (answer.status >= 300 && answer.status < 400)
  );
}

export function lostFailure(lost: Lost): Outcome<never> {
  if (lost.cause === "cancelled") return cancelled();
  return unavailable(
    lost.message,
    lost.cause === "timeout" ? { timeout: true } : { network: true },
  );
}

// 404 NotFound; 409 SessionEnded or ScopeMismatch by its code, otherwise a conflicting request (for a write with an
// operation_id: the id reused with other content, CM-12); 410 an unknown result; 401 and 403 a token the serve does
// not take; 429 and 5xx Unavailable; any other 4xx a request the adapter should not have sent.
export function failureOf(answer: Answer): Outcome<never> {
  const code = errorCodeOf(answer.body, answer.text);
  const status = answer.status;
  if (status === 404) return memoryFailure("NotFound", "engram serve does not know it", { status });
  if (status === 409) {
    if (code === "session_already_ended") {
      return memoryFailure("SessionEnded", "the session has ended");
    }
    if (code !== undefined && SCOPE_CODES.has(code)) {
      return memoryFailure(
        "ScopeMismatch",
        "the session or the record belongs to another project",
        {
          engramCode: code,
        },
      );
    }
    return contractInvalid("engram serve refused a conflicting request (409)", {
      engramCode: code,
    });
  }
  if (status === 410) {
    return unknownResult("engram serve no longer knows the operation (410)", { status });
  }
  if (status === 401 || status === 403) {
    return unavailable("engram serve refused the token", { status, unauthorized: true });
  }
  if (status === 429 || status >= 500) {
    return unavailable(`engram serve answered ${status}`, { status });
  }
  if (status >= 400) {
    return contractInvalid(`engram serve refused the request (${status})`, { status });
  }
  return unknownResult(`engram serve answered ${status}`, { status });
}

// The failure of a read whose answer was lost, refused, or a 200 the adapter cannot read.
export function readFailure(answer: Exchange): Outcome<never> {
  if (answer.kind === "lost") return lostFailure(answer);
  if (answer.status === 200) {
    return unavailable("engram serve answered something the adapter cannot read");
  }
  return failureOf(answer);
}
