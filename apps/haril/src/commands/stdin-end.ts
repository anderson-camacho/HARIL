import type { HostInfo } from "../context.js";

// --exit-on-stdin-end (haril workflow watch and tail): the console runs these commands as children with a stdin pipe it
// never writes, so when the console goes away (even killed, with no chance to end its children) the pipe closes and the
// command ends instead of running on as an orphan. A person who runs the command in a terminal does not pass the flag.

export const EXIT_ON_STDIN_END = "--exit-on-stdin-end";

// Calls `listener` once when the process's stdin ends or closes; the returned function stops listening.
function processStdinEnd(listener: () => void): () => void {
  const stdin = process.stdin;
  let called = false;
  const once = (): void => {
    if (called) return;
    called = true;
    listener();
  };
  stdin.on("end", once);
  stdin.on("close", once);
  stdin.on("error", once);
  // Flowing mode, so the end is seen; nothing written to it is used.
  stdin.on("data", () => undefined);
  stdin.resume();
  return () => {
    stdin.off("end", once);
    stdin.off("close", once);
    stdin.off("error", once);
    stdin.pause();
  };
}

export function onStdinEnd(host: HostInfo, listener: () => void): () => void {
  return (host.onStdinEnd ?? processStdinEnd)(listener);
}
