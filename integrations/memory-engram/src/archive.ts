// The file side of export and import (memory.md 4.2): an export is a new file under HARIL's data dir, for a project
// in data/projects/<project_id>/exports/ (ARCH 4.4), written to a temporary file and renamed; an import reads only a
// file under the data dir whose hash and version are the artifact's, checked before anything changes. The HTTP side
// (GET /export, POST /import) stays in the provider.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExportArtifact } from "@haril/contracts";
import type { Hasher } from "@haril/core/ports";
import { contractInvalid, memoryFailure, type Outcome, ok } from "./support.js";
import { readExport } from "./wire.js";

const EXPORT_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export interface ExportFile {
  readonly directory: string;
  readonly path: string;
}

// Where an export goes: the projectKey names a directory as it is (a ULID, or _knowledge), never a path; "all" goes
// to data/memory/exports/.
export function exportFileOf(
  harilDataDir: string,
  projectKey: string | undefined,
  id: string,
): Outcome<ExportFile> {
  const segment = projectKey ?? "all";
  if (!EXPORT_SEGMENT.test(segment) || DEVICE_NAMES.test(segment)) {
    return contractInvalid("the projectKey cannot name an export directory");
  }
  const directory =
    projectKey === undefined
      ? join(harilDataDir, "memory", "exports")
      : join(harilDataDir, "projects", segment, "exports");
  return ok({ directory, path: join(directory, `engram-${segment}-${id}.json`) });
}

// A new file only: the temporary one is created exclusively, then renamed into place.
export async function writeExport(file: ExportFile, text: string): Promise<void> {
  await mkdir(file.directory, { recursive: true });
  await writeFile(`${file.path}.tmp`, text, { encoding: "utf8", flag: "wx" });
  await rename(`${file.path}.tmp`, file.path);
}

function isInside(root: string, path: string): boolean {
  const between = relative(resolve(root), resolve(path));
  return between !== "" && !between.startsWith("..") && !isAbsolute(between);
}

// The text of the artifact's file once it is under the data dir, hashes to its sha256 and is the version it declares.
export async function readArtifact(
  harilDataDir: string,
  artifact: ExportArtifact,
  hasher: Hasher,
): Promise<Outcome<string>> {
  if (!isAbsolute(artifact.path) || !isInside(harilDataDir, artifact.path)) {
    return contractInvalid("the artifact is not a file under HARIL's data dir");
  }
  let text: string;
  try {
    text = await readFile(artifact.path, "utf8");
  } catch {
    return contractInvalid("the artifact's file cannot be read");
  }
  if (hasher.sha256(text) !== artifact.sha256) {
    return contractInvalid("the artifact's file does not match its sha256");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return contractInvalid("the artifact's file is not JSON");
  }
  const exported = readExport(parsed);
  if (exported === undefined || exported.version !== artifact.format.version) {
    return memoryFailure("Unsupported", "the artifact's file is not the version it declares");
  }
  return ok(text);
}
