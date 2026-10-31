// What Engram 3.4.0 can do as the adapter declares it, and the limits it relies on (06 sec3.6, sec3.11 [V];
// memory.md 4.2). A version the table does not know declares nothing optional (MP-01).
import type { MemoryCapabilities, Visibility } from "@haril/contracts";

export const PROVIDER = "engram";
// 50 000 bytes of content, 20 search results, a /context of 64 KiB at most, a 15-minute dedupe without topic_key, a
// topic_key of 120 bytes; export format 0.2.0, and 0.1.0 still imports.
export const MAX_CONTENT_BYTES = 50_000;
export const MAX_SEARCH_RESULTS = 20;
export const MAX_RECALL_BYTES = 65_536;
const DEDUPE_WINDOW_MS = 900_000;
export const TOPIC_KEY_MAX_BYTES = 120;
const EXPORT_VERSION = "0.2.0";
const IMPORT_VERSIONS = ["0.2.0", "0.1.0"];
// The versions whose behaviour the capabilities below describe.
const KNOWN_VERSIONS = new Set(["3.4.0"]);

export function capabilitiesOf(
  version: string,
  visibilities: readonly Visibility[],
): MemoryCapabilities {
  const known = KNOWN_VERSIONS.has(version);
  return {
    schemaVersion: 1,
    provider: PROVIDER,
    providerVersion: known || version === "3.6.0" ? version : null,
    persistent: true,
    sessionTracking: true,
    supportsOperationId: known || version === "3.6.0",
    topicKeyUpsert: known || version === "3.6.0",
    // That the history exists over HTTP is NOT VERIFIED (memory.md 4.2), so it is not declared.
    versionHistory: false,
    // mem_consolidate exists only on main, not in 3.4.0 (memory.md 4.2).
    planConfirmConsolidation: false,
    conflictJudgment: false,
    hardDelete: known,
    ttl: false,
    semanticSearch: false,
    searchSyntax: "fts5-trigram",
    maxContentBytes: MAX_CONTENT_BYTES,
    maxSearchResults: MAX_SEARCH_RESULTS,
    maxRecallBytes: MAX_RECALL_BYTES,
    dedupeWindowMs: DEDUPE_WINDOW_MS,
    exportVersion: known ? EXPORT_VERSION : null,
    importVersions: known ? [...IMPORT_VERSIONS] : [],
    pagination: false,
    visibilities: ["project", ...visibilities.filter((visibility) => visibility !== "project")],
  };
}

// A copy, so a caller cannot change the provider's capabilities.
export function copyCapabilities(capabilities: MemoryCapabilities): MemoryCapabilities {
  return {
    ...capabilities,
    importVersions: [...capabilities.importVersions],
    visibilities: [...capabilities.visibilities],
  };
}
