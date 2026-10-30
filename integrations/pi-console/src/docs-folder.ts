import { type Dirent, promises as fs } from "node:fs";
import { join } from "node:path";
import { plainText, textWidth } from "./text.js";

// The documentation folder the DOCS tab reads: a folder the user manages outside HARIL (for example an Obsidian vault)
// and HARIL connects to by its path (`docs.path` in haril.json). This module only READS it: it counts the Markdown
// notes and finds the latest ones. The walk is bounded (files and depth), skips the folders an editor keeps for itself
// (any folder or file that starts with a dot, such as `.obsidian`, `.git` and `.trash`, plus node_modules and the
// Windows system folders of a drive root) and never follows a link, so it cannot leave the tree or loop.

interface DocsNote {
  // The path from the folder, with forward slashes whatever the platform.
  readonly rel: string;
  readonly mtimeMs: number;
  // The first `# ` heading of the note, else its file name without the extension. Only for the latest notes.
  readonly title?: string;
}

export interface DocsScan {
  readonly exists: boolean;
  readonly isDirectory: boolean;
  // The notes found; a lower bound when `truncated`.
  readonly noteCount: number;
  // True when a cap (files or depth) stopped the walk, so the count may be higher.
  readonly truncated: boolean;
  // The most recently modified notes, newest first.
  readonly latest: readonly DocsNote[];
}

export interface DocsScanOptions {
  // How many latest notes to return.
  readonly limit?: number;
  // How many notes to count before stopping.
  readonly maxFiles?: number;
  // How many levels of folders below the root to enter.
  readonly maxDepth?: number;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_DEPTH = 6;
// A title is looked for in the start of the note only.
const TITLE_BYTES = 4096;
const TITLE_MAX = 80;
const SKIPPED_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "$recycle.bin",
  "system volume information",
]);
const NOTE_EXTENSION = /\.md$/i;
const HEADING = /^# +(.+?)\s*$/m;

function isSkipped(name: string): boolean {
  return name.startsWith(".") || SKIPPED_NAMES.has(name.toLowerCase());
}

const empty = (exists: boolean, isDirectory: boolean): DocsScan => ({
  exists,
  isDirectory,
  noteCount: 0,
  truncated: false,
  latest: [],
});

// The note's text without a leading YAML front matter (Obsidian properties), whose comments start with `#` too.
function withoutFrontMatter(text: string): string {
  const body = text.replace(/^﻿/, "");
  if (!/^---[ \t]*\r?\n/.test(body)) return body;
  const closing = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(body.slice(3));
  return closing === null ? body : body.slice(3 + closing.index + closing[0].length);
}

function fileTitle(rel: string): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return name.replace(NOTE_EXTENSION, "");
}

async function titleOf(root: string, rel: string): Promise<string> {
  const fallback = fileTitle(rel);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(join(root, ...rel.split("/")), "r");
    const buffer = Buffer.alloc(TITLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TITLE_BYTES, 0);
    const heading = HEADING.exec(
      withoutFrontMatter(buffer.subarray(0, bytesRead).toString("utf8")),
    );
    const title = plainText(heading?.[1] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return title === "" ? fallback : Array.from(title).slice(0, TITLE_MAX).join("");
  } catch {
    return fallback;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// Reads the folder at `root`. Never throws: a path that is missing, is a file or cannot be read says so in the result,
// and an entry that cannot be read is left out.
export async function scanDocsFolder(
  root: string,
  options: DocsScanOptions = {},
): Promise<DocsScan> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  try {
    const info = await fs.stat(root);
    if (!info.isDirectory()) return empty(true, false);
  } catch {
    return empty(false, false);
  }

  const notes: { rel: string; mtimeMs: number }[] = [];
  let truncated = false;
  // Breadth first: when a cap stops the walk, what is left out is the deepest, not a whole branch.
  let level: { abs: string; rel: string }[] = [{ abs: root, rel: "" }];
  for (let depth = 0; level.length > 0 && !truncated; depth++) {
    const next: { abs: string; rel: string }[] = [];
    for (const folder of level) {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(folder.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const files: { abs: string; rel: string }[] = [];
      for (const entry of entries) {
        if (isSkipped(entry.name) || entry.isSymbolicLink()) continue;
        const abs = join(folder.abs, entry.name);
        const rel = folder.rel === "" ? entry.name : `${folder.rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (depth >= maxDepth) {
            truncated = true;
            continue;
          }
          // A junction is a directory to some readers and a link to others: ask the file system itself.
          const link = await fs.lstat(abs).catch(() => undefined);
          if (link !== undefined && !link.isSymbolicLink()) next.push({ abs, rel });
        } else if (entry.isFile() && NOTE_EXTENSION.test(entry.name)) {
          files.push({ abs, rel });
        }
      }
      const stats = await Promise.all(
        files.map((file) => fs.stat(file.abs).catch(() => undefined)),
      );
      for (const [index, stat] of stats.entries()) {
        const file = files[index];
        if (file === undefined || stat === undefined || !stat.isFile()) continue;
        if (notes.length >= maxFiles) {
          truncated = true;
          break;
        }
        notes.push({ rel: file.rel, mtimeMs: stat.mtimeMs });
      }
      if (truncated && notes.length >= maxFiles) break;
    }
    level = next;
  }

  notes.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const latest = await Promise.all(
    notes.slice(0, Math.max(0, limit)).map(async (note) => ({
      rel: note.rel,
      mtimeMs: note.mtimeMs,
      title: await titleOf(root, note.rel),
    })),
  );
  return { exists: true, isDirectory: true, noteCount: notes.length, truncated, latest };
}

// The end of a text that is too wide for `width` columns, with an ellipsis in front: for a path, the folder or file
// name is what the user needs to see, so it is the start that gives way.
export function tailFit(text: string, width: number): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  let tail = "";
  let used = 1;
  for (const char of Array.from(text).reverse()) {
    const next = textWidth(char);
    if (used + next > width) break;
    tail = `${char}${tail}`;
    used += next;
  }
  return `…${tail}`;
}
