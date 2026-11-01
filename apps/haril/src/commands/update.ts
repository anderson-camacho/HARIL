import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { defaultPidAlive } from "../host.js";
import { runtimeRootFor } from "../runtime.js";
import { compareVersions, versionParts } from "../version-compare.js";
import { dataDirFor } from "./common.js";
import { toolVersionsFor } from "./tools.js";
import {
  type ComponentRow,
  installLogLines,
  logFileText,
  NOT_MANAGED,
  plainRowLine,
  summaryLines,
} from "./update-log.js";

// Without --from, HARIL fetches its own main branch into an isolated temporary directory.
// This is a development channel, NOT a signed release; confirmation is still required.
const MAIN_REPOSITORY = "https://github.com/anderson-camacho/HARIL.git";
const USAGE = "usage: haril update [--check] [--from <repository> | --main] [--yes]";

interface MainCheckout {
  readonly source: string;
  readonly revision: string;
  cleanup(): void;
}

export interface UpdateServices {
  readonly readText: (path: string) => string;
  readonly exists: (path: string) => boolean;
  readonly verifyBinary: (path: string, requiredVersion: string) => Promise<boolean>;
  readonly activeRuntime: (dataDir: string) => {
    state: "none" | "active" | "unknown";
    detail?: string;
  };
  readonly install: (script: string, root: string, source: string) => Promise<number>;
  readonly confirm: () => Promise<boolean>;
  readonly checkoutMain: () => Promise<MainCheckout>;
  // What may be restored if the install fails midway, and how; the old version's folder stays on disk. A restore that could
  // not put everything back throws, saying what.
  readonly snapshot?: (root: string) => InstallSnapshot;
  readonly restore?: (root: string, snapshot: InstallSnapshot) => void;
  // The versions of the tools HARIL manages apart from itself, read locally; null when absent.
  readonly toolVersions?: () => Promise<Readonly<Record<"engram" | "gentle-ai", string | null>>>;
  // Where the log goes; default a file under the install root.
  readonly writeLog?: (root: string, text: string) => string | null;
}

type InstallSnapshot = readonly { readonly path: string; readonly bytes: Buffer }[];

const REDRAW_MS = 125;

function takeSnapshot(root: string): InstallSnapshot {
  const out: { path: string; bytes: Buffer }[] = [];
  const bin = join(root, "bin");
  const files = [
    join(root, "app", "current.json"),
    ...(existsSync(bin) ? readdirSync(bin).map((name) => join(bin, name)) : []),
  ];
  for (const path of files) {
    if (existsSync(path) && statSync(path).isFile()) out.push({ path, bytes: readFileSync(path) });
  }
  return out;
}

// Puts back what the snapshot holds, reads it back, and removes what the install added to bin/. Everything it can, then
// throws with what it could not.
function restoreSnapshot(root: string, snapshot: InstallSnapshot): void {
  const problems: string[] = [];
  const attempt = (path: string, work: () => void): void => {
    try {
      work();
    } catch (error) {
      problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const bin = join(root, "bin");
  const kept = new Set(snapshot.map((file) => file.path));
  attempt(bin, () => {
    if (!existsSync(bin) || !statSync(bin).isDirectory()) return;
    for (const name of readdirSync(bin)) {
      const path = join(bin, name);
      if (kept.has(path) || !statSync(path).isFile()) continue;
      attempt(path, () => rmSync(path));
    }
  });
  for (const { path, bytes } of snapshot) {
    attempt(path, () => {
      writeFileSync(path, bytes);
      if (!readFileSync(path).equals(bytes)) throw new Error("it reads back different");
    });
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
}

function writeLogFile(root: string, text: string): string | null {
  try {
    const dir = join(root, "logs");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `update-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    writeFileSync(path, text);
    return path;
  } catch {
    return null;
  }
}

// The components an update shows, in the order of the log. What HARIL does not manage says so instead of a ✓.
function initialRows(available: string): ComponentRow[] {
  const outside = (name: string, todo: string): ComponentRow => ({
    name,
    state: "pending",
    version: null,
    status: "",
    todo,
  });
  return [
    { name: "HARIL", state: "pending", version: available, status: "" },
    { name: "Engram", state: "pending", version: null, status: "" },
    outside("Skills", "Actualízalas con la herramienta que las instaló."),
    outside("MCP", "Actualízalos con la herramienta que los instaló."),
    { name: "Gentle AI", state: "pending", version: null, status: "" },
    outside("Plantillas", "HARIL aún no trae plantillas."),
  ];
}

function managedTool(
  name: string,
  version: string | null,
  repair: string,
  missing: string,
): ComponentRow {
  return version === null
    ? {
        name,
        state: "warning",
        version: null,
        status: "no instalado",
        happened: "No se encontró instalado.",
        result: "HARIL sigue funcionando sin él.",
        todo: `${missing}: ${repair}`,
      }
    : {
        name,
        state: "ok",
        version,
        status: "versión verificada",
        happened: "Se leyó su versión instalada.",
        result: `En ${version}.`,
      };
}

// Runs the update's components. One that fails does not stop the others, and HARIL returns to the version it was on when
// its own install fails midway.
async function runComponents(
  input: {
    readonly available: string;
    readonly current: string;
    readonly root: string;
    readonly script: string;
    readonly source: string;
    readonly repairOnly: boolean;
    // The tools a repair is there for: it counts only once they pass their verification.
    readonly repairs: readonly {
      readonly name: string;
      readonly path: string;
      readonly version: string;
    }[];
  },
  io: CliIo,
  host: HostInfo,
  services: UpdateServices,
): Promise<number> {
  const { available, current, root, script, source } = input;
  const tty = host.interactive === true;
  const color = tty && host.env?.NO_COLOR === undefined && host.env?.TERM !== "dumb";
  let rows = initialRows(available);
  let tick = 0;
  let drawn = 0;
  const draw = (): void => {
    if (!tty) return;
    const lines = installLogLines(rows, {
      path: root,
      color,
      columns: process.stdout.columns ?? 80,
      tick,
    });
    io.out(`${drawn === 0 ? "" : `\u001b[${drawn}A\u001b[J`}${lines.join("\n")}`);
    drawn = lines.length;
  };
  const set = (name: string, row: Partial<ComponentRow>): void => {
    rows = rows.map((item) => (item.name === name ? { ...item, ...row } : item));
    const changed = rows.find((item) => item.name === name) as ComponentRow;
    if (tty) draw();
    else if (changed.state !== "running") io.out(plainRowLine(changed));
  };
  if (!tty) io.out(`$ haril update (${root})`);
  draw();

  // HARIL
  let snapshot: InstallSnapshot;
  try {
    snapshot = (services.snapshot ?? takeSnapshot)(root);
  } catch (error) {
    set("HARIL", {
      state: "failed",
      version: current,
      status: "falló antes de instalar",
      happened: `No se pudo guardar lo que haría falta restaurar: ${error instanceof Error ? error.message : String(error)}.`,
      result: `Sigue en ${current}: no se tocó nada.`,
      todo: "Revisa los permisos de la carpeta de HARIL y repite haril update.",
    });
    return 1;
  }
  set("HARIL", { state: "running", status: "instalando" });
  const timer = tty
    ? setInterval(() => {
        tick += 1;
        draw();
      }, REDRAW_MS)
    : undefined;
  let code: number;
  try {
    code = await services.install(script, root, source);
  } catch {
    code = -1;
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
  let installed: string | null = null;
  try {
    installed = installedVersion(root, services);
  } catch {
    installed = null;
  }
  const unverified: string[] = [];
  if (code === 0 && installed === available) {
    for (const tool of input.repairs) {
      let healthy = false;
      try {
        healthy =
          services.exists(tool.path) && (await services.verifyBinary(tool.path, tool.version));
      } catch {
        healthy = false;
      }
      if (!healthy) unverified.push(tool.name);
    }
  }
  if (code === 0 && installed === available && unverified.length === 0) {
    set("HARIL", {
      state: "ok",
      version: installed,
      status: input.repairOnly ? "dependencias reparadas" : "versión verificada",
      happened: input.repairOnly
        ? "Se reparó una dependencia que faltaba y pasó su verificación."
        : `Pasó de ${current} a ${installed}.`,
      result: `Instalado y verificado en ${installed}.`,
    });
  } else {
    let partial: string | null = null;
    try {
      (services.restore ?? restoreSnapshot)(root, snapshot);
      const back = installedVersion(root, services);
      if (back !== current) partial = `su registro dice ${back}`;
    } catch (error) {
      partial = error instanceof Error ? error.message : String(error);
    }
    const why =
      code !== 0
        ? `El instalador terminó con ${code}.`
        : unverified.length > 0
          ? `El instalador terminó bien, pero ${unverified.join(" y ")} no pasa su verificación.`
          : `Se esperaba ${available} y quedó ${installed ?? "sin versión"}.`;
    set("HARIL", {
      state: "failed",
      version: partial === null ? current : null,
      status: partial === null ? `falló; se volvió a ${current}` : "falló; restauración parcial",
      happened: why,
      result:
        partial === null
          ? `Sigue en ${current}: se restauró la versión anterior (su registro y bin/). Lo demás que el instalador ya escribió, como la carpeta de la versión nueva y las herramientas, no se deshace y queda sin usar.`
          : `Restauración parcial, la instalación puede haber quedado mezclada: ${partial}.`,
      todo: "Lee la salida del instalador y repite haril update.",
    });
    io.err(
      code !== 0
        ? `haril: installer failed (exit ${code}); inspect its output. Do not assume the update succeeded.`
        : `haril: the install did not verify; inspect its output. Do not assume the update succeeded.`,
    );
  }

  // The tools HARIL keeps apart from itself: read only, and a failed read is its own row.
  let versions: Readonly<Record<"engram" | "gentle-ai", string | null>> | null = null;
  try {
    versions = await (services.toolVersions ?? (() => toolVersionsFor(host)))();
  } catch {
    versions = null;
  }
  const engram = versions === null ? null : versions.engram;
  const gentle = versions === null ? null : versions["gentle-ai"];
  if (versions === null) {
    for (const name of ["Engram", "Gentle AI"]) {
      set(name, {
        state: "warning",
        status: "no se pudo leer",
        happened: "No se pudo leer su versión.",
        result: "No se cambió nada.",
        todo: "Ejecuta haril tools status.",
      });
    }
  } else {
    set("Engram", managedTool("Engram", engram, "haril tools ensure engram", "Si lo necesitas"));
    set(
      "Gentle AI",
      managedTool("Gentle AI", gentle, "haril tools update gentle-ai", "Si lo necesitas"),
    );
  }
  for (const name of ["Skills", "MCP", "Plantillas"]) {
    set(name, {
      state: "unmanaged",
      status: NOT_MANAGED,
      happened: NOT_MANAGED,
      result: "No se tocó.",
    });
  }

  const logPath = (services.writeLog ?? writeLogFile)(
    root,
    logFileText(rows, [`haril update ${current} -> ${available}`, `root: ${root}`]),
  );
  for (const line of summaryLines(rows, logPath, color)) io.out(line);
  return rows.some((row) => row.state === "failed") ? 1 : EXIT_OK;
}

function readVersion(path: string, services: UpdateServices): string {
  const value: unknown = JSON.parse(services.readText(path));
  const version =
    typeof value === "object" && value !== null && "version" in value ? value.version : null;
  if (versionParts(version) === null) throw new Error(`${path}: invalid semantic version`);
  return version as string;
}

function installedVersion(root: string, services: UpdateServices): string {
  const path = join(root, "app", "current.json");
  if (!services.exists(path)) {
    throw new Error(`${path} is missing; install HARIL before updating`);
  }
  return readVersion(path, services);
}

// Fail closed if an existing SQLite database cannot be inspected. A stale or dead
// lease is not active; a live, unexpired lease is an unconditional update refusal.
function runtimeState(dataDir: string): { state: "none" | "active" | "unknown"; detail?: string } {
  const file = join(dataDir, "haril.db");
  if (!existsSync(file)) return { state: "none" };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const leases = db
      .prepare("SELECT pid FROM runtime_leases WHERE status = 'active' AND expires_at > ?")
      .all(Date.now()) as { pid: number }[];
    const active = leases.find((lease) => defaultPidAlive(lease.pid));
    return active === undefined
      ? { state: "none" }
      : { state: "active", detail: `pid ${active.pid}` };
  } catch (error) {
    if (error instanceof Error && /no such table: runtime_leases/.test(error.message)) {
      return { state: "none" };
    }
    return { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

function installFrom(script: string, root: string, source: string): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, "--root", root], {
      cwd: source,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", () => done(1));
    child.once("close", (code) => done(code ?? 1));
  });
}

function git(args: readonly string[], cwd?: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("git", [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 90_000);
    child.stdout.on("data", (bytes: Buffer) => {
      stdout = (stdout + bytes.toString("utf8")).slice(-4096);
    });
    child.stderr.on("data", (bytes: Buffer) => {
      stderr = (stderr + bytes.toString("utf8")).slice(-4096);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveOutput(stdout);
      else
        reject(
          new Error(
            timedOut
              ? "git timed out after 90s; check GitHub connection, VPN, proxy or firewall"
              : `git failed (exit ${String(code)}): ${stderr.trim() || "connection closed or process interrupted"}`,
          ),
        );
    });
  });
}

// Prefer a ZIP archive over Git so updates work even when Git is not installed.
// This is an unsigned development snapshot: the printed 'archive:main' is not a commit SHA.
async function checkoutArchive(temp: string): Promise<MainCheckout> {
  const archive = join(temp, "main.zip");
  const extracted = join(temp, "unpacked");
  const response = await fetch(
    "https://codeload.github.com/anderson-camacho/HARIL/zip/refs/heads/main",
    {
      signal: AbortSignal.timeout(60_000),
      headers: { "User-Agent": "HARIL-updater" },
    },
  );
  if (!response.ok || response.body === null) {
    throw new Error(`GitHub archive HTTP ${response.status}`);
  }
  const limit = 32 * 1024 * 1024;
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("GitHub archive exceeds 32 MiB");
    chunks.push(chunk);
  }
  writeFileSync(archive, Buffer.concat(chunks));
  mkdirSync(extracted);
  if (process.platform === "win32") {
    const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
    await systemCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath ${quoted(archive)} -DestinationPath ${quoted(extracted)} -Force`,
    ]);
  } else {
    await systemCommand("unzip", ["-q", archive, "-d", extracted]);
  }
  const source = join(extracted, "HARIL-main");
  if (!existsSync(join(source, "scripts", "install.mjs"))) {
    throw new Error("GitHub archive lacks HARIL installer");
  }
  return {
    source,
    revision: "archive:main (no verified commit SHA)",
    cleanup: () => rmSync(temp, { recursive: true, force: true }),
  };
}

function systemCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((done, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let detail = "";
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stderr.on("data", (bytes: Buffer) => {
      detail = (detail + bytes.toString("utf8")).slice(-1000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else reject(new Error(`${command} failed (exit ${code ?? "interrupted"}): ${detail}`));
    });
  });
}

// Clone main into an isolated temporary directory: never switch or pull the user's worktree.
async function checkoutMain(): Promise<MainCheckout> {
  const temp = mkdtempSync(join(tmpdir(), "haril-main-"));
  const source = join(temp, "checkout");
  const cleanup = () => rmSync(temp, { recursive: true, force: true });
  let archiveFailure: unknown;
  try {
    return await checkoutArchive(temp);
  } catch (error) {
    archiveFailure = error;
  }
  try {
    await git(["init", "--quiet", source]);
    await git(["-C", source, "remote", "add", "origin", MAIN_REPOSITORY]);
    // A fetch is more resilient than 'clone' on intermittent Windows HTTPS connections.
    // HTTP/1.1 avoids the TLS resets seen by some Git for Windows installations.
    let lastError: unknown;
    let fetched = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await git([
          "-c",
          "http.version=HTTP/1.1",
          "-C",
          source,
          "fetch",
          "--quiet",
          "--depth",
          "1",
          "--no-tags",
          "origin",
          "main",
        ]);
        fetched = true;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((done) => setTimeout(done, 1_000 * (attempt + 1)));
      }
    }
    if (!fetched) throw lastError ?? new Error("GitHub main is unreachable");
    await git(["-C", source, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const revision = (await git(["-C", source, "rev-parse", "--verify", "HEAD"])).trim();
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Git returned an invalid commit SHA");
    return { source, revision, cleanup };
  } catch (error) {
    cleanup();
    const archive =
      archiveFailure instanceof Error ? archiveFailure.message : String(archiveFailure);
    const gitError = error instanceof Error ? error.message : String(error);
    throw new Error(`archive failed (${archive}); Git fallback failed (${gitError})`);
  }
}

async function askConfirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Update HARIL from the selected source? [y/N] ");
    return /^(y|yes|s|si|sí)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// A managed executable can exist yet fail to start because its Python environment
// was removed or its version is incompatible. Treat that as a repairable install.
function verifyManagedBinary(path: string, version: string): Promise<boolean> {
  return new Promise<boolean>((done) => {
    let output = "";
    let finished = false;
    const complete = (healthy: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(healthy);
    };
    const child = spawn(path, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const onData = (chunk: Buffer) => {
      if (output.length < 4096) output += chunk.toString("utf8").slice(0, 4096);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      child.kill();
      complete(false);
    }, 10_000);
    child.once("error", () => complete(false));
    child.once("close", (code) => {
      const escaped = version.replaceAll(".", "\\.");
      complete(code === 0 && new RegExp(`(^|[^0-9.])${escaped}($|[^0-9.])`).test(output));
    });
  });
}

const DEFAULT_SERVICES: UpdateServices = {
  readText: (path) => readFileSync(path, "utf8"),
  exists: existsSync,
  verifyBinary: verifyManagedBinary,
  activeRuntime: runtimeState,
  install: installFrom,
  confirm: askConfirm,
  checkoutMain,
};

export async function update(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
  services: UpdateServices = DEFAULT_SERVICES,
): Promise<number> {
  let sourceArg: string | undefined;
  let main = false;
  let check = false;
  let yes = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === "--check") check = true;
    else if (token === "--yes") yes = true;
    else if (token === "--main") main = true;
    else if (token === "--from") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || value === "") {
        io.err(USAGE);
        return EXIT_USAGE;
      }
      sourceArg = value;
      index++;
    } else {
      io.err(USAGE);
      return EXIT_USAGE;
    }
  }

  if (main && sourceArg !== undefined) {
    io.err("haril: choose either --main or --from");
    return EXIT_USAGE;
  }
  // Explicit --from (or the advanced HARIL_SOURCE_DIR override) retains local updates.
  // Otherwise 'haril update', '--check' and '--yes' all use the main channel.
  const useMain = main || (sourceArg === undefined && !host.env?.HARIL_SOURCE_DIR);
  let checkout: MainCheckout | undefined;
  if (useMain) {
    try {
      io.out("Checking GitHub main (development channel; not a signed release)...");
      checkout = await services.checkoutMain();
    } catch (error) {
      io.err(`haril: cannot fetch main: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  try {
    const source =
      checkout?.source ??
      resolve(host.cwd ?? process.cwd(), sourceArg ?? host.env?.HARIL_SOURCE_DIR ?? ".");
    const script = join(source, "scripts", "install.mjs");
    const manifest = join(source, "apps", "haril", "package.json");
    const root = runtimeRootFor(host);
    let current: string;
    let available: string;
    try {
      current = installedVersion(root, services);
      if (!services.exists(script) || !services.exists(manifest)) {
        io.err(
          `haril: no usable HARIL source at ${source}; use --from <local-repository> or retry the GitHub connection.`,
        );
        return EXIT_USAGE;
      }
      available = readVersion(manifest, services);
    } catch (error) {
      io.err(`haril: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT_USAGE;
    }

    io.out(
      `HARIL installed: ${current}; ${useMain ? "GitHub main" : "local source"}: ${available} (${checkout?.revision ?? source})`,
    );
    const comparison = compareVersions(available, current);
    if (comparison < 0) {
      io.err("haril: the selected source is older; downgrades are not automatic");
      return EXIT_USAGE;
    }
    const ops = host.platform === "win32" ? win32 : posix;
    const toolsDir = ops.join(root, "tools");
    const executable = (name: string) => (host.platform === "win32" ? `${name}.exe` : name);
    const requiredTools = [
      { name: "uv", path: ops.join(toolsDir, "uv", executable("uv")), version: "0.13.5" },
      { name: "Matrix", path: ops.join(toolsDir, "bin", executable("tte")), version: "0.15.0" },
    ];
    const visualsEnabled =
      host.env?.HARIL_AUTO_INSTALL_VISUALS !== "off" &&
      host.env?.HARIL_STARTUP_ANIMATION !== "off" &&
      services.exists(join(source, "scripts", "install-visual-tools.mjs"));
    const unhealthyTools = visualsEnabled
      ? (
          await Promise.all(
            requiredTools.map(async (tool) => ({
              ...tool,
              healthy:
                services.exists(tool.path) &&
                (await services.verifyBinary(tool.path, tool.version)),
            })),
          )
        ).filter((tool) => !tool.healthy)
      : [];
    const needsVisualSetup = unhealthyTools.length > 0;
    if (comparison === 0 && !needsVisualSetup) {
      io.out("HARIL is already at the selected source version.");
      return EXIT_OK;
    }
    if (check) {
      io.out(
        comparison > 0
          ? "An update is available; the installed files were not changed."
          : `HARIL is up to date, but the managed Matrix dependency needs repair (${unhealthyTools.map((tool) => tool.name).join(", ")}); no files were changed.`,
      );
      return EXIT_OK;
    }

    const runtime = services.activeRuntime(dataDirFor(host, undefined));
    if (runtime.state !== "none") {
      io.err(
        runtime.state === "active"
          ? `haril: a runtime is active (${runtime.detail ?? "unknown PID"}); stop it before updating`
          : `haril: runtime state could not be checked (${runtime.detail ?? "unknown"}); update refused`,
      );
      return EXIT_USAGE;
    }
    if (!yes) {
      if (host.interactive !== true) {
        io.err("haril: confirmation required; inspect with --check, then use --yes");
        return EXIT_USAGE;
      }
      if (!(await services.confirm())) {
        io.out("Update cancelled; no files were changed.");
        return EXIT_OK;
      }
    }

    io.out(
      comparison > 0
        ? `Updating HARIL to ${available} from ${useMain ? "GitHub main" : "local source"} through the installer...`
        : "Repairing the missing Matrix dependency through the HARIL installer...",
    );
    return await runComponents(
      {
        available,
        current,
        root,
        script,
        source,
        repairOnly: comparison === 0,
        repairs: comparison === 0 ? unhealthyTools : [],
      },
      io,
      host,
      services,
    );
  } finally {
    checkout?.cleanup();
  }
}
