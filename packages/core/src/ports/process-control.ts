// Process control (docs/modos-y-delegacion.md 3.14): what the runtime and the CLI need from the operating system to make
// sure no agent process outlives an emergency stop or a dead runtime. Implemented by @haril/os. Nothing here kills by
// process name: a caller names a pid it recorded, and checks its start time first (supervisor's sameProcess).
export interface ProcessControl {
  // The start time (milliseconds since the epoch, as the OS reports it) of each pid that is running. A pid missing
  // from the map is not running, or its start time cannot be read; either way it must not be killed.
  startTimes(pids: readonly number[]): Promise<ReadonlyMap<number, number>>;
  // Kills the process and every process it started (its tree). Resolves once the kill finished; never rejects.
  killTree(pid: number): Promise<void>;
}
