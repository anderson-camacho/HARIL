// Public surface of @haril/state-sqlite: the SQLite adapter of the Store port (ADR-0009).
export { StoreError, type StoreErrorCode } from "./errors.js";
export { evaluateGates, MIN_SQLITE_VERSION, NODE_RANGE } from "./gates.js";
export { type InspectStoreOptions, inspectStore, type StoreInspection } from "./inspect.js";
export {
  type OpenMemoryStoreOptions,
  type OpenStoreOptions,
  openMemoryStore,
  openStore,
} from "./open.js";
