// Public surface of @haril/agent-pi: the AgentRuntime adapter for Pi 1.2.0 (ADR-0004), M2.

export type { SpawnFn } from "./launch.js";
export { createPathGuard, type PathGuard, type PathGuardResult } from "./path-guard.js";
export {
  type BridgeOperationEvent,
  type BridgeOperationOutcome,
  createPiAgentRuntime,
  type PiAgentHandle,
  type PiAgentRuntimeOptions,
  type PiDiagnostics,
  type PiTimings,
} from "./pi-agent-runtime.js";
