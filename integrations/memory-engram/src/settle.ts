// What keeps a write safe to retry (R-O6; memory.md 4.2, 4.4): an answer that may hide an applied write is settled
// before the call returns. A store asks GET /observations/save-result for its operation_id; a summary, which Engram
// ends without an operation_id, is compared with the session's stored summary; a forget reads the record again. What
// cannot be settled now is retryable when the retry is safe (Engram's ledger replays a store, an ended session answers
// a summary, a forgotten record answers a forget) and an unknown result otherwise, which the outbox puts in review.
import type {
  ForgetReceipt,
  ForgetRequest,
  MemoryWrite,
  ScopeRef,
  SummarizeWrite,
  WriteReceipt,
} from "@haril/contracts";
import type { Hasher } from "@haril/core/ports";
import { cancelled, failureOf, isAmbiguous, isSuccess, lostFailure } from "./answers.js";
import { MAX_CONTENT_BYTES, PROVIDER } from "./capabilities.js";
import type { EngramRequest, Exchange } from "./http.js";
import { engramProject } from "./mapping.js";
import {
  memoryFailure,
  type Outcome,
  ok,
  truncateUtf8,
  unavailable,
  unknownResult,
  utf8Length,
} from "./support.js";
import {
  errorCodeOf,
  readSaveResult,
  readSession,
  type WireObservation,
  type WireSaveResult,
} from "./wire.js";

// The requests one call makes to a verified serve.
export interface Channel {
  send(request: EngramRequest): Promise<Exchange>;
  openSession(scope: ScopeRef): Promise<Outcome<void>>;
  // Forgets that the adapter opened this session (it ended, or the serve does not know it).
  dropSession(sessionId: string): void;
  observation(providerRef: string): Promise<Outcome<WireObservation>>;
  readonly hasher: Hasher;
}

// Engram's redaction, (?is)<private>.*?</private> (06 sec3.6), applied before sending so the receipt can say it.
const PRIVATE_TAG = /<private>[\s\S]*?<\/private>/gi;
const REDACTED = "[REDACTED]";

export interface Prepared {
  readonly title: string;
  readonly content: string;
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly originalBytes: number;
}

// Redaction first, then truncation measured after it, as Engram does (06 sec3.6), cut between code points.
export function prepare(write: MemoryWrite): Prepared {
  const title = write.title.replace(PRIVATE_TAG, REDACTED);
  const full = write.content.replace(PRIVATE_TAG, REDACTED);
  const originalBytes = utf8Length(full);
  const truncated = originalBytes > MAX_CONTENT_BYTES;
  return {
    title,
    content: truncated ? truncateUtf8(full, MAX_CONTENT_BYTES) : full,
    redacted: title !== write.title || full !== write.content,
    truncated,
    originalBytes,
  };
}

function storeReceipt(write: MemoryWrite, prepared: Prepared, saved: WireSaveResult): WriteReceipt {
  return {
    schemaVersion: 1,
    operationId: write.operationId,
    provider: PROVIDER,
    providerRef: saved.id,
    ...(saved.syncId === undefined ? {} : { syncId: saved.syncId }),
    outcome: saved.outcome,
    truncated: prepared.truncated,
    redacted: prepared.redacted,
    ...(prepared.truncated
      ? { originalBytes: prepared.originalBytes, limitBytes: MAX_CONTENT_BYTES }
      : {}),
  };
}

function summaryReceipt(write: SummarizeWrite, outcome: WriteReceipt["outcome"]): WriteReceipt {
  return {
    schemaVersion: 1,
    operationId: write.operationId,
    provider: PROVIDER,
    outcome,
    truncated: false,
    redacted: false,
  };
}

// The receipt of POST /observations, or the failure its answer and, when that answer may hide the write, the
// save-result lookup settle on.
export async function settleStore(
  channel: Channel,
  write: MemoryWrite,
  prepared: Prepared,
  sent: Exchange,
): Promise<Outcome<WriteReceipt>> {
  if (sent.kind === "lost" && sent.cause === "cancelled") return cancelled();
  // A 2xx proves the write happened even when its body cannot be read.
  const applied = isSuccess(sent);
  if (sent.kind === "answer") {
    const saved = applied ? readSaveResult(sent.body) : undefined;
    if (saved !== undefined) return ok(storeReceipt(write, prepared, saved));
    if (sent.status === 409 && errorCodeOf(sent.body, sent.text) === "session_already_ended") {
      channel.dropSession(write.scope.sessionId);
    }
    if (sent.status === 404) {
      // The session this adapter opened is unknown to the serve (its data dir changed): open it on the retry.
      channel.dropSession(write.scope.sessionId);
      return unavailable("engram serve does not know the session", { status: 404 });
    }
    // A 409 that names no session or scope code is a reused operationId with other content (CM-12).
    if (sent.status >= 400 && !isAmbiguous(sent)) return failureOf(sent);
  }
  const lookup = await channel.send({
    method: "GET",
    path: "/observations/save-result",
    query: { operation_id: write.operationId },
  });
  if (lookup.kind === "answer") {
    if (lookup.status === 200) {
      const saved = readSaveResult(lookup.body);
      if (saved !== undefined) return ok(storeReceipt(write, prepared, saved));
      return unknownResult("save-result answered something the adapter cannot read");
    }
    if (lookup.status === 404) {
      return applied
        ? unknownResult("the write was answered 2xx, unreadable, and save-result does not know it")
        : unavailable("the write was not applied; its retry is safe", { notApplied: true });
    }
    if (lookup.status === 410) {
      return unknownResult("save-result no longer knows the operation (410)");
    }
  } else if (lookup.cause === "cancelled") {
    return cancelled();
  }
  // Not known yet: a retry with the same operationId goes through Engram's ledger and cannot write twice.
  const why = sent.kind === "lost" ? sent : lookup.kind === "lost" ? lookup : undefined;
  return unavailable("the result of the write is not known yet", {
    ...(why === undefined ? {} : why.cause === "timeout" ? { timeout: true } : { network: true }),
  });
}

// What POST /sessions/{id}/end settled: a receipt, a failure, or "compare" when only the stored summary can tell
// (the session had already ended, or the answer was lost or ambiguous).
export async function endSession(
  channel: Channel,
  write: SummarizeWrite,
  sessionPath: string,
): Promise<Outcome<WriteReceipt> | "compare"> {
  const opened = await channel.openSession(write.scope);
  if (!opened.ok) return opened.error.code === "SessionEnded" ? "compare" : opened;
  const sent = await channel.send({
    method: "POST",
    path: `${sessionPath}/end`,
    body: { summary: write.text },
  });
  if (sent.kind === "lost") return sent.cause === "cancelled" ? cancelled() : "compare";
  if (isSuccess(sent)) return ok(summaryReceipt(write, "created"));
  if (isAmbiguous(sent)) return "compare";
  const failure = failureOf(sent);
  return !failure.ok && failure.error.code === "SessionEnded" ? "compare" : failure;
}

// The ended session's summary decides: the same text is deduped, another one SessionEnded; a session still open
// means the end was not applied.
export async function compareSummary(
  channel: Channel,
  write: SummarizeWrite,
  sessionPath: string,
): Promise<Outcome<WriteReceipt>> {
  const answer = await channel.send({ method: "GET", path: sessionPath });
  const session =
    answer.kind === "answer" && answer.status === 200 ? readSession(answer.body) : undefined;
  if (session === undefined) {
    if (answer.kind === "lost") return lostFailure(answer);
    return answer.status === 200
      ? unknownResult("GET /sessions answered something unreadable")
      : failureOf(answer);
  }
  if (session.project !== engramProject(write.scope)) {
    return memoryFailure("ScopeMismatch", "the session belongs to another project");
  }
  if (!session.ended) {
    return unavailable("the session did not end; its retry is safe", { notApplied: true });
  }
  if (session.summary !== null && channel.hasher.sha256(session.summary) === write.textSha256) {
    return ok(summaryReceipt(write, "deduped"));
  }
  return memoryFailure("SessionEnded", "the session already ended with another summary");
}

// DELETE /observations/{id}?expected_project=X[&hard=true]. After an ambiguous answer the record says whether it
// went: hidden or gone is forgotten, still live means the forget was not applied.
export async function eraseObservation(
  channel: Channel,
  request: ForgetRequest,
  project: string,
  forgotten: ForgetReceipt,
): Promise<Outcome<ForgetReceipt>> {
  const sent = await channel.send({
    method: "DELETE",
    path: `/observations/${encodeURIComponent(request.ref.providerRef)}`,
    query: { expected_project: project, hard: request.mode === "hard" ? "true" : undefined },
  });
  if (isSuccess(sent)) return ok(forgotten);
  if (sent.kind === "lost" && sent.cause === "cancelled") return cancelled();
  if (sent.kind === "answer" && !isAmbiguous(sent)) return failureOf(sent);
  const after = await channel.observation(request.ref.providerRef);
  if (!after.ok) {
    return after.error.code === "NotFound" && request.mode === "hard" ? ok(forgotten) : after;
  }
  if (request.mode === "soft" && after.value.deleted) return ok(forgotten);
  return unavailable("the forget was not applied; its retry is safe", { notApplied: true });
}
