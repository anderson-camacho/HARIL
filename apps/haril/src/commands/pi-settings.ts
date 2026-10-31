import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Pi's documented `quietStartup` setting, in HARIL's private agent directory: "header" drops the [Context] and
// [Extensions] listing from the chat and keeps the header slot the console replaces (`true` would remove that slot).
// Pi still prints load diagnostics when quiet. A choice already in the file stands; a file that does not parse is left
// for Pi to report.
export function ensureQuietStartup(agentDir: string): void {
  const path = join(agentDir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSafely(path) ?? "null");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    settings = parsed as Record<string, unknown>;
    if ("quietStartup" in settings) return;
  }
  const temporary = `${path}.haril-tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...settings, quietStartup: "header" }, null, 2)}\n`);
  renameSync(temporary, path);
}

function readFileSafely(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8");
    JSON.parse(text);
    return text;
  } catch {
    return undefined;
  }
}
