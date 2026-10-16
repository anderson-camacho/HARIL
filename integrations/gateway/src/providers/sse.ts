import { ProviderError } from "./errors.js";

// Server-Sent Events framing: lines end in LF, CRLF or CR; a blank line dispatches an event; lines that
// start with ":" are comments. Input may be cut anywhere, so the parser keeps the unfinished line.

export interface SseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

export interface SseParser {
  push(text: string): SseEvent[];
  end(): SseEvent[];
}

// One SSE line above this size is a broken or hostile upstream, not a long event (M2 measure, Q-MP2).
const MAX_LINE_LENGTH = 1024 * 1024;

export function createSseParser(): SseParser {
  let pending = "";
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let hasData = false;

  function dispatchAt(out: SseEvent[]): void {
    if (hasData) out.push({ event: eventName, data: dataLines.join("\n") });
    dataLines = [];
    eventName = undefined;
    hasData = false;
  }

  function consumeLine(line: string, out: SseEvent[]): void {
    if (line === "") {
      dispatchAt(out);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      dataLines.push(value);
      hasData = true;
    } else if (field === "event") {
      eventName = value;
    }
  }

  function drain(final: boolean, out: SseEvent[]): void {
    let start = 0;
    for (let index = 0; index < pending.length; index++) {
      const char = pending[index];
      if (char !== "\n" && char !== "\r") continue;
      // A CR at the very end may be the first half of a CRLF that the next push completes.
      if (char === "\r" && index + 1 === pending.length && !final) break;
      consumeLine(pending.slice(start, index), out);
      if (char === "\r" && pending[index + 1] === "\n") index++;
      start = index + 1;
    }
    pending = pending.slice(start);
    if (pending.length > MAX_LINE_LENGTH) {
      throw new ProviderError("upstream_stream_error", "stream line exceeds the adapter limit");
    }
    if (final) {
      if (pending.length > 0) consumeLine(pending, out);
      pending = "";
      dispatchAt(out);
    }
  }

  return {
    push(text) {
      const out: SseEvent[] = [];
      pending += text;
      drain(false, out);
      return out;
    },
    end() {
      const out: SseEvent[] = [];
      drain(true, out);
      return out;
    },
  };
}
