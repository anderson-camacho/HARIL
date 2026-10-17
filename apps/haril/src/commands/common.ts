import { createHash } from "node:crypto";
import { nudgeRuntime } from "@haril/control";
import { canonicalJson, visibleText } from "@haril/core";
import type { ProjectRecord, Store } from "@haril/core/ports";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { resolveDataDir } from "../data-dir.js";
import { storeAccess } from "../host.js";

const NO_PROJECT = "no project yet; run haril project init <path> --name <name> --yes first";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Canonical hash of a request: the same command with the same arguments has the same hash (INV-08).
// Canonical JSON makes key order irrelevant, so a re-ordered plan file is the same request.
export function requestHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

// Text an agent or the store holds, as the terminal shows it, with its line breaks kept (LD-T7c): each line passes the
// Core visibleText rule, as in the shell, so a result or a plan cannot clear the screen, set the clipboard or hide
// words from the person who reads it. Single-line text goes through visibleText itself; JSON output never does.
export function visibleBlock(text: string): string {
  return text.split(/\r?\n/).map(visibleText).join("\n");
}

export function dataDirFor(host: HostInfo, flag: string | undefined): string {
  return resolveDataDir({
    flag,
    env: host.env ?? {},
    platform: host.platform,
    homeDir: host.homeDir ?? "",
  }).dataDir;
}

// Opens an existing store. Undefined when the database does not exist: read paths never create it.
export function openExisting(host: HostInfo, dataDir: string): Store | undefined {
  const access = storeAccess(host);
  if (!access.inspect(dataDir).initialized) return undefined;
  return access.open(dataDir);
}

type ProjectPick =
  | { readonly ok: true; readonly project: ProjectRecord }
  | { readonly ok: false; readonly message: string };

// --project names a slug. Without it, the only registered project is used (M1-D5).
function pickProject(store: Store, slug: string | undefined): ProjectPick {
  if (slug !== undefined) {
    const project = store.projects.getBySlug(slug);
    if (project === undefined) return { ok: false, message: `no project with slug "${slug}"` };
    return { ok: true, project };
  }
  const projects = store.projects.list();
  if (projects.length === 0) return { ok: false, message: NO_PROJECT };
  if (projects.length === 1 && projects[0] !== undefined) {
    return { ok: true, project: projects[0] };
  }
  const slugs = projects.map((project) => project.slug).join(", ");
  return {
    ok: false,
    message: `several projects exist; choose one with --project <slug> (${slugs})`,
  };
}

// Runs `work` with the store and the picked project; reports problems and returns the exit code.
export function withProject(
  io: CliIo,
  host: HostInfo,
  dataDir: string,
  slug: string | undefined,
  work: (store: Store, project: ProjectRecord) => number,
): number {
  const store = openExisting(host, dataDir);
  if (store === undefined) {
    io.err(`haril: ${NO_PROJECT}`);
    return EXIT_USAGE;
  }
  try {
    const pick = pickProject(store, slug);
    if (!pick.ok) {
      io.err(`haril: ${pick.message}`);
      return EXIT_USAGE;
    }
    return work(store, pick.project);
  } finally {
    store.close();
  }
}

export interface QueueRequest {
  readonly type: string;
  readonly projectId: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

// Asks the runtime of this data dir, if one listens, to apply what was just queued at once instead of at its next poll
// (LD-T2). Best-effort: with no runtime listening nothing happens, and the command waits for the next `haril start`.
// The nudge is not awaited: the process stays up until the connection closes, and nudgeRuntime bounds that wait. The
// design's 3 s acknowledgement (ARCH 4.3) is not implemented; the store row is the source of truth either way.
export function nudgeQueued(dataDir: string): void {
  void nudgeRuntime(dataDir);
}

// Enqueues one command. The scheduler applies it on `haril start` (M1-D5), or at once when a runtime is nudged.
export function queueCommand(
  io: CliIo,
  json: boolean,
  store: Store,
  request: QueueRequest,
  dataDir: string,
): number {
  const hash = requestHash({
    type: request.type,
    projectId: request.projectId,
    args: request.args,
  });
  const result = store.commands.enqueue({
    type: request.type,
    projectId: request.projectId,
    args: request.args,
    idempotencyKey: request.idempotencyKey,
    requestHash: hash,
  });
  nudgeQueued(dataDir);
  if (json) {
    io.out(
      JSON.stringify({
        commandId: result.commandId,
        type: request.type,
        status: "queued",
        duplicate: result.duplicate,
      }),
    );
  } else if (result.duplicate) {
    io.out(`command ${result.commandId}: already queued (same idempotency key)`);
  } else {
    io.out(`command ${result.commandId}: queued (applied by \`haril start\`)`);
  }
  return EXIT_OK;
}
