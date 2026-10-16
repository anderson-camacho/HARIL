// AgentRuntime adapter for Pi 1.2.0 in `--mode rpc` (ADR-0004). One Pi process per attempt. The adapter
// owns the bridge channel (named pipe or unix socket with a 256-bit token), the RPC JSONL stream, the
// handshake (fail closed), the bridge read operation through PathGuard, and the abort/kill escalation.
// It never sends new_session, switch_session, fork or clone, and it never logs the token or the key.

import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, promises as fsp, mkdirSync, type WriteStream } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type {
  AgentHandle,
  AgentHello,
  AgentOutcome,
  AgentRuntime,
  AgentSpec,
  HarilError,
  Result,
} from "@haril/core/ports";
import { JsonlReader } from "./jsonl.js";
import { buildPiArgv, buildPiEnv, defaultSpawn, killProcessTree, type SpawnFn } from "./launch.js";
import { createPathGuard, type PathGuard } from "./path-guard.js";

export interface PiTimings {
  readonly helloTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly graceMs?: number;
}

export type BridgeOperationOutcome =
  | "ok"
  | "path_denied"
  | "too_large"
  | "read_failed"
  | "unsupported";

// Event-friendly record of one bridge operation: the path is hashed and the content is never included.
export interface BridgeOperationEvent {
  readonly runId: string;
  readonly op: string;
  readonly pathSha256: string;
  readonly outcome: BridgeOperationOutcome;
}

export interface PiAgentRuntimeOptions {
  readonly nodePath: string;
  readonly piCliPath: string;
  readonly bridgePath: string;
  readonly brokerUrl: string;
  readonly projectRoot: string;
  readonly runsDir: string;
  // Expected active model: passed as --model and checked with get_state before the first prompt.
  readonly model: string;
  // Virtual key for the Broker. Reserve delivery through HARIL_VKEY (ADR-0005 BR-4); never argv or events.
  readonly virtualKey: string;
  readonly spawn?: SpawnFn;
  readonly pathGuard?: PathGuard;
  readonly timings?: PiTimings;
  readonly onBridgeOperation?: (event: BridgeOperationEvent) => void;
}

export interface PiDiagnostics {
  readonly ignoredEvents: number;
  readonly warnings: readonly string[];
}

export interface PiAgentHandle extends AgentHandle {
  readonly diagnostics: PiDiagnostics;
}

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_HELLO_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_GRACE_MS = 5_000;
// A bridge that drops while Pi is still running is a loss; a Pi that exits on its own is reported first.
const BRIDGE_LOST_GRACE_MS = 250;

type Timer = ReturnType<typeof setTimeout>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sameTokenBytes(received: unknown, expected: string): boolean {
  if (typeof received !== "string") return false;
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function sameTools(received: readonly string[], allowed: readonly string[]): boolean {
  const left = [...received].sort();
  const right = [...allowed].sort();
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

function assistantText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((part) => asRecord(part))
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part?.text as string);
  return parts.length > 0 ? parts.join("") : undefined;
}

function validate(spec: AgentSpec, options: PiAgentRuntimeOptions): HarilError | undefined {
  const invalid = (message: string): HarilError => ({ code: "agent.invalid_spec", message });
  if (!RUN_ID.test(spec.runId)) return invalid("runId must be 1-64 characters of [A-Za-z0-9_-]");
  for (const [name, value] of [
    ["nodePath", options.nodePath],
    ["piCliPath", options.piCliPath],
    ["bridgePath", options.bridgePath],
    ["projectRoot", options.projectRoot],
    ["runsDir", options.runsDir],
  ] as const) {
    if (!isAbsolutePath(value)) return invalid(`${name} must be an absolute path`);
  }
  if (options.model.length === 0 || options.virtualKey.length === 0) {
    return invalid("model and virtualKey must be non-empty");
  }
  if (!spec.allowedTools.every((tool) => tool.length > 0 && !tool.includes(","))) {
    return invalid("allowedTools must be non-empty names without commas");
  }
  if (!(spec.timeoutMs > 0) || !Number.isFinite(spec.timeoutMs)) {
    return invalid("timeoutMs must be a positive number");
  }
  return undefined;
}

function isAbsolutePath(value: string): boolean {
  return (
    value.length > 0 &&
    (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\"))
  );
}

export function createPiAgentRuntime(options: PiAgentRuntimeOptions): AgentRuntime {
  const spawnFn = options.spawn ?? defaultSpawn;
  return {
    async start(spec: AgentSpec): Promise<Result<AgentHandle, HarilError>> {
      const invalid = validate(spec, options);
      if (invalid !== undefined) return { ok: false, error: invalid };
      const run = new PiRun(spec, options, spawnFn);
      try {
        await run.init();
      } catch (error) {
        await run.abandon();
        const reason = error instanceof Error ? error.message : "unknown error";
        return { ok: false, error: { code: "agent.spawn_failed", message: reason } };
      }
      return { ok: true, value: run };
    },
  };
}

class PiRun implements PiAgentHandle {
  readonly runId: string;
  readonly hello: Promise<AgentHello>;
  readonly settled: Promise<AgentOutcome>;

  private readonly spec: AgentSpec;
  private readonly options: PiAgentRuntimeOptions;
  private readonly spawnFn: SpawnFn;
  private readonly helloTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly graceMs: number;
  private readonly guard: PathGuard;
  private readonly runDir: string;
  private readonly token = randomBytes(32).toString("hex");
  private readonly pipeName: string;
  private readonly helloD = deferred<AgentHello>();
  private readonly readyD = deferred<void>();
  private readonly settledD = deferred<AgentOutcome>();
  private readonly exitedD = deferred<void>();
  private readonly pending = new Map<
    string,
    { command: string; resolve(reply: Json | undefined): void }
  >();
  private readonly warnings: string[] = [];
  private readonly osEnv: NodeJS.ProcessEnv = process.env;

  private server: Server | undefined;
  private bridgeSocket: Socket | undefined;
  private child: ChildProcess | undefined;
  private stderrLog: WriteStream | undefined;
  private stdoutReader: JsonlReader | undefined;
  private stdinOpen = false;
  private childClosed = false;
  private killedByUs = false;
  private finished = false;
  private failure: HarilError | undefined;
  private stopRequest: "abort" | "timeout" | undefined;
  private helloDone = false;
  private promptStarted = false;
  private settledSeen = false;
  private finalText: string | undefined;
  private providerError: string | undefined;
  private streamedText = "";
  private ignoredEvents = 0;
  private seq = 0;
  private helloTimer: Timer | undefined;
  private startupTimer: Timer | undefined;
  private deadlineTimer: Timer | undefined;
  private graceTimer: Timer | undefined;
  private bridgeLostTimer: Timer | undefined;

  constructor(spec: AgentSpec, options: PiAgentRuntimeOptions, spawnFn: SpawnFn) {
    this.spec = spec;
    this.runId = spec.runId;
    this.options = options;
    this.spawnFn = spawnFn;
    this.helloTimeoutMs = options.timings?.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.startupTimeoutMs = options.timings?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.graceMs = options.timings?.graceMs ?? DEFAULT_GRACE_MS;
    this.guard = options.pathGuard ?? createPathGuard(options.projectRoot);
    this.runDir = join(options.runsDir, spec.runId);
    const suffix = randomBytes(8).toString("hex");
    this.pipeName =
      process.platform === "win32"
        ? `\\\\.\\pipe\\haril-${spec.runId}-${suffix}`
        : join(this.runDir, "bridge.sock");
    this.hello = this.helloD.promise;
    this.settled = this.settledD.promise;
    // Rejections are read by prompt() and by settled; this stops an early rejection from being unhandled.
    this.hello.catch(() => {});
    this.readyD.promise.catch(() => {});
  }

  get diagnostics(): PiDiagnostics {
    return { ignoredEvents: this.ignoredEvents, warnings: [...this.warnings] };
  }

  async init(): Promise<void> {
    mkdirSync(join(this.runDir, "agent"), { recursive: true });
    mkdirSync(join(this.runDir, "pi"), { recursive: true });
    this.stderrLog = createWriteStream(join(this.runDir, "pi", "stderr.log"), { flags: "a" });
    this.stderrLog.on("error", () => {});

    const server = createServer((socket) => this.onBridgeConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.pipeName, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const bridge = `${this.pipeName}#${this.token}`;
    const env = buildPiEnv({
      nodePath: this.options.nodePath,
      agentDir: join(this.runDir, "agent"),
      runId: this.runId,
      bridge,
      tools: this.spec.allowedTools,
      brokerUrl: this.options.brokerUrl,
      model: this.options.model,
      virtualKey: this.options.virtualKey,
      osEnv: this.osEnv,
    });
    const argv = buildPiArgv({
      piCliPath: this.options.piCliPath,
      bridgePath: this.options.bridgePath,
      sessionDir: join(this.runDir, "pi"),
      model: this.options.model,
    });
    const child = this.spawnFn(this.options.nodePath, argv, {
      cwd: this.runDir,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.stdinOpen = child.stdin !== null;
    this.wireChild(child);
    this.helloTimer = setTimeout(
      () => this.fail("agent.handshake_timeout", "the bridge did not send hello in time"),
      this.helloTimeoutMs,
    );
  }

  // Start failed after resources were created: release them without a settled outcome to report.
  async abandon(): Promise<void> {
    this.clearTimers();
    this.server?.close();
    this.stderrLog?.end();
    this.finished = true;
    this.settledD.resolve({ status: "aborted" });
    this.exitedD.resolve();
  }

  prompt(text: string): Promise<Result<void, HarilError>> {
    return this.sendPrompt(text);
  }

  async abort(): Promise<void> {
    this.stop("abort");
    await this.exitedD.promise;
  }

  async dispose(): Promise<void> {
    this.stop("abort");
    await this.exitedD.promise;
  }

  private async sendPrompt(text: string): Promise<Result<void, HarilError>> {
    if (this.finished) return { ok: false, error: this.closedError() };
    if (this.promptStarted) {
      return {
        ok: false,
        error: { code: "agent.prompt_repeated", message: "a run takes one prompt" },
      };
    }
    this.promptStarted = true;
    try {
      await this.hello;
      await this.readyD.promise;
    } catch {
      return { ok: false, error: this.closedError() };
    }
    if (this.finished) return { ok: false, error: this.closedError() };

    const reply = await this.request("prompt", { message: text });
    if (reply === undefined) return { ok: false, error: this.closedError() };
    const disposition = asRecord(reply.data)?.disposition;
    if (reply.success !== true || (disposition !== "started" && disposition !== "queued")) {
      const message = "Pi did not accept the prompt";
      this.fail("agent.prompt_rejected", message);
      return { ok: false, error: { code: "agent.prompt_rejected", message } };
    }
    // The reply and agent_settled can arrive in one chunk: the run may already be finished, and a timer armed
    // now would never be cleared, which keeps the runtime process alive for the whole timeout (M2-T6).
    if (this.finished) return { ok: true, value: undefined };
    this.deadlineTimer = setTimeout(() => this.stop("timeout"), this.spec.timeoutMs);
    return { ok: true, value: undefined };
  }

  private closedError(): HarilError {
    return (
      this.failure ?? { code: "agent.closed", message: "the run closed before it was accepted" }
    );
  }

  private wireChild(child: ChildProcess): void {
    child.stdin?.on("error", () => {});
    child.stderr?.on("data", (chunk: Buffer) => this.stderrLog?.write(chunk));
    this.stdoutReader = new JsonlReader({
      onLine: (line) => this.onStdoutLine(line),
      onOverflow: () => this.fail("protocol_line_too_long", "a Pi stdout line exceeded 8 MiB"),
    });
    child.stdout?.on("data", (chunk: Buffer) => this.stdoutReader?.push(chunk));
    child.stdout?.on("end", () => this.stdoutReader?.end());
    child.on("error", (error) => {
      this.fail("agent.spawn_failed", `Pi could not be started: ${error.message}`);
      if (child.pid === undefined) this.onClose(null, null);
    });
    child.on("close", (code, signal) => this.onClose(code, signal));
  }

  private onBridgeConnection(socket: Socket): void {
    if (this.bridgeSocket !== undefined || this.finished) {
      socket.destroy();
      return;
    }
    this.bridgeSocket = socket;
    socket.on("error", () => {});
    const reader = new JsonlReader({
      onLine: (line) => this.onBridgeLine(line),
      onOverflow: () => this.fail("protocol_line_too_long", "a bridge line exceeded 8 MiB"),
    });
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("end", () => reader.end());
    socket.on("close", () => {
      this.bridgeSocket = undefined;
      if (this.finished || this.stopRequest !== undefined) return;
      this.bridgeLostTimer = setTimeout(() => {
        if (!this.childClosed) {
          this.fail("agent.bridge_lost", "the bridge channel closed before the run settled");
        }
      }, BRIDGE_LOST_GRACE_MS);
    });
  }

  private onBridgeLine(line: string): void {
    if (line.trim() === "" || this.finished) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail("agent.bridge_protocol_error", "a bridge message is not JSON");
      return;
    }
    const message = asRecord(parsed);
    if (message === undefined) {
      this.fail("agent.bridge_protocol_error", "a bridge message is not an object");
      return;
    }
    if (!this.helloDone) {
      this.onHello(message);
      return;
    }
    if (message.op !== undefined) void this.onBridgeOperation(message);
  }

  private onHello(message: Json): void {
    const reject = (reason: string): void => {
      this.fail("agent.handshake_mismatch", `hello rejected: ${reason}`);
    };
    if (message.type !== "hello") {
      reject("first message is not hello");
      return;
    }
    if (!sameTokenBytes(message.token, this.token)) {
      reject("wrong token");
      return;
    }
    if (message.runId !== this.runId) {
      reject("wrong runId");
      return;
    }
    if (typeof message.bridgeVersion !== "string") {
      reject("missing bridgeVersion");
      return;
    }
    const tools = Array.isArray(message.tools) ? message.tools : undefined;
    if (tools === undefined || !tools.every((tool) => typeof tool === "string")) {
      reject("tools is not a list of names");
      return;
    }
    if (!sameTools(tools as string[], this.spec.allowedTools)) {
      reject("tools differ from allowedTools");
      return;
    }

    this.helloDone = true;
    clearTimeout(this.helloTimer);
    this.helloD.resolve({ tools: [...(tools as string[])] });
    this.startupTimer = setTimeout(
      () => this.fail("agent.startup_timeout", "Pi did not answer get_state in time"),
      this.startupTimeoutMs,
    );
    void this.runStartup();
  }

  private async runStartup(): Promise<void> {
    const reply = await this.request("get_state", {});
    if (this.finished || reply === undefined) return;
    if (reply.success !== true) return this.fail("agent.startup_failed", "get_state failed");
    const model = asRecord(reply.data)?.model;
    const activeModel = typeof model === "string" ? model : asRecord(model)?.id;
    if (activeModel !== this.options.model) {
      return this.fail("agent.model_mismatch", "Pi reports a different active model");
    }
    clearTimeout(this.startupTimer);
    this.readyD.resolve();
  }

  private async onBridgeOperation(message: Json): Promise<void> {
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    if (message.op !== "read") {
      this.recordOperation(String(message.op), sha256(""), "unsupported");
      this.replyBridge(id, { ok: false, error: "unsupported" });
      return;
    }
    const requested = typeof message.path === "string" ? message.path : "";
    const pathSha256 = sha256(requested);
    const check = this.guard(requested);
    if (!check.ok) {
      this.recordOperation("read", pathSha256, "path_denied");
      this.replyBridge(id, { ok: false, error: "path_denied" });
      return;
    }
    try {
      const stats = await fsp.stat(check.absolutePath);
      if (!stats.isFile()) throw new Error("not a regular file");
      if (stats.size > MAX_READ_BYTES) {
        this.recordOperation("read", pathSha256, "too_large");
        this.replyBridge(id, { ok: false, error: "too_large" });
        return;
      }
      const buffer = await fsp.readFile(check.absolutePath);
      if (buffer.length > MAX_READ_BYTES) {
        this.recordOperation("read", pathSha256, "too_large");
        this.replyBridge(id, { ok: false, error: "too_large" });
        return;
      }
      this.recordOperation("read", pathSha256, "ok");
      this.replyBridge(id, { ok: true, content: buffer.toString("utf8") });
    } catch {
      this.recordOperation("read", pathSha256, "read_failed");
      this.replyBridge(id, { ok: false, error: "read_failed" });
    }
  }

  private recordOperation(op: string, pathSha256: string, outcome: BridgeOperationOutcome): void {
    try {
      this.options.onBridgeOperation?.({ runId: this.runId, op, pathSha256, outcome });
    } catch {
      // A failing observer must not change the operation's answer.
    }
  }

  private replyBridge(id: string | number, reply: Json): void {
    const socket = this.bridgeSocket;
    if (socket === undefined || socket.destroyed || this.finished) return;
    socket.write(`${JSON.stringify({ id, ...reply })}\n`);
  }

  private onStdoutLine(line: string): void {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.ignoredEvents++;
      return;
    }
    const message = asRecord(parsed);
    if (message === undefined) {
      this.ignoredEvents++;
      return;
    }
    switch (message.type) {
      case "response":
        this.onResponse(message);
        return;
      case "extension_ui_request":
        if (typeof message.id === "string" || typeof message.id === "number") {
          this.writeLine({ type: "extension_ui_response", id: message.id, cancelled: true });
        }
        return;
      case "agent_settled":
        this.onSettled(message.aborted === true);
        return;
      case "message_update": {
        const event = asRecord(message.assistantMessageEvent);
        if (event?.type === "text_delta" && typeof event.delta === "string") {
          this.streamedText += event.delta;
        }
        return;
      }
      case "message_end": {
        const assistant = asRecord(message.message);
        if (assistant?.role === "assistant") {
          // A failed model call ends the assistant message with stopReason "error" and its message (UNVERIFIED
          // against Pi 1.2.0: the field names follow the assistant message shape of the Pi SDK).
          if (assistant.stopReason === "error" && typeof assistant.errorMessage === "string") {
            this.providerError = assistant.errorMessage;
          }
          const text = assistantText(assistant.content);
          if (text !== undefined) this.finalText = text;
        }
        return;
      }
      case "agent_start":
      case "turn_end":
        return;
      default:
        this.ignoredEvents++;
    }
  }

  private onResponse(message: Json): void {
    const id = typeof message.id === "string" ? message.id : undefined;
    let entry = id === undefined ? undefined : this.pending.get(id);
    if (entry === undefined) {
      for (const [key, candidate] of this.pending) {
        if (candidate.command === message.command) {
          entry = candidate;
          this.pending.delete(key);
          break;
        }
      }
    } else if (id !== undefined) {
      this.pending.delete(id);
    }
    if (entry === undefined) {
      this.ignoredEvents++;
      return;
    }
    entry.resolve(message);
  }

  private request(command: string, payload: Json): Promise<Json | undefined> {
    const id = `r${++this.seq}`;
    const reply = deferred<Json | undefined>();
    if (this.finished || !this.writeLine({ type: command, id, ...payload })) {
      reply.resolve(undefined);
      return reply.promise;
    }
    this.pending.set(id, { command, resolve: reply.resolve });
    return reply.promise;
  }

  private writeLine(message: Json): boolean {
    const stdin = this.child?.stdin;
    if (!this.stdinOpen || stdin === undefined || stdin === null || stdin.destroyed) return false;
    stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  private onSettled(aborted: boolean): void {
    if (this.finished) return;
    this.settledSeen = true;
    let outcome: AgentOutcome;
    if (this.stopRequest === "timeout") {
      outcome = { status: "timed_out" };
    } else if (this.stopRequest === "abort") {
      outcome = { status: "aborted" };
    } else if (aborted) {
      outcome = { status: "failed", code: "pi_aborted", message: "Pi settled with aborted=true" };
    } else if (this.providerError !== undefined) {
      // The model call failed (for example a Broker refusal): the attempt fails with that cause, not a summary.
      outcome = {
        status: "failed",
        code: this.providerError.includes("insufficient_quota")
          ? "insufficient_quota"
          : "provider_error",
        message: this.providerError,
      };
    } else {
      outcome = { status: "succeeded", summary: this.finalText ?? this.streamedText };
    }
    this.finish(outcome);
    this.beginGracefulShutdown();
  }

  private stop(reason: "abort" | "timeout"): void {
    if (this.childClosed) return;
    if (!this.finished && this.stopRequest === undefined) {
      this.stopRequest = reason;
      clearTimeout(this.deadlineTimer);
      this.writeLine({ type: "abort" });
    }
    this.beginGracefulShutdown();
  }

  // EOF on stdin, then a tree kill after the grace period (ADR-0004 decision 8).
  private beginGracefulShutdown(): void {
    if (this.stdinOpen) {
      this.stdinOpen = false;
      this.child?.stdin?.end();
    }
    if (this.graceTimer === undefined && !this.childClosed) {
      this.graceTimer = setTimeout(() => this.killNow(), this.graceMs);
    }
  }

  private killNow(): void {
    if (this.childClosed || this.child === undefined) return;
    this.killedByUs = true;
    killProcessTree(this.child, this.osEnv);
  }

  private fail(code: string, message: string): void {
    if (this.finished) return;
    this.failure = { code, message };
    this.finish({ status: "failed", code, message });
    this.killNow();
  }

  private finish(outcome: AgentOutcome): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.helloTimer);
    clearTimeout(this.startupTimer);
    clearTimeout(this.deadlineTimer);
    clearTimeout(this.bridgeLostTimer);
    const error = this.closedError();
    this.helloD.reject(error);
    this.readyD.reject(error);
    this.settledD.resolve(outcome);
    this.flushPending();
  }

  private flushPending(): void {
    for (const entry of this.pending.values()) entry.resolve(undefined);
    this.pending.clear();
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.childClosed) return;
    this.childClosed = true;
    this.clearTimers();
    if (!this.finished) {
      if (this.stopRequest === "abort") {
        this.finish({ status: "aborted" });
      } else if (this.stopRequest === "timeout") {
        this.finish({ status: "timed_out" });
      } else {
        this.finish({
          status: "failed",
          code: "pi_exited",
          message: `Pi exited before agent_settled (code ${code ?? "none"}, signal ${signal ?? "none"})`,
        });
      }
    } else if (this.settledSeen && code !== null && code !== 0 && !this.killedByUs) {
      this.warnings.push(
        `Pi exited with code ${code} after agent_settled (#9507); the run is accepted`,
      );
    }
    this.flushPending();
    this.server?.close();
    this.bridgeSocket?.destroy();
    if (this.stderrLog === undefined) {
      this.exitedD.resolve();
      return;
    }
    this.stderrLog.end(() => this.exitedD.resolve());
  }

  private clearTimers(): void {
    clearTimeout(this.helloTimer);
    clearTimeout(this.startupTimer);
    clearTimeout(this.deadlineTimer);
    clearTimeout(this.graceTimer);
    clearTimeout(this.bridgeLostTimer);
  }
}
