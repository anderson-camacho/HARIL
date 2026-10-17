// From an Engram observation to what the port returns (memory.md 3.4): refs, hits and records, their order, and the
// check that an observation belongs to the scope that asked for it. The check runs on the adapter's side because 06
// does not list scope and type as parameters of /search and /context: a serve that ignored them must still never
// hand a project read a personal or global record, or a record of a kind that was not asked for.
import {
  type MemoryHit,
  type MemoryKind,
  type MemoryRecord,
  type MemoryRef,
  type ScopeRef,
  validateMemoryValue,
} from "@haril/contracts";
import { PROVIDER } from "./capabilities.js";
import { kindOfType, ownerOf, visibilityOf } from "./mapping.js";
import type { WireObservation } from "./wire.js";

const SNIPPET_CHARS = 160;

export function refOf(observation: WireObservation): MemoryRef {
  const ref: MemoryRef = { provider: PROVIDER, providerRef: observation.id };
  return observation.syncId === undefined ? ref : { ...ref, syncId: observation.syncId };
}

// A live observation of the scope's Engram project and visibility, and of one of `kinds` (undefined: any kind).
export function belongsTo(
  observation: WireObservation,
  project: string,
  scope: ScopeRef,
  kinds: readonly MemoryKind[] | undefined,
): boolean {
  if (observation.deleted || observation.project !== project) return false;
  if (visibilityOf(observation.scope) !== scope.visibility) return false;
  const kind = kindOfType(observation.type);
  return kinds === undefined || (kind !== "unknown" && kinds.includes(kind));
}

// Pinned first, then relevance, then recency (MEMORY.md 6.1); the id breaks the remaining ties.
export function byRelevance(a: WireObservation, b: WireObservation): number {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    (b.score ?? 0) - (a.score ?? 0) ||
    b.updatedAt - a.updatedAt ||
    Number(b.id) - Number(a.id)
  );
}

export function hitOf(observation: WireObservation): MemoryHit {
  const hit: MemoryHit = {
    ref: refOf(observation),
    kind: kindOfType(observation.type),
    title: observation.title,
    snippet: Array.from(observation.content).slice(0, SNIPPET_CHARS).join(""),
    score: observation.score ?? null,
    pinned: observation.pinned,
    updatedAt: observation.updatedAt,
  };
  return observation.topicKey === undefined ? hit : { ...hit, topicKey: observation.topicKey };
}

function isSessionId(sessionId: string): boolean {
  return validateMemoryValue("session-ref", { provider: PROVIDER, sessionId }).ok;
}

function scopeOf(observation: WireObservation, asked: ScopeRef): ScopeRef {
  const owner = ownerOf(observation.project) ?? asked;
  return {
    workspaceId: owner.workspaceId,
    projectKey: owner.projectKey,
    visibility: visibilityOf(observation.scope),
    // A session id from elsewhere (an import) may not be one of HARIL's: the asking scope's stands in.
    sessionId: isSessionId(observation.sessionId) ? observation.sessionId : asked.sessionId,
    kind: kindOfType(observation.type),
  };
}

export function recordOf(observation: WireObservation, asked: ScopeRef): MemoryRecord {
  const record: MemoryRecord = {
    ref: refOf(observation),
    scope: scopeOf(observation, asked),
    kind: kindOfType(observation.type),
    title: observation.title,
    content: observation.content,
    pinned: observation.pinned,
    ...(observation.revisionCount !== undefined && observation.revisionCount >= 1
      ? { revisionCount: observation.revisionCount }
      : {}),
    ...(observation.duplicateCount === undefined
      ? {}
      : { duplicateCount: observation.duplicateCount }),
    createdAt: observation.createdAt,
    updatedAt: observation.updatedAt,
    deleted: observation.deleted,
  };
  return observation.topicKey === undefined
    ? record
    : { ...record, topicKey: observation.topicKey };
}
