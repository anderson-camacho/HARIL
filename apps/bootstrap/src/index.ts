// Public surface of @haril/bootstrap: the installer that builds haril-bootstrap.mjs (M2-T3).
// The bootstrap imports node:* builtins only (ADR-0012, INV-13); no @haril/* package and no npm dependency.

export { type CliHost, type CliIo, runCli } from "./cli.js";
export {
  MANIFEST_SCHEMA_VERSION,
  NODE_DIST_BASE,
  NODE_VERSION,
  PI_PACKAGE,
  PI_VERSION,
} from "./constants.js";
export { ARCHIVE_TIMEOUT_MS, getOfficial, SHASUMS_TIMEOUT_MS } from "./download.js";
export { isolatedEnv } from "./env.js";
export { type InstallResult, installRuntime } from "./install.js";
export { type Manifest, parseManifest, serializeManifest } from "./manifest.js";
export { npmInstallArgv } from "./pi-step.js";
export { type NodeArchive, nodeArchive } from "./platform.js";
export type {
  ExecOptions,
  ExecPort,
  ExecResult,
  FetchPort,
  FsPort,
  InstallDeps,
  StepReport,
} from "./ports.js";
export { realExec, realFetch, realFs } from "./real.js";
export { type RootInput, type RootResolution, resolveRuntimeRoot } from "./root.js";
export { parseShasums, sha256Hex } from "./shasums.js";
