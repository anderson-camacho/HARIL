import { parseStrictJson } from "./strict-json.js";

// Layout of a block.md (ADR-0014 D4): a frontmatter document between "---" lines, then a Markdown body
// whose sections are delimited by <!-- haril:section:<id> --> ... <!-- /haril:section:<id> -->.
// Line endings may be LF or CRLF. A byte order mark is rejected.

export type BlockFileParse =
  | { readonly ok: true; readonly frontmatter: unknown; readonly body: string }
  | { readonly ok: false; readonly error: string };

export function parseBlockFile(text: string): BlockFileParse {
  if (text.startsWith("﻿")) return { ok: false, error: "a byte order mark is not allowed" };
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines[0] !== "---") return { ok: false, error: 'the first line must be "---"' };
  const close = lines.indexOf("---", 1);
  if (close < 0) return { ok: false, error: 'the frontmatter is not closed by a "---" line' };

  const frontmatterText = lines.slice(1, close).join("\n");
  if (frontmatterText.includes("\t")) {
    return { ok: false, error: "tab characters are not allowed in the frontmatter" };
  }
  const parsed = parseStrictJson(frontmatterText);
  if (!parsed.ok) return { ok: false, error: `frontmatter: ${parsed.error}` };
  return { ok: true, frontmatter: parsed.value, body: lines.slice(close + 1).join("\n") };
}

export type SectionMarkerCheck =
  | { readonly ok: true; readonly sectionIds: string[] }
  | { readonly ok: false; readonly errors: string[] };

const OPEN = /^<!-- haril:section:([a-z0-9-]+) -->$/;
const CLOSE = /^<!-- \/haril:section:([a-z0-9-]+) -->$/;

// Balanced, unique, non-nested section markers. Any line that mentions "haril:" must be a well-formed marker.
export function checkSectionMarkers(body: string): SectionMarkerCheck {
  const errors: string[] = [];
  const sectionIds: string[] = [];
  let open: string | undefined;

  body.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line.includes("haril:")) return;
    const where = `line ${index + 1}`;
    const opened = OPEN.exec(line);
    const closed = CLOSE.exec(line);
    if (opened !== null) {
      const id = opened[1] ?? "";
      if (open !== undefined) errors.push(`${where}: section "${id}" is nested inside "${open}"`);
      if (sectionIds.includes(id)) errors.push(`${where}: duplicate section "${id}"`);
      sectionIds.push(id);
      open = id;
    } else if (closed !== null) {
      const id = closed[1] ?? "";
      if (open === undefined)
        errors.push(`${where}: section "${id}" closed without an opening marker`);
      else if (id !== open) errors.push(`${where}: section "${open}" closed by "${id}"`);
      open = undefined;
    } else {
      errors.push(`${where}: malformed haril marker`);
    }
  });

  if (open !== undefined) errors.push(`section "${open}" is never closed`);
  return errors.length === 0 ? { ok: true, sectionIds } : { ok: false, errors };
}
