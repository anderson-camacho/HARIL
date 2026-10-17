// Public surface of @haril/memory-engram (M4, BL-121): the MemoryProvider adapter over the HTTP API of Engram.
// The guards and the supervision of `engram serve` come next; wiring it into the Runtime, and the pinned binary,
// are MC-T6.

export {
  ENGRAM_CALL_DEADLINE_MS,
  ENGRAM_REQUEST_TIMEOUT_MS,
  type EngramConnect,
  EngramMemoryProvider,
  type EngramMemoryProviderOptions,
} from "./engram-provider.js";
export type { EngramEndpoint } from "./http.js";
export { ENGRAM_DEFAULT_PORT, portProblem, RESERVED_PORTS } from "./loopback.js";
