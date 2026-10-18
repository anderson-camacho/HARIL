import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

// haril_save_research (docs/modos-y-delegacion.md 7.3 point 8, P18): the one write CONSULT and PLAN allow, asked for
// by the user. The model gives a title and Markdown content, never a path: the console writes
// <project root>/docs/investigacion/<YYYY-MM-DD>-<slug>.md. Only .md; never over an existing file (the name takes a
// suffix, and the write itself refuses an existing file); at most 200 KB; a title with a path separator, "..", a drive,
// an absolute path or a control character is refused, not cleaned; and a research folder that resolves outside the
// project (a symlink or junction) is refused. It cannot edit or delete anything.

export const RESEARCH_DIR = join("docs", "investigacion");
export const RESEARCH_MAX_BYTES = 200 * 1024;
const TITLE_MAX = 200;
const SLUG_MAX = 60;
const SUFFIX_MAX = 99;
const FALLBACK_SLUG = "research";

export interface SavedResearch {
  // The absolute path written.
  readonly path: string;
  // The path from the project root, as the trace and the reply show it.
  readonly relative: string;
  readonly bytes: number;
}

function titleProblem(title: unknown): string | undefined {
  if (typeof title !== "string" || title.trim() === "") return "a research file needs a title";
  if (title.length > TITLE_MAX) return `the title holds at most ${TITLE_MAX} characters`;
  for (const char of title) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return "the title cannot hold control characters";
    }
  }
  if (/[\\/]/.test(title)) return "the title is a name, not a path: no / or \\";
  if (title.includes("..")) return 'the title cannot hold ".."';
  if (/^[A-Za-z]:/.test(title)) return "the title cannot name a drive";
  return undefined;
}

// Plain ASCII words joined by hyphens: accents dropped, everything else a separator.
export function researchSlug(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug === "" ? FALLBACK_SLUG : slug;
}

function localDay(now: Date): string {
  return [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function inside(root: string, path: string): boolean {
  const fold = (text: string): string => (process.platform === "win32" ? text.toLowerCase() : text);
  const from = fold(root);
  const to = fold(path);
  return to === from || to.startsWith(from.endsWith(sep) ? from : `${from}${sep}`);
}

// Writes the research file and returns where. Throws an Error that says why it refused, which becomes the tool's
// failed result.
export function saveResearch(
  root: string,
  input: { readonly title: unknown; readonly content: unknown },
  now: Date = new Date(),
): SavedResearch {
  const problem = titleProblem(input.title);
  if (problem !== undefined) throw new Error(`refused: ${problem}`);
  const content = input.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("refused: the content must be non-empty Markdown text");
  }
  if (content.includes("\u0000"))
    throw new Error("refused: the content must be text (no NUL bytes)");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > RESEARCH_MAX_BYTES) {
    throw new Error(`refused: the content is ${bytes} bytes; a research file holds at most 200 KB`);
  }
  const dir = join(root, RESEARCH_DIR);
  mkdirSync(dir, { recursive: true });
  const realRoot = realpathSync(root);
  const realDir = realpathSync(dir);
  if (!inside(realRoot, realDir)) {
    throw new Error(`refused: the research folder ${RESEARCH_DIR} resolves outside the project`);
  }
  const base = `${localDay(now)}-${researchSlug(input.title as string)}`;
  for (let attempt = 1; attempt <= SUFFIX_MAX; attempt++) {
    const name = `${base}${attempt === 1 ? "" : `-${attempt}`}.md`;
    const path = join(realDir, name);
    try {
      // wx: the write fails when the file exists, so nothing is ever overwritten, even in a race.
      writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
      return { path, relative: join(RESEARCH_DIR, name), bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`refused: ${SUFFIX_MAX} research files already use the name ${base}`);
}
