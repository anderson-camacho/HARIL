import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// haril.json as `haril config` reads and writes it (phase F7). A write keeps the file as close to how it was as JSON
// allows: every key and its order, the indentation (spaces or tabs, or none for a one-line file) and the line endings.
// The new content goes to a temporary file beside it, which is renamed over it, so a reader (the runtime reads the file
// at every attempt) never sees half a file; a failed write leaves the old file as it was.

export type ConfigRead =
  | {
      readonly ok: true;
      readonly exists: boolean;
      readonly text: string;
      readonly document: Record<string, unknown>;
    }
  | { readonly ok: false; readonly error: string };

export function readConfigDocument(path: string): ConfigRead {
  if (!existsSync(path)) return { ok: true, exists: false, text: "", document: {} };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, error: "the file cannot be read" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "the file is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "/: must be a JSON object" };
  }
  return { ok: true, exists: true, text, document: parsed as Record<string, unknown> };
}

interface TextFormat {
  readonly indent: string | number;
  readonly eol: "\n" | "\r\n";
  readonly finalNewline: boolean;
}

// The format of the existing text: a one-line file stays on one line; otherwise the indentation of its first indented
// line (two spaces when none is found). A new file is written with two spaces and a final newline.
function formatOf(text: string | undefined): TextFormat {
  if (text === undefined || text.trim() === "") return { indent: 2, eol: "\n", finalNewline: true };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = /\r?\n$/.test(text);
  const body = text.trimEnd();
  if (!body.includes("\n")) return { indent: 0, eol, finalNewline };
  const indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? 2;
  return { indent, eol, finalNewline };
}

export function serializeConfig(document: unknown, previous: string | undefined): string {
  const format = formatOf(previous);
  const json = JSON.stringify(document, null, format.indent === 0 ? undefined : format.indent);
  const lines = format.eol === "\n" ? json : json.replace(/\n/g, "\r\n");
  return format.finalNewline ? `${lines}${format.eol}` : lines;
}

export function writeConfigAtomically(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temporary = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
