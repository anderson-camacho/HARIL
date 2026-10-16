import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readOptionalFile } from "./theme.js";

// Writes ui.theme into haril.json (TUI-D14). Every other key is kept as it was. The new content goes to a temporary
// file beside the config and is renamed over it, so a reader never sees half a file. A file that is not valid JSON,
// or whose ui is not an object, is refused and left untouched.

export function saveThemeChoice(configPath: string, theme: string): void {
  const document = readDocument(configPath);
  const ui = document.ui;
  if (ui !== undefined && (typeof ui !== "object" || ui === null || Array.isArray(ui))) {
    throw new Error("haril.json: ui must be an object; theme not saved");
  }
  document.ui = { ...(ui ?? {}), theme };
  writeAtomically(configPath, `${JSON.stringify(document, null, 2)}\n`);
}

function readDocument(configPath: string): Record<string, unknown> {
  const text = readOptionalFile(configPath);
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("haril.json is not valid JSON; theme not saved");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("haril.json must hold a JSON object; theme not saved");
  }
  return parsed as Record<string, unknown>;
}

function writeAtomically(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
