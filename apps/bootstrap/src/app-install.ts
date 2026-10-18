import type { PlatformPath } from "node:path";
import { parseManifest } from "./manifest.js";
import { pathOps } from "./platform.js";
import type { FsPort } from "./ports.js";
import type { RuntimeCheck } from "./runtime-lease.js";
import { sha256Hex } from "./shasums.js";
import { SHIM_NAMES, shimContents } from "./shims.js";
import { messageOf } from "./text.js";

// `install` and `uninstall` of HARIL itself (M3-T3). The payload is copied from local build output into
// <root>/app/<version>/, the launchers go to <root>/bin/, and app/current.json records every path created so
// that `uninstall` removes only those. Nothing here edits PATH, the registry, data/, runtime/ or vendor/.

const encoder = new TextEncoder();

export interface AppInstallDeps {
  readonly root: string;
  // Repository directory holding the build output (apps/haril/dist, apps/bootstrap/dist, ...).
  readonly sourceRoot: string;
  readonly platform: string;
  readonly fs: FsPort;
  readonly now: () => string;
}

type AppStepName = "build" | "node" | "payload" | "shims" | "current";

interface AppStep {
  readonly name: AppStepName;
  readonly status: "ok" | "skipped" | "failed";
  readonly detail: string;
}

export interface AppInstallResult {
  readonly ok: boolean;
  readonly root: string;
  readonly version: string | null;
  readonly appDir: string | null;
  readonly binDir: string;
  readonly nodeSource: "manifest" | "path" | null;
  readonly steps: readonly AppStep[];
}

interface CurrentRecord {
  readonly version: string;
  readonly installedAt: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

export interface AppUninstallDeps {
  readonly root: string;
  readonly platform: string;
  readonly fs: FsPort;
  // Criterion 15: consulted before anything is removed. Absent in tests that do not cover the guard.
  readonly activeRuntime?: () => Promise<RuntimeCheck>;
}

export interface AppUninstallResult {
  readonly ok: boolean;
  readonly root: string;
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  readonly detail: string;
  // Set when uninstall refused before removing anything: a runtime is active, or its state is unknown.
  readonly refusal?: "runtime_active" | "runtime_unknown";
}

// Build output the payload needs. `npm run build` produces all of it (apps/haril, bridge, console, bootstrap and shell).
const BUILD_OUTPUTS: readonly (readonly string[])[] = [
  ["apps", "haril", "dist", "haril.mjs"],
  ["apps", "haril", "dist", "blocks", "methodologies"],
  ["integrations", "agent-pi-bridge", "dist", "bridge.mjs"],
  ["integrations", "pi-console", "dist", "console.mjs"],
  ["apps", "bootstrap", "dist", "haril-bootstrap.mjs"],
  ["apps", "shell", "dist", "shell.mjs"],
];

interface PayloadFile {
  readonly path: string; // root-relative, forward slashes
  readonly dest: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  // The sh launcher: POSIX shells only run it with the execute bit set.
  readonly executable?: boolean;
}

interface NodeChoice {
  readonly nodeExe: string | null;
  readonly source: "manifest" | "path";
}

export async function installApp(deps: AppInstallDeps): Promise<AppInstallResult> {
  const ops = pathOps(deps.platform);
  const binDir = ops.join(deps.root, "bin");
  const failure = (steps: AppStep[]): AppInstallResult => ({
    ok: false,
    root: deps.root,
    version: null,
    appDir: null,
    binDir,
    nodeSource: null,
    steps,
  });

  const missing = await missingBuildOutputs(deps, ops);
  if (missing.length > 0) {
    return failure([
      {
        name: "build",
        status: "failed",
        detail: `missing ${missing.join(", ")}: run npm run build first`,
      },
    ]);
  }

  let version: string;
  let node: NodeChoice;
  try {
    version = await readVersion(deps, ops);
  } catch (error) {
    return failure([{ name: "build", status: "failed", detail: messageOf(error) }]);
  }
  try {
    node = await resolveNode(deps, ops);
  } catch (error) {
    return failure([{ name: "node", status: "failed", detail: messageOf(error) }]);
  }

  const appDir = ops.join(deps.root, "app", version);
  const steps: AppStep[] = [];
  const base = { root: deps.root, version, appDir, binDir, nodeSource: node.source } as const;

  let payload: PayloadFile[];
  try {
    payload = await readPayload(deps, ops, version, appDir);
  } catch (error) {
    return {
      ...base,
      ok: false,
      steps: [{ name: "build", status: "failed", detail: messageOf(error) }],
    };
  }

  const shims = shimContents({ appDir, nodeExe: node.nodeExe, pathOps: ops });
  const shimFiles: PayloadFile[] = SHIM_NAMES.map((name) => {
    const bytes = encoder.encode(shims[name]);
    return {
      path: `bin/${name}`,
      dest: ops.join(binDir, name),
      bytes,
      sha256: sha256Hex(bytes),
      executable: name === "haril",
    };
  });

  const run = async (
    name: AppStepName,
    detail: string,
    action: () => Promise<AppStep["status"]>,
  ) => {
    try {
      steps.push({ name, status: await action(), detail });
      return true;
    } catch (error) {
      steps.push({ name, status: "failed", detail: messageOf(error) });
      return false;
    }
  };

  const payloadOk = await run("payload", `${payload.length} files in ${appDir}`, () =>
    writeIfChanged(deps.fs, payload),
  );
  if (payloadOk) {
    const shimsOk = await run("shims", `${binDir} (${SHIM_NAMES.join(", ")})`, () =>
      writeIfChanged(deps.fs, shimFiles),
    );
    if (shimsOk) {
      await run("current", ops.join(deps.root, "app", "current.json"), () =>
        writeCurrent(deps, ops, version, [...payload, ...shimFiles]),
      );
    }
  }

  return {
    ...base,
    ok: steps.every((step) => step.status !== "failed"),
    steps,
  };
}

export async function uninstallApp(deps: AppUninstallDeps): Promise<AppUninstallResult> {
  const ops = pathOps(deps.platform);
  const currentPath = ops.join(deps.root, "app", "current.json");

  const runtime = deps.activeRuntime === undefined ? undefined : await deps.activeRuntime();
  if (runtime?.state === "active") {
    return {
      ok: false,
      root: deps.root,
      removed: [],
      kept: await keptEntries(deps.fs, ops, deps.root),
      detail: `a HARIL runtime is active (pid ${runtime.pid}): stop haril start, then run uninstall again; nothing was removed`,
      refusal: "runtime_active",
    };
  }
  if (runtime?.state === "unknown") {
    return {
      ok: false,
      root: deps.root,
      removed: [],
      kept: await keptEntries(deps.fs, ops, deps.root),
      detail: `could not read haril.db to check for an active runtime (${runtime.reason}); nothing was removed`,
      refusal: "runtime_unknown",
    };
  }

  if (!(await deps.fs.exists(currentPath))) {
    return {
      ok: true,
      root: deps.root,
      removed: [],
      kept: await keptEntries(deps.fs, ops, deps.root),
      detail: "nothing to uninstall: app/current.json is absent",
    };
  }

  let record: CurrentRecord;
  try {
    record = parseCurrent(await deps.fs.readText(currentPath));
  } catch (error) {
    return {
      ok: false,
      root: deps.root,
      removed: [],
      kept: await keptEntries(deps.fs, ops, deps.root),
      detail: `app/current.json is unreadable (${messageOf(error)}); nothing was removed`,
    };
  }

  const outside = [...record.files.map((file) => file.path), "app/current.json"].find(
    (path) => !isOwnedPath(path),
  );
  if (outside !== undefined) {
    return {
      ok: false,
      root: deps.root,
      removed: [],
      kept: await keptEntries(deps.fs, ops, deps.root),
      detail: `app/current.json names ${outside}, outside app/ and bin/; nothing was removed`,
    };
  }

  const removed: string[] = [];
  for (const file of record.files) {
    const dest = ops.join(deps.root, ...file.path.split("/"));
    if (await deps.fs.exists(dest)) {
      await deps.fs.remove(dest);
      removed.push(file.path);
    }
  }
  await deps.fs.remove(currentPath);
  removed.push("app/current.json");
  await pruneEmptyDirs(deps.fs, ops, deps.root, removed);

  return {
    ok: true,
    root: deps.root,
    removed,
    kept: await keptEntries(deps.fs, ops, deps.root),
    detail: `removed ${removed.length} entries`,
  };
}

async function missingBuildOutputs(deps: AppInstallDeps, ops: PlatformPath): Promise<string[]> {
  const missing: string[] = [];
  for (const segments of BUILD_OUTPUTS) {
    if (!(await deps.fs.exists(ops.join(deps.sourceRoot, ...segments)))) {
      missing.push(segments.join("/"));
    }
  }
  return missing;
}

async function readVersion(deps: AppInstallDeps, ops: PlatformPath): Promise<string> {
  const manifest: unknown = JSON.parse(
    await deps.fs.readText(ops.join(deps.sourceRoot, "apps", "haril", "package.json")),
  );
  const version = isRecord(manifest) ? manifest.version : undefined;
  if (typeof version !== "string" || version === "") {
    throw new Error("apps/haril/package.json has no version");
  }
  return version;
}

// The isolated Node of the runtime when runtime/manifest.json exists; otherwise the shims use PATH.
async function resolveNode(deps: AppInstallDeps, ops: PlatformPath): Promise<NodeChoice> {
  const manifestPath = ops.join(deps.root, "runtime", "manifest.json");
  if (!(await deps.fs.exists(manifestPath))) return { nodeExe: null, source: "path" };
  const manifest = parseManifest(await deps.fs.readText(manifestPath));
  if (!(await deps.fs.exists(manifest.node.path))) {
    throw new Error(`runtime/manifest.json names a missing Node executable: ${manifest.node.path}`);
  }
  return { nodeExe: manifest.node.path, source: "manifest" };
}

// Reads every payload file and hashes it before anything is written: the payload is all or nothing.
async function readPayload(
  deps: AppInstallDeps,
  ops: PlatformPath,
  version: string,
  appDir: string,
): Promise<PayloadFile[]> {
  const sources: { segments: string[]; source: string }[] = [];
  const dist = ops.join(deps.sourceRoot, "apps", "haril", "dist");
  for (const segments of await walk(deps.fs, ops, dist, [])) {
    sources.push({ segments, source: ops.join(dist, ...segments) });
  }
  sources.push({
    segments: ["integrations", "agent-pi-bridge", "dist", "bridge.mjs"],
    source: ops.join(deps.sourceRoot, "integrations", "agent-pi-bridge", "dist", "bridge.mjs"),
  });
  // The console extension keeps its repository path under app/<version>, like the bridge, so `haril console` finds it
  // the same way from haril.mjs (PS-T5).
  sources.push({
    segments: ["integrations", "pi-console", "dist", "console.mjs"],
    source: ops.join(deps.sourceRoot, "integrations", "pi-console", "dist", "console.mjs"),
  });
  sources.push({
    segments: ["haril-bootstrap.mjs"],
    source: ops.join(deps.sourceRoot, "apps", "bootstrap", "dist", "haril-bootstrap.mjs"),
  });
  // The shell bundle sits beside haril.mjs, where `haril shell` looks for it (TUI-T2).
  sources.push({
    segments: ["shell.mjs"],
    source: ops.join(deps.sourceRoot, "apps", "shell", "dist", "shell.mjs"),
  });

  const files: PayloadFile[] = [];
  for (const { segments, source } of sources) {
    const bytes = await deps.fs.readBytes(source);
    files.push({
      path: `app/${version}/${segments.join("/")}`,
      dest: ops.join(appDir, ...segments),
      bytes,
      sha256: sha256Hex(bytes),
    });
  }
  return files;
}

async function walk(
  fs: FsPort,
  ops: PlatformPath,
  dir: string,
  prefix: string[],
): Promise<string[][]> {
  const found: string[][] = [];
  for (const entry of await fs.readDir(dir)) {
    const segments = [...prefix, entry.name];
    if (entry.directory) {
      found.push(...(await walk(fs, ops, ops.join(dir, entry.name), segments)));
    } else {
      found.push(segments);
    }
  }
  return found;
}

// Writes only the files whose bytes differ, so a repeated install reports "skipped" and changes nothing.
async function writeIfChanged(
  fs: FsPort,
  files: readonly PayloadFile[],
): Promise<"ok" | "skipped"> {
  let written = 0;
  for (const file of files) {
    const unchanged =
      (await fs.exists(file.dest)) && sha256Hex(await fs.readBytes(file.dest)) === file.sha256;
    if (!unchanged) {
      await fs.writeFile(file.dest, file.bytes);
      written++;
    }
    // Also for unchanged bytes: an earlier install may have left the launcher without the execute bit.
    if (file.executable === true) await fs.setExecutable(file.dest);
  }
  return written === 0 ? "skipped" : "ok";
}

async function writeCurrent(
  deps: AppInstallDeps,
  ops: PlatformPath,
  version: string,
  files: readonly PayloadFile[],
): Promise<"ok" | "skipped"> {
  const currentPath = ops.join(deps.root, "app", "current.json");
  const recorded = files.map((file) => ({ path: file.path, sha256: file.sha256 }));
  if (await deps.fs.exists(currentPath)) {
    const existing = await readCurrentOrNull(deps.fs, currentPath);
    if (existing !== null && existing.version === version && sameFiles(existing.files, recorded)) {
      return "skipped";
    }
  }
  const record: CurrentRecord = { version, installedAt: deps.now(), files: recorded };
  const temporary = `${currentPath}.tmp`;
  await deps.fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
  await deps.fs.rename(temporary, currentPath);
  return "ok";
}

async function readCurrentOrNull(fs: FsPort, path: string): Promise<CurrentRecord | null> {
  try {
    return parseCurrent(await fs.readText(path));
  } catch {
    return null;
  }
}

function sameFiles(
  a: CurrentRecord["files"],
  b: readonly { path: string; sha256: string }[],
): boolean {
  return (
    a.length === b.length &&
    a.every((file, index) => file.path === b[index]?.path && file.sha256 === b[index]?.sha256)
  );
}

function parseCurrent(text: string): CurrentRecord {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    typeof value.installedAt !== "string" ||
    !Array.isArray(value.files)
  ) {
    throw new Error("current.json has an unexpected shape");
  }
  const files = value.files.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.sha256 !== "string") {
      throw new Error("current.json has a malformed file entry");
    }
    return { path: entry.path, sha256: entry.sha256 };
  });
  return { version: value.version, installedAt: value.installedAt, files };
}

// Only app/ and bin/ are ever removed, and never a path with an empty, "." or ".." segment.
function isOwnedPath(path: string): boolean {
  if (path.includes("\\")) return false;
  if (!(path.startsWith("app/") || path.startsWith("bin/"))) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

// Removes the directories left empty by the removal, deepest first, and app/ and bin/ when they are empty.
async function pruneEmptyDirs(
  fs: FsPort,
  ops: PlatformPath,
  root: string,
  removed: readonly string[],
): Promise<void> {
  const dirs = new Set(["app", "bin"]);
  for (const path of removed) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      dirs.add(segments.slice(0, depth).join("/"));
    }
  }
  const deepestFirst = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const relative of deepestFirst) {
    const dir = ops.join(root, ...relative.split("/"));
    if (!(await fs.exists(dir))) continue;
    if ((await fs.readDir(dir)).length === 0) await fs.remove(dir);
  }
}

// What is still under the root after the uninstall: everything except what HARIL owns, shown so the user
// sees what was kept. app/ and bin/ are expanded because they can hold entries HARIL did not create.
async function keptEntries(fs: FsPort, ops: PlatformPath, root: string): Promise<string[]> {
  if (!(await fs.exists(root))) return [];
  const kept: string[] = [];
  for (const entry of await fs.readDir(root)) {
    if (entry.name !== "app" && entry.name !== "bin") {
      kept.push(entry.name);
      continue;
    }
    const dir = ops.join(root, entry.name);
    if (!(await fs.exists(dir))) continue;
    for (const child of await fs.readDir(dir)) kept.push(`${entry.name}/${child.name}`);
  }
  return kept;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
