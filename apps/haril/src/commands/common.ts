import { createHash } from "node:crypto";
import { canonicalJson } from "@haril/core";
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
function requestHash(value: unknown): string {
  return sha256(canonicalJson(value));
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

// Enqueues one command. The scheduler applies it on `haril start` (M1-D5).
export function queueCommand(
  io: CliIo,
  json: boolean,
  store: Store,
  request: QueueRequest,
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
