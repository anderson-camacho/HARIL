// Public surface of @haril/memory-engram (M4, BL-121): the MemoryProvider adapter over the HTTP API of Engram, the
// guards that run before its serve is launched, and the supervision of `engram serve` as an external process.
// Wiring it into the Runtime, and the pinned binary, are MC-T6.

export {
  ENGRAM_CALL_DEADLINE_MS,
  ENGRAM_REQUEST_TIMEOUT_MS,
  type EngramConnect,
  EngramMemoryProvider,
  type EngramMemoryProviderOptions,
} from "./engram-provider.js";
export {
  checkEngramDataDir,
  checkEngramHome,
  checkEngramPort,
  type DataDirRefusal,
  type EngramDataDirCheck,
  type EngramDataDirInput,
  type EngramPortCheck,
  engramDataDirOf,
  engramHomeOf,
  type GuardFs,
  loopbackPortProbe,
  nodeGuardFs,
  type PortProbe,
  type PortRefusal,
  pickEngramPort,
} from "./guards.js";
export type { EngramEndpoint } from "./http.js";
export { ENGRAM_DEFAULT_PORT, portProblem, RESERVED_PORTS } from "./loopback.js";
export {
  buildEngramEnv,
  createEngramServe,
  type EngramBinary,
  type EngramServe,
  type EngramServeOptions,
  type EngramServeState,
  type EngramServeStatus,
  type EngramServeTimings,
  type EngramSpawnFn,
  type EngramSpawnOptions,
  type KillerSpawnFn,
  killProcessTree,
} from "./serve.js";
