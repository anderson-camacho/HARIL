// Process control (docs/modos-y-delegacion.md 3.14): what the runtime and the CLI need from the operating system to make
// sure no agent process outlives an emergency stop or a dead runtime. Implemented by @haril/os. Nothing here kills by
// process name: a caller names a pid it recorded with its start time (supervisor's sameProcess).

// A process recorded at its spawn: its pid and the time taken right after the spawn returned.
export interface ProcessRoot {
  readonly pid: number;
  readonly startedAt: number;
}

export interface TreeKillResult {
  // The roots found running as the recorded process: each was killed after every descendant under it.
  readonly roots: readonly number[];
  // How many processes were killed, the roots included.
  readonly killed: number;
}

export interface ProcessControl {
  // The start time (milliseconds since the epoch, as the OS reports it) of each pid that is running. A pid missing
  // from the map is not running, or its start time cannot be read; either way it must not be killed. undefined when the
  // OS could not be read at all: then nothing may be concluded, neither that a process runs nor that it is gone.
  startTimes(pids: readonly number[]): Promise<ReadonlyMap<number, number> | undefined>;
  // Kills each root's process tree, one pid at a time, children first (supervisor's planTreeKills). One snapshot of the
  // OS's processes gives every pid's parent and start time: a root is killed only while it still started at its recorded
  // time, and a descendant only when it started at or after its parent, so a process that merely names a reused pid as
  // its parent is left alone. Each kill follows the snapshot at once, uses no shell and names a validated pid. Resolves
  // with what it killed, or undefined when the OS could not be read (then nothing was killed); never rejects.
  killTrees(roots: readonly ProcessRoot[]): Promise<TreeKillResult | undefined>;
}
