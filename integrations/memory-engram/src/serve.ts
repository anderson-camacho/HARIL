// Supervision of `engram serve` (ADR-0008 D4, D5; MEMORY.md 4.4, 9, 11.3; memory.md 9.4 points 1 to 4 and 11): one
// serve per data dir, child of the Runtime, launched on the first memory operation. Before the launch the data dir
// and port guards run; the binary is an absolute path (never a PATH lookup); the environment is built from scratch
// with ENGRAM_DATA_DIR, ENGRAM_PORT and a token new on every launch. The serve is ready when GET /health answers on
// its port with the .instance-id of HARIL's data dir; one that exits 0 first (#1462) or another server on the port
// is never trusted nor reused. A crash is relaunched on the next connect, after a backoff and up to a cap; stop()
// kills the whole tree. The pid, its start time and the reconciliation of an orphan of an earlier Runtime need the
// Store and belong to the Runtime (memory.md 9.4 point 8; MC-T6).
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { HarilError, Result } from "@haril/core/ports";
import { checkEngramDataDir, checkEngramPort, engramDataDirOf, pickEngramPort } from "./guards.js";
import type { EngramEndpoint, FetchFn } from "./http.js";
import { readHealth } from "./wire.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface EngramBinary {
  // Absolute: the pinned binary under vendor/engram/<ver>/ (ADR-0008 D8), or the host Node in a test.
  readonly path: string;
  // Arguments before `serve` (the fake executable's script in a test); the real binary takes none.
  readonly leadingArgs?: readonly string[];
}

export interface EngramSpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: ["ignore", "pipe", "pipe"];
  readonly detached: boolean;
}

export type EngramSpawnFn = (
  command: string,
  args: readonly string[],
  options: EngramSpawnOptions,
) => ChildProcess;

// [S] values, none measured (MEMORY.md 13.1; T10): Engram may wait up to 60 s on .migrate.lock (06 sec3.9), so a
// first launch on a large base can need a longer readiness deadline than this.
export interface EngramServeTimings {
  readonly readinessMs?: number;
  readonly pollMs?: number;
  readonly stopMs?: number;
  readonly restartBaseMs?: number;
  readonly restartCapMs?: number;
  // A serve that stayed up this long before it crashed starts the restart count again.
  readonly stableMs?: number;
}

export interface EngramServeOptions {
  readonly binary: EngramBinary;
  // HARIL's data dir (<root>\data); the serve's data dir is its memory\engram (ARCH 4.4).
  readonly harilDataDir: string;
  // Where the user's own ~/.engram is, for the guard.
  readonly homeDir: string;
  // The parent's environment: only SystemRoot, TEMP and TMP reach the child; the OneDrive variables feed the guard.
  readonly osEnv: Env;
  // An explicit port; absent, a free one is picked on every launch.
  readonly port?: number;
  // Relaunches after a crash before giving up [S].
  readonly maxRestarts?: number;
  readonly timings?: EngramServeTimings;
  readonly spawn?: EngramSpawnFn;
  readonly fetch?: FetchFn;
  readonly platform?: NodeJS.Platform;
}

export type EngramServeState = "idle" | "starting" | "ready" | "down" | "failed" | "stopped";

export interface EngramServeStatus {
  readonly state: EngramServeState;
  readonly pid: number | null;
  // The pid of the last child launched, alive or not.
  readonly lastPid: number | null;
  readonly port: number | null;
  readonly restarts: number;
  readonly lastError: string | null;
}

export interface EngramServe {
  // The verified endpoint, launching the serve when it is not running.
  connect(): Promise<Result<EngramEndpoint, HarilError>>;
  stop(): Promise<void>;
  status(): EngramServeStatus;
}

const DEFAULT_TIMINGS = {
  readinessMs: 15_000,
  pollMs: 100,
  stopMs: 5_000,
  restartBaseMs: 1_000,
  restartCapMs: 30_000,
  stableMs: 60_000,
};
const DEFAULT_MAX_RESTARTS = 3;
const OUTPUT_TAIL_CHARS = 2_000;

// The data dirs that have a supervisor in this process: one serve per data dir, one opener of its SQLite (D4).
const held = new Set<string>();

// MEMORY.md 4.4: a whitelist built from scratch. Left out on purpose: ENGRAM_PROJECT, ENGRAM_AGENT_CLI,
// ENGRAM_CLOUD_*, ENGRAM_SOCKET and ENGRAM_URL, and PATH, HOME and USERPROFILE, so nothing can lead Engram back to
// ~/.engram. ENGRAM_STARTUP_POLICY=deny is memory.md 9.4 point 3; that ENGRAM_NO_UPDATE_CHECK stops a network check
// is NOT VERIFIED.
export function buildEngramEnv(input: {
  readonly dataDir: string;
  readonly port: number;
  readonly token: string;
  readonly osEnv: Env;
}): Record<string, string> {
  const env: Record<string, string> = {
    ENGRAM_DATA_DIR: input.dataDir,
    ENGRAM_PORT: String(input.port),
    ENGRAM_HTTP_TOKEN: input.token,
    ENGRAM_STARTUP_POLICY: "deny",
    ENGRAM_NO_UPDATE_CHECK: "1",
  };
  // Windows needs these to start a process (as in integrations/agent-pi).
  for (const name of ["SystemRoot", "TEMP", "TMP"] as const) {
    const value = input.osEnv[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env;
}

const defaultSpawn: EngramSpawnFn = (command, args, options) => spawn(command, [...args], options);

// Windows: taskkill /T takes the whole tree; POSIX: the child leads its own process group (detached). The same
// approach as integrations/agent-pi's killProcessTree, which an integration cannot import (ADR-0015 matrix).
function killTree(child: ChildProcess, osEnv: Env, platform: NodeJS.Platform): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (platform === "win32") {
    const systemRoot = osEnv.SystemRoot ?? osEnv.windir ?? "C:\\Windows";
    const killer = spawn(
      join(systemRoot, "System32", "taskkill.exe"),
      ["/F", "/T", "/PID", String(pid)],
      {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    killer.on("error", () => {});
    killer.on("exit", () => child.kill("SIGKILL"));
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function failure(code: string, message: string): Result<never, HarilError> {
  return { ok: false, error: { code: `memory.serve.${code}`, message } };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Supervisor implements EngramServe {
  private readonly options: EngramServeOptions;
  private readonly timings: typeof DEFAULT_TIMINGS;
  private readonly platform: NodeJS.Platform;
  private readonly spawnFn: EngramSpawnFn;
  private readonly fetchFn: FetchFn;
  private state: EngramServeState = "idle";
  private child: ChildProcess | undefined;
  private exit: { code: number | null; error: string | undefined } | undefined;
  private endpoint: EngramEndpoint | undefined;
  private starting: Promise<Result<EngramEndpoint, HarilError>> | undefined;
  private failedWith: Result<never, HarilError> | undefined;
  private holding: string | undefined;
  private crashes = 0;
  private nextLaunchAt = 0;
  private readyAt = 0;
  private lastPid: number | null = null;
  private port: number | null = null;
  private lastError: string | null = null;
  private output = "";

  constructor(options: EngramServeOptions) {
    this.options = options;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.platform = options.platform ?? process.platform;
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  status(): EngramServeStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      lastPid: this.lastPid,
      port: this.port,
      restarts: this.crashes,
      lastError: this.lastError,
    };
  }

  connect(): Promise<Result<EngramEndpoint, HarilError>> {
    if (this.state === "stopped")
      return Promise.resolve(failure("stopped", "engram serve was stopped"));
    if (this.state === "failed" && this.failedWith !== undefined)
      return Promise.resolve(this.failedWith);
    if (this.state === "ready" && this.endpoint !== undefined) {
      return Promise.resolve({ ok: true, value: this.endpoint });
    }
    if (this.starting !== undefined) return this.starting;
    if (this.state === "down") {
      const maxRestarts = this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
      if (this.crashes > maxRestarts) {
        return Promise.resolve(
          this.fail("gave_up", `engram serve failed ${this.crashes} times in a row`),
        );
      }
      if (Date.now() < this.nextLaunchAt) {
        return Promise.resolve(failure("backoff", "engram serve is waiting before its relaunch"));
      }
    }
    this.starting = this.launch().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    await this.starting?.catch(() => undefined);
    await this.terminate();
    if (this.holding !== undefined) held.delete(this.holding);
    this.holding = undefined;
    this.endpoint = undefined;
    this.state = "stopped";
  }

  // ---- Launch ----

  private async launch(): Promise<Result<EngramEndpoint, HarilError>> {
    const { options } = this;
    const dataDir = engramDataDirOf(options.harilDataDir, this.platform);
    const guarded = checkEngramDataDir({
      candidate: dataDir,
      harilDataDir: options.harilDataDir,
      homeDir: options.homeDir,
      env: options.osEnv,
      platform: this.platform,
    });
    if (!guarded.ok) return this.note(failure("data_dir_refused", guarded.message));
    if (!isAbsolute(options.binary.path) || !existsSync(options.binary.path)) {
      return this.note(
        failure("binary_refused", `${options.binary.path} is not an absolute path to a file`),
      );
    }
    const port = options.port ?? (await pickEngramPort());
    const portCheck = await checkEngramPort(port);
    if (!portCheck.ok) return this.note(failure("port_refused", portCheck.message));
    const key = this.platform === "win32" ? guarded.dataDir.toLowerCase() : guarded.dataDir;
    if (this.holding !== key) {
      if (held.has(key)) {
        return this.note(
          failure("held", `another engram serve of this process holds ${guarded.dataDir}`),
        );
      }
      held.add(key);
      this.holding = key;
    }
    await mkdir(guarded.dataDir, { recursive: true });
    if (this.state === "stopped") return failure("stopped", "engram serve was stopped");
    const token = randomBytes(32).toString("hex");
    this.state = "starting";
    this.port = port;
    this.spawnChild(guarded.dataDir, port, token);
    return this.awaitReady(guarded.dataDir, port, token);
  }

  private spawnChild(dataDir: string, port: number, token: string): void {
    const { binary, osEnv } = this.options;
    this.exit = undefined;
    this.output = "";
    const child = this.spawnFn(binary.path, [...(binary.leadingArgs ?? []), "serve"], {
      cwd: dataDir,
      env: buildEngramEnv({ dataDir, port, token, osEnv }),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: this.platform !== "win32",
    });
    this.child = child;
    this.lastPid = child.pid ?? null;
    const keep = (chunk: Buffer): void => {
      this.output = `${this.output}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.once("error", (error) => {
      if (this.child === child) this.exit = { code: null, error: error.message };
    });
    child.once("exit", (code) => this.exited(child, code));
  }

  // Polls GET /health until it names the data dir's .instance-id, the child exits, or the deadline passes.
  private async awaitReady(
    dataDir: string,
    port: number,
    token: string,
  ): Promise<Result<EngramEndpoint, HarilError>> {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + this.timings.readinessMs;
    while (Date.now() < deadline) {
      if (this.state === "stopped") return failure("stopped", "engram serve was stopped");
      const exit = this.exit;
      if (exit !== undefined) {
        if (exit.code === 0) {
          return this.fail(
            "exited",
            "engram serve exited 0 before it was ready: another instance may hold its data dir (#1462)",
          );
        }
        return this.down(
          "exited",
          `engram serve exited before it was ready (${exit.error ?? `code ${exit.code}`})`,
        );
      }
      const instanceId = await this.probe(baseUrl, Math.max(1, deadline - Date.now()));
      if (instanceId !== undefined) {
        const own = await readFile(join(dataDir, ".instance-id"), "utf8").then(
          (text) => text.trim(),
          () => undefined,
        );
        if (own !== undefined && own !== "") {
          if (instanceId !== own) {
            this.kill();
            return this.down(
              "foreign_instance",
              `the server on 127.0.0.1:${port} is not the instance of ${dataDir}`,
            );
          }
          this.state = "ready";
          this.readyAt = Date.now();
          this.lastError = null;
          this.endpoint = { baseUrl, token, instanceId: own, dataDir };
          return { ok: true, value: this.endpoint };
        }
      }
      await delay(this.timings.pollMs);
    }
    this.kill();
    return this.down(
      "not_ready",
      `engram serve was not ready within ${this.timings.readinessMs} ms`,
    );
  }

  // The instance_id GET /health answers, or undefined while nothing answers.
  private async probe(baseUrl: string, remainingMs: number): Promise<string | undefined> {
    try {
      const response = await this.fetchFn(`${baseUrl}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(1_000, remainingMs)),
      });
      if (response.status !== 200) return undefined;
      return readHealth(await response.json())?.instanceId ?? undefined;
    } catch {
      return undefined;
    }
  }

  private exited(child: ChildProcess, code: number | null): void {
    if (this.child !== child) return;
    this.exit = { code, error: this.exit?.error };
    this.child = undefined;
    if (this.state !== "ready") return;
    this.endpoint = undefined;
    if (Date.now() - this.readyAt >= this.timings.stableMs) this.crashes = 0;
    this.crash(`engram serve exited (code ${code ?? "none"})`);
  }

  // ---- Outcomes ----

  // A failure that a later launch may overcome: counted, with a backoff before the relaunch.
  private down(code: string, message: string): Result<never, HarilError> {
    this.crash(message);
    return failure(code, message);
  }

  private crash(message: string): void {
    this.crashes += 1;
    const backoff = Math.min(
      this.timings.restartCapMs,
      this.timings.restartBaseMs * 2 ** (this.crashes - 1),
    );
    this.nextLaunchAt = Date.now() + backoff;
    this.state = "down";
    this.lastError = this.output === "" ? message : `${message}: ${this.output.trim().slice(-300)}`;
  }

  // A failure no relaunch will fix: the supervisor stays failed until a new one is created.
  private fail(code: string, message: string): Result<never, HarilError> {
    this.kill();
    this.state = "failed";
    this.lastError = message;
    this.failedWith = failure(code, message);
    return this.failedWith;
  }

  // A refusal before anything was launched: the state does not change, so a corrected setup can launch.
  private note(result: Result<never, HarilError>): Result<never, HarilError> {
    if (!result.ok) this.lastError = result.error.message;
    return result;
  }

  private kill(): void {
    const child = this.child;
    if (child !== undefined && child.exitCode === null)
      killTree(child, this.options.osEnv, this.platform);
  }

  private async terminate(): Promise<void> {
    const child = this.child;
    if (child === undefined || child.exitCode !== null) return;
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    killTree(child, this.options.osEnv, this.platform);
    await Promise.race([gone, delay(this.timings.stopMs)]);
  }
}

export function createEngramServe(options: EngramServeOptions): EngramServe {
  return new Supervisor(options);
}
