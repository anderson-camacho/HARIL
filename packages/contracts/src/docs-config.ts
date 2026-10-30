// The `docs` section of haril.json: where the user keeps their documentation. It is a folder managed outside HARIL (for
// example an Obsidian vault); HARIL stores the path and only reads the folder, it never writes into it. The section has
// one key, `path`. This module checks the shape of the text only (an absolute path, no control characters): whether the
// folder exists is looked at when the path is set and when the DOCS tab shows it, never when the configuration is
// loaded, so a vault on a drive that is not connected cannot make haril.json unreadable. Pure: no I/O.

export const DOCS_KEYS: readonly string[] = Object.freeze(["path"]);

// A Windows drive (`D:\` or `D:/`), a UNC share (`\\server\share`, `//server/share`) or a POSIX root (`/home/ana`). A
// drive without a separator (`D:vault`) is relative to the drive's current directory, so it is not absolute.
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/;
// Control characters: a NUL ends a path in the file system calls, and the others have no place in a folder name.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is what the check looks for
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function isAbsoluteDocsPath(text: string): boolean {
  return ABSOLUTE_PATH.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every problem of the `docs` section, each with its JSON path; empty when the section is usable. An empty section is
// the same as no folder.
export function docsSectionErrors(section: unknown): string[] {
  if (!isRecord(section)) return ["/docs: must be an object"];
  const errors: string[] = [];
  for (const key of Object.keys(section)) {
    if (!DOCS_KEYS.includes(key)) errors.push(`/docs/${key}: unknown key`);
  }
  if (!("path" in section)) return errors;
  const path = section.path;
  if (typeof path !== "string" || path.trim() === "" || CONTROL_CHARACTER.test(path)) {
    errors.push(
      "/docs/path: must be a non-empty text without control characters, an absolute path",
    );
  } else if (path !== path.trim()) {
    errors.push("/docs/path: must not start or end with a blank");
  } else if (!isAbsoluteDocsPath(path)) {
    errors.push("/docs/path: must be an absolute path (for example D:\\Vault or /home/ana/vault)");
  }
  return errors;
}
