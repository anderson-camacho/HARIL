import { createPathGuard, readGuardedFileSync } from "@haril/agent-pi";
import type { FileRead, FileReader, Verification } from "@haril/core";
import type { Store } from "@haril/core/ports";

// Host side of the acceptance checks (criterion 8, M3-D7). The Core evaluates checks through this reader; every
// path goes through the same link-aware PathGuard as the bridge, and the file is read only after its identity
// matches the path, so a check cannot read outside the project root or through a link.

export function projectFileReader(store: Store, projectId: string): FileReader {
  return (requested) => {
    const project = store.projects.list().find((candidate) => candidate.projectId === projectId);
    if (project === undefined) return { ok: false, reason: "no_project" };
    const guarded = createPathGuard(project.rootPath)(requested);
    if (!guarded.ok) return { ok: false, reason: guarded.reason };
    return readRegularFile(guarded.absolutePath);
  };
}

function readRegularFile(absolutePath: string): FileRead {
  const read = readGuardedFileSync(absolutePath);
  if (read.ok) return { ok: true, content: read.content.toString("utf8") };
  return { ok: false, reason: read.reason };
}

// Event payloads name the checks and their outcome, never a path's content or an expected text.
export function verificationPayload(verification: Verification): {
  readonly checks: readonly { readonly kind: string; readonly ok: boolean }[];
} {
  return {
    checks: verification.checks.map((check) => ({ kind: check.kind, ok: check.ok })),
  };
}
