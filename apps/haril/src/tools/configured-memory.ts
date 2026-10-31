import { existsSync, readFileSync } from "node:fs";
import type { HostInfo } from "../context.js";
import { memorySectionErrors } from "../memory-config.js";
import { harilConfigPath } from "../providers.js";
import type { MemoryConfigView } from "./types.js";

// What haril.json says about the memory provider, for the report of `haril tools status`: the console shows it next to
// what the runtime recorded, since the runtime only records a provider once it has run. This reads and never throws;
// a file that is missing, unreadable, not an object, or whose memory section is invalid says no provider (null),
// because nothing in it can be trusted to be what the runtime would use. The problem itself is reported where it
// always was (haril doctor, and the note `haril tools status` puts on Engram).
export function readMemoryConfig(host: HostInfo): MemoryConfigView {
  try {
    const { path } = harilConfigPath(host);
    if (!existsSync(path)) return { provider: null };
    const document: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      return { provider: null };
    }
    const section = (document as Record<string, unknown>).memory;
    if (section === undefined || memorySectionErrors(section).length > 0) {
      return { provider: null };
    }
    // A section without errors names its provider (memorySectionErrors) and, optionally, an absolute binary.
    const { provider, binary } = section as { provider: "null" | "engram"; binary?: string };
    return { provider, ...(binary === undefined ? {} : { binary }) };
  } catch {
    return { provider: null };
  }
}
