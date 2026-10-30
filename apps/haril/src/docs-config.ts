import { existsSync, readFileSync, statSync } from "node:fs";
import { docsSectionErrors } from "@haril/contracts";
import type { HostInfo } from "./context.js";
import { harilConfigPath } from "./providers.js";

// The `docs` section of haril.json: the folder where the user keeps their documentation, managed outside HARIL (for
// example an Obsidian vault). HARIL stores the path and only reads the folder. The shape of the text is checked when
// the file is read (@haril/contracts, docs-config.ts); the folder itself is looked at only when the path is set and
// when `haril doctor` or the console's DOCS tab show it, so a vault on a drive that is not connected never makes
// haril.json unreadable.

// What is at the path now: a directory, a file where a folder was expected, or nothing reachable.
export type DocsFolderState = "directory" | "file" | "missing";

export function docsFolderState(path: string): DocsFolderState {
  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
}

// The path as the user typed it, ready to store: surrounding blanks off, and the quotes that "copy as path" adds on
// Windows. The separators are the user's own.
export function docsPathText(text: string): string {
  const word = text.trim();
  return word.length >= 2 && word.startsWith('"') && word.endsWith('"')
    ? word.slice(1, -1).trim()
    : word;
}

export type DocsLoad =
  | {
      readonly ok: true;
      readonly configPath: string;
      // The connected folder, or null when haril.json holds no docs.path.
      readonly path: string | null;
    }
  | { readonly ok: false; readonly configPath: string; readonly errors: string[] };

// The documentation folder of this run, read again at each call like the other sections. A problem with the file or
// the section is an error with each JSON path; a file without the section (every file written before it existed) is
// simply "not connected".
export function loadDocsPath(host: HostInfo): DocsLoad {
  const { path: configPath, explicit } = harilConfigPath(host);
  if (!existsSync(configPath)) {
    return explicit
      ? { ok: false, configPath, errors: ["the file named by HARIL_CONFIG does not exist"] }
      : { ok: true, configPath, path: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch {
    return { ok: false, configPath, errors: ["the file is not valid JSON"] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, configPath, errors: ["/: must be a JSON object"] };
  }
  const section = (parsed as Record<string, unknown>).docs;
  if (section === undefined) return { ok: true, configPath, path: null };
  const errors = docsSectionErrors(section);
  if (errors.length > 0) return { ok: false, configPath, errors };
  const path = (section as { path?: string }).path;
  return { ok: true, configPath, path: path ?? null };
}
