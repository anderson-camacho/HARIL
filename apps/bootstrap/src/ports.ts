// Injectable ports. The real adapters live in real.ts; tests pass fakes, so no unit test touches the disk or network.

export interface FsPort {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  // Creates the parent directories when needed.
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdirp(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  // Recursive and silent when the path is missing.
  remove(path: string): Promise<void>;
}

export interface ExecOptions {
  // The complete environment of the child process: nothing is inherited implicitly.
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecPort {
  run(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult>;
}

export interface FetchPort {
  get(url: string, timeoutMs: number): Promise<Uint8Array>;
}

export interface InstallDeps {
  readonly root: string;
  readonly platform: string;
  readonly arch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: FsPort;
  readonly exec: ExecPort;
  readonly fetch: FetchPort;
  readonly now: () => string;
}

export interface StepReport {
  readonly name: "node" | "pi" | "manifest";
  readonly status: "ok" | "skipped" | "failed";
  readonly detail: string;
}
