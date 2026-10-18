// Process control (docs/modos-y-delegacion.md 3.14): what the runtime and the CLI need from the operating system to make
// sure no agent process outlives an emergency stop or a dead runtime. Implemented by @haril/os. Nothing here kills by
// process name: a caller names a pid it recorded with its start time (supervisor's matchProcess), and walks a tree itself
// from one snapshot of the processes (supervisor's planTreeKills) instead of trusting the OS's tree kill.

// Linux: when a process started, in clock ticks since the boot (/proc/<pid>/stat field 22), with the id of that boot
// (/proc/sys/kernel/random/boot_id). No wall-clock step changes it, so two readings of one process always agree, while
// a wall-clock start rebuilt as "now minus age" moves with every NTP or WSL2 clock step.
export interface BootStart {
  readonly bootId: string;
  readonly ticks: number;
}

// One running process as one snapshot of the OS shows it: its pid, the pid it names as its parent and its start time
// (milliseconds since the epoch), with its boot ticks on Linux.
export interface ProcessEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly startedAt: number;
  readonly boot?: BootStart;
}

export interface ProcessControl {
  // The start time (milliseconds since the epoch, as the OS reports it) of each pid that is running. A pid missing
  // from the map is not running, or its start time cannot be read; either way it must not be killed. A pid mapped to
  // null could not be checked (its part of the OS query failed): nothing may be concluded about it. undefined when the
  // OS could not be read at all: then nothing may be concluded, neither that a process runs nor that it is gone.
  startTimes(pids: readonly number[]): Promise<ReadonlyMap<number, number | null> | undefined>;
  // Linux only: the boot ticks of each running pid, read without starting a process; undefined elsewhere or when the
  // boot id cannot be read.
  bootStarts?(pids: readonly number[]): ReadonlyMap<number, BootStart> | undefined;
  // One snapshot of every running process with its parent pid and start time, in one OS query; undefined when the OS
  // could not be read.
  processTable(): Promise<readonly ProcessEntry[] | undefined>;
  // Kills one process, never its children by itself: the caller kills a tree one pid at a time, right after the snapshot
  // that showed each one. `target.startedAt` (and `target.boot` on Linux) is its start in that snapshot; where the OS
  // gives it without starting another process (Linux), the kill first checks the pid still started then and leaves it
  // alone otherwise. With `group` (POSIX), the process group it leads goes with it. No shell, no command line, a
  // validated whole-number pid, never this process; a pid already gone is ignored. Never throws.
  killProcess(target: ProcessEntry, options?: { readonly group?: boolean }): void;
}
