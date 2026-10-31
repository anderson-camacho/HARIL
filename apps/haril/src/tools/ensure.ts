import { activateCopy, pruneVendor } from "./activate.js";
import type { ExtractInput, ExtractResult } from "./archive.js";
import { tarCommand } from "./archive.js";
import { type DownloadFetch, downloadBytes } from "./download.js";
import {
  engramMcpServer,
  type MemoryContext,
  planMcp,
  planMemory,
  readJsonObject,
  writeJsonAtomic,
} from "./engram-config.js";
import type { EnsureFs } from "./fs.js";
import { errorText } from "./fs.js";
import { acquireLock } from "./lock.js";
import { pathOps, userEngramProblem } from "./paths.js";
import { type EngramAsset, engramAsset, findChecksum, sha256Hex } from "./release.js";
import type { SmokeFn } from "./smoke.js";
import { INSTALL_COOLDOWN_MS } from "./state.js";
import { collectToolsReport, type RefreshMode, type ToolsDeps, type ToolsInput } from "./status.js";
import type { ExecFn } from "./system.js";
import type { ToolsReport } from "./types.js";
import { readInstallVersion } from "./version.js";

// `haril tools ensure engram`: makes sure HARIL's own copy of Engram, <runtime root>/vendor/engram/<pin>/, exists, runs
// and is the version HARIL is qualified for, installing or repairing it when it is not. HARIL never installs a version
// newer than the pin; a newer upstream is only reported. A candidate replaces the installed copy only after it was
// downloaded from GitHub's own hosts, matched its published SHA-256, reported the pin and passed a real health check,
// and it is activated with one rename; any failure before that changes nothing.

const CHECKSUMS_TIMEOUT_MS = 15_000;
const ARCHIVE_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 10_000;
const MAX_MESSAGE = 240;

type ExtractFn = (input: ExtractInput) => Promise<ExtractResult>;

export interface EnsureInput {
  readonly platform: string;
  readonly arch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly runtimeRoot: string;
  readonly configPath: string;
  // HARIL's data dir, which the Pi MCP entry points Engram at.
  readonly dataDir: string;
  // The Engram version HARIL is qualified for.
  readonly pin: string;
  // Try again inside the cooldown that follows a failed install.
  readonly force: boolean;
}

export interface EnsureServices {
  readonly download: DownloadFetch;
  readonly exec: ExecFn;
  readonly extract: ExtractFn;
  readonly smoke: SmokeFn;
  readonly fs: EnsureFs;
  readonly pid: number;
  readonly makeId: () => string;
}

export type EnsureDeps = ToolsDeps & EnsureServices;

type EngramAction = "none" | "installed" | "updated" | "skipped" | "busy" | "failed";

export interface EngramEnsureResult {
  readonly action: EngramAction;
  readonly from?: string;
  readonly to?: string;
  readonly path?: string;
  readonly message?: string;
  // Things that did not stop the action but a person should know, such as a settings file left unchanged.
  readonly notes?: readonly string[];
}

export interface EnsureOutcome {
  readonly engram: EngramEnsureResult;
  // The tools status after the action.
  readonly report: ToolsReport;
}

type Document = Record<string, unknown>;

interface Context {
  readonly input: EnsureInput;
  readonly deps: EnsureDeps;
  readonly vendorRoot: string;
  readonly pinBinary: string;
  readonly lockPath: string;
  readonly tmpRoot: string;
  readonly agentMcpPath: string;
  readonly memory: MemoryContext;
}

function contextOf(input: EnsureInput, deps: EnsureDeps): Context {
  const ops = pathOps(input.platform);
  const vendorRoot = ops.join(input.runtimeRoot, "vendor", "engram");
  const binaryName = input.platform === "win32" ? "engram.exe" : "engram";
  const pinBinary = ops.join(vendorRoot, input.pin, binaryName);
  return {
    input,
    deps,
    vendorRoot,
    pinBinary,
    lockPath: ops.join(input.runtimeRoot, "state", "tools.lock"),
    tmpRoot: ops.join(input.runtimeRoot, "tmp"),
    agentMcpPath: ops.join(input.runtimeRoot, "agent", "mcp.json"),
    memory: { vendorRoot, pin: input.pin, pinBinary, platform: input.platform },
  };
}

// The binary the runtime executes, as the settings say: memory.binary when it is an absolute path, else HARIL's copy.
function runtimeBinaryOf(document: Document | undefined, ctx: Context): string {
  const memory = document?.memory;
  if (typeof memory === "object" && memory !== null && !Array.isArray(memory)) {
    const binary = (memory as Document).binary;
    if (typeof binary === "string" && pathOps(ctx.input.platform).isAbsolute(binary)) return binary;
  }
  return ctx.pinBinary;
}

function inspect(
  ctx: Context,
  mode: RefreshMode,
  document: Document | undefined,
  notes: readonly string[] = [],
): Promise<ToolsReport> {
  const { input } = ctx;
  const toolsInput: ToolsInput = {
    platform: input.platform,
    env: input.env,
    homeDir: input.homeDir,
    harilCopy: ctx.pinBinary,
    runtimeBinary: runtimeBinaryOf(document, ctx),
    pin: input.pin,
    notes,
  };
  return collectToolsReport(toolsInput, ctx.deps, mode);
}

function short(message: string): string {
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}...` : message;
}

function recordFailure(ctx: Context, message: string): void {
  try {
    const state = ctx.deps.readState();
    const failedAt = new Date(ctx.deps.now()).toISOString();
    ctx.deps.writeState({ ...state, engramInstall: { failedAt, message: short(message) } });
  } catch {
    // The record only spares a retry; the failure is reported either way.
  }
}

function clearFailure(ctx: Context): void {
  try {
    const { engramInstall, ...rest } = ctx.deps.readState();
    if (engramInstall !== undefined) ctx.deps.writeState(rest);
  } catch {
    // A stale record only delays a retry that --force skips.
  }
}

// The cooldown that follows a failed install, or undefined when a new attempt is allowed.
function cooldownMessage(ctx: Context): string | undefined {
  if (ctx.input.force) return undefined;
  const failure = ctx.deps.readState().engramInstall;
  if (failure === undefined) return undefined;
  const failedAt = Date.parse(failure.failedAt);
  const age = ctx.deps.now() - failedAt;
  // A failure stamped in the future says nothing about how long ago it was.
  if (age < 0 || age >= INSTALL_COOLDOWN_MS) return undefined;
  const retryAt = new Date(failedAt + INSTALL_COOLDOWN_MS).toISOString();
  return `the last install failed at ${failure.failedAt}: ${failure.message}; not retrying until ${retryAt} (run with --force to retry now)`;
}

// The environment `engram version` runs in: the parent's, without any ENGRAM_* setting of the user's, and with the
// data and home pointed at the candidate's own temporary folder so nothing outside it is read or created.
function versionEnv(ctx: Context, stage: string): Record<string, string> {
  const ops = pathOps(ctx.input.platform);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.input.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith("ENGRAM_")) env[key] = value;
  }
  const home = ops.join(stage, "home");
  return {
    ...env,
    ENGRAM_DATA_DIR: ops.join(stage, "version-data"),
    ENGRAM_NO_UPDATE_CHECK: "1",
    ENGRAM_STARTUP_POLICY: "deny",
    HOME: home,
    USERPROFILE: home,
  };
}

type Install =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string; readonly inUse: boolean };

const failed = (message: string): Install => ({ ok: false, message: short(message), inUse: false });

// Holding the lock, no other install is running, so any folder left here is the leftover of one that died.
function sweepLeftovers(ctx: Context): void {
  const { fs } = ctx.deps;
  const ops = pathOps(ctx.input.platform);
  let names: string[];
  try {
    names = fs.readDir(ctx.tmpRoot);
  } catch {
    return;
  }
  for (const name of names.filter((entry) => entry.startsWith("engram-install-"))) {
    try {
      fs.remove(ops.join(ctx.tmpRoot, name));
    } catch {
      // It stays until the next run.
    }
  }
}

// Downloads, verifies and activates the pin. Everything is built in a temporary folder that is always deleted.
async function installPin(ctx: Context, asset: EngramAsset): Promise<Install> {
  const { input, deps } = ctx;
  const ops = pathOps(input.platform);
  const stage = ops.join(ctx.tmpRoot, `engram-install-${deps.pid}-${deps.makeId()}`);
  try {
    sweepLeftovers(ctx);
    deps.fs.mkdir(stage);

    const checksums = await downloadBytes(asset.checksumsUrl, deps.download, {
      timeoutMs: CHECKSUMS_TIMEOUT_MS,
    });
    if (!checksums.ok) return failed(`could not download checksums.txt: ${checksums.reason}`);
    const archive = await downloadBytes(asset.url, deps.download, {
      timeoutMs: ARCHIVE_TIMEOUT_MS,
    });
    if (!archive.ok) return failed(`could not download ${asset.name}: ${archive.reason}`);

    const expected = findChecksum(Buffer.from(checksums.bytes).toString("utf8"), asset.name);
    if (!expected.ok) return failed(`checksums.txt: ${expected.reason}`);
    if (sha256Hex(archive.bytes) !== expected.sha256) {
      return failed(`checksum mismatch: ${asset.name} does not match its published SHA-256`);
    }

    const archivePath = ops.join(stage, asset.name);
    deps.fs.writeNew(archivePath, archive.bytes, 0o600);
    const extractDir = ops.join(stage, "extracted");
    deps.fs.mkdir(extractDir);
    const extracted = await deps.extract({
      archive: archivePath,
      destDir: extractDir,
      binary: asset.binary,
      tar: tarCommand(input.platform, input.env),
    });
    if (!extracted.ok) return failed(`could not extract ${asset.name}: ${extracted.reason}`);

    const env = versionEnv(ctx, stage);
    const read = await readInstallVersion(extracted.path, "engram", (file, args) =>
      deps.exec(file, args, { timeoutMs: VERSION_TIMEOUT_MS, env }),
    );
    if ("error" in read) return failed(`the downloaded engram does not run: ${read.error}`);
    if (read.version !== input.pin) {
      return failed(`the downloaded engram reports ${read.version}, not ${input.pin}`);
    }

    const smoke = await deps.smoke({
      binary: { path: extracted.path },
      version: input.pin,
      workDir: ops.join(stage, "smoke"),
      homeDir: input.homeDir,
      env: input.env,
      platform: input.platform as NodeJS.Platform,
    });
    if (!smoke.ok)
      return failed(`the health check of the downloaded engram failed: ${smoke.reason}`);

    const activated = activateCopy(
      {
        vendorRoot: ctx.vendorRoot,
        version: input.pin,
        binary: asset.binary,
        source: extracted.path,
        pid: deps.pid,
        now: deps.now(),
      },
      deps.fs,
    );
    if (!activated.ok) return { ok: false, message: activated.message, inUse: activated.inUse };
    return { ok: true, path: activated.path };
  } catch (error) {
    return failed(`the install stopped unexpectedly: ${errorText(error)}`);
  } finally {
    try {
      deps.fs.remove(stage);
    } catch {
      // The temporary folder is swept at the start of the next install.
    }
  }
}

// What haril.json says about Engram, judged once and carried through the run.
interface Settings {
  // The parsed file; undefined when it cannot be trusted (unreadable, or a memory section that is not an object).
  readonly document: Document | undefined;
  // The memory section names an older managed version that an update should bring forward.
  readonly stale: boolean;
  readonly problem: string | undefined;
}

type Judged =
  | { readonly override: string; readonly document: Document }
  | { readonly settings: Settings };

function judgeSettings(ctx: Context): Judged {
  const read = readJsonObject(ctx.input.configPath, ctx.deps.fs);
  if (!read.ok) {
    const problem = `haril.json could not be read (${read.reason})`;
    return { settings: { document: undefined, stale: false, problem } };
  }
  const plan = planMemory(read.value, ctx.memory, false);
  if (plan.kind === "override") return { override: plan.binary, document: read.value };
  if (plan.kind === "invalid") {
    const problem = `haril.json has an invalid memory section (${plan.reason})`;
    return { settings: { document: undefined, stale: false, problem } };
  }
  return { settings: { document: read.value, stale: plan.kind === "update", problem: undefined } };
}

interface Synced {
  readonly document: Document | undefined;
  readonly notes: string[];
  readonly from?: string;
}

function hasEngramEntry(document: Document): boolean {
  const servers = document.mcpServers;
  return typeof servers === "object" && servers !== null && "engram" in servers;
}

// Brings haril.json and the Pi MCP entry in line with the verified copy, leaving anything that is the user's alone.
function syncSettings(ctx: Context, settings: Settings, installed: boolean): Synced {
  const { deps, input } = ctx;
  const notes: string[] = [];
  if (settings.document === undefined) {
    const why = settings.problem ?? "haril.json could not be read";
    notes.push(`${why}; the memory settings and the Pi MCP entry were left unchanged`);
    return { document: undefined, notes };
  }

  let current = settings.document;
  let from: string | undefined;
  const plan = planMemory(current, ctx.memory, installed);
  if (plan.kind === "write" || plan.kind === "update") {
    try {
      writeJsonAtomic(input.configPath, plan.document, deps.fs, deps.makeId());
      current = plan.document;
      if (plan.kind === "update") from = plan.from;
    } catch (error) {
      notes.push(`could not update haril.json: ${errorText(error)}`);
    }
  }
  const synced = (): Synced => ({
    document: current,
    notes,
    ...(from === undefined ? {} : { from }),
  });

  const memory = current.memory;
  const provider =
    typeof memory === "object" && memory !== null ? (memory as Document).provider : undefined;
  const mode = installed && provider === "engram" ? "register" : "refresh";
  const mcp = readJsonObject(ctx.agentMcpPath, deps.fs);
  if (!mcp.ok) {
    notes.push(
      `agent/mcp.json could not be read (${mcp.reason}); the Pi MCP entry was left unchanged`,
    );
    return synced();
  }
  const mcpPlan = planMcp(
    mcp.value,
    engramMcpServer(ctx.pinBinary, input.dataDir, input.platform),
    mode,
  );
  if (mcpPlan.changed) {
    try {
      writeJsonAtomic(ctx.agentMcpPath, mcpPlan.document, deps.fs, deps.makeId());
    } catch (error) {
      notes.push(`could not update agent/mcp.json: ${errorText(error)}`);
    }
  } else if (installed && mode === "refresh" && !hasEngramEntry(mcp.value)) {
    notes.push("memory.provider is not engram, so the Pi MCP tools for Engram were not registered");
  }
  return synced();
}

// The outcome with the status after the action. A copy that was just installed is read back through the same detection
// the rest of HARIL uses, so "installed" is only reported for a copy that really runs as the pin.
async function finish(
  ctx: Context,
  mode: RefreshMode,
  document: Document | undefined,
  engram: EngramEnsureResult,
): Promise<EnsureOutcome> {
  const report = await inspect(ctx, mode, document, engram.notes ?? []);
  if (engram.action === "installed" || engram.action === "updated") {
    const copy = report.tools
      .find((tool) => tool.id === "engram")
      ?.installs.find((install) => install.origins.includes("haril"));
    if (copy?.version !== ctx.input.pin) {
      const seen = copy?.versionError ?? copy?.version ?? "not found";
      const message = `the copy at ${ctx.pinBinary} does not report ${ctx.input.pin} (${seen})`;
      return { engram: { action: "failed", message }, report };
    }
  }
  return { engram, report };
}

async function ensureLocked(
  ctx: Context,
  asset: EngramAsset,
  settings: Settings,
): Promise<EnsureOutcome> {
  const { input, deps } = ctx;
  const carried = settings.problem === undefined ? [] : [settings.problem];
  const withNotes = (notes: readonly string[]) => (notes.length === 0 ? {} : { notes });

  const status = await inspect(ctx, "if-due", settings.document, carried);
  const engram = status.tools.find((tool) => tool.id === "engram");
  const copy = engram?.installs.find((install) => install.origins.includes("haril"));
  const copyOk = copy?.version === input.pin;

  if (copyOk && !settings.stale) {
    const message = `Engram ${input.pin} is installed and current`;
    return {
      engram: { action: "none", path: ctx.pinBinary, message, ...withNotes(carried) },
      report: status,
    };
  }

  if (copyOk) {
    // The copy is fine; only haril.json still names an older managed version.
    const synced = syncSettings(ctx, settings, false);
    return finish(ctx, "never", synced.document, {
      action: "updated",
      ...(synced.from === undefined ? {} : { from: synced.from }),
      to: input.pin,
      path: ctx.pinBinary,
      message: "haril.json now points at the current copy",
      ...withNotes(synced.notes),
    });
  }

  const waiting = cooldownMessage(ctx);
  if (waiting !== undefined) {
    const result: EngramEnsureResult = {
      action: "failed",
      message: waiting,
      ...withNotes(carried),
    };
    return finish(ctx, "never", settings.document, result);
  }

  const previous = engram?.active?.version ?? copy?.version ?? null;
  const installed = await installPin(ctx, asset);
  if (!installed.ok) {
    // A copy in use is a local, passing condition: it must not hold back the retry the message asks for.
    if (!installed.inUse) recordFailure(ctx, installed.message);
    const result: EngramEnsureResult = {
      action: "failed",
      message: installed.message,
      ...withNotes(carried),
    };
    return finish(ctx, "never", settings.document, result);
  }

  clearFailure(ctx);
  const synced = syncSettings(ctx, settings, true);
  pruneVendor(
    {
      vendorRoot: ctx.vendorRoot,
      pin: input.pin,
      keep: [runtimeBinaryOf(synced.document, ctx)],
      platform: input.platform,
    },
    deps.fs,
  );
  return finish(ctx, "never", synced.document, {
    action: previous === null ? "installed" : "updated",
    ...(previous === null ? {} : { from: previous }),
    to: input.pin,
    path: installed.path,
    ...withNotes(synced.notes),
  });
}

export async function ensureEngram(input: EnsureInput, deps: EnsureDeps): Promise<EnsureOutcome> {
  const ctx = contextOf(input, deps);

  const refused = userEngramProblem(
    [input.runtimeRoot, ctx.vendorRoot, input.dataDir, input.configPath, ctx.agentMcpPath],
    input.homeDir,
    deps.fs,
    input.platform,
  );
  if (refused !== undefined) {
    return finish(ctx, "never", undefined, { action: "failed", message: refused });
  }
  const asset = engramAsset(input.pin, input.platform, input.arch);
  if (asset === undefined) {
    const message = `Engram ${input.pin} has no release for ${input.platform}/${input.arch}`;
    return finish(ctx, "never", undefined, { action: "failed", message });
  }

  // The settings decide whether the copy is HARIL's to manage, and one that cannot be read is never overwritten.
  const judged = judgeSettings(ctx);
  if ("override" in judged) {
    return finish(ctx, "if-due", judged.document, {
      action: "skipped",
      path: judged.override,
      message: `memory.binary in haril.json points to ${judged.override}, outside HARIL's copy (${ctx.vendorRoot}); HARIL does not manage it`,
    });
  }
  const { settings } = judged;

  const lock = acquireLock(ctx.lockPath, deps.now, deps.fs);
  if (!lock.ok) {
    const result: EngramEnsureResult = lock.busy
      ? { action: "busy", message: "another haril tools ensure is running; nothing was changed" }
      : { action: "failed", message: lock.message };
    return finish(ctx, "never", settings.document, result);
  }
  try {
    return await ensureLocked(ctx, asset, settings);
  } finally {
    lock.release();
  }
}
