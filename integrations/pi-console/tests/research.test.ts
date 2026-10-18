import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESEARCH_DIR, RESEARCH_MAX_BYTES, researchSlug, saveResearch } from "../src/research.js";

// haril_save_research (7.3 point 8, P18): the one write CONSULT and PLAN allow. The model gives a title and Markdown
// content and never a path: the file goes to <project>/docs/investigacion/<date>-<slug>.md, always .md, never over an
// existing file, at most 200 KB; a title with a path, "..", a drive or a control character is refused.

const DAY = new Date(2026, 9, 18, 9, 30);
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-research-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function files(): string[] {
  const dir = join(root, RESEARCH_DIR);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("haril_save_research", () => {
  it("writes a dated Markdown file inside the research folder", () => {
    const saved = saveResearch(
      root,
      { title: "How the runtime claims tasks", content: "# Claims\n\nText." },
      DAY,
    );
    expect(saved.relative).toBe(
      ["docs", "investigacion", "2026-10-18-how-the-runtime-claims-tasks.md"].join(sep),
    );
    expect(readFileSync(saved.path, "utf8")).toBe("# Claims\n\nText.");
    expect(files()).toEqual(["2026-10-18-how-the-runtime-claims-tasks.md"]);
  });

  it("never overwrites: a second save with the same title gets a suffix", () => {
    const first = saveResearch(root, { title: "Notes", content: "one" }, DAY);
    const second = saveResearch(root, { title: "Notes", content: "two" }, DAY);
    expect(second.path).not.toBe(first.path);
    expect(readFileSync(first.path, "utf8")).toBe("one");
    expect(readFileSync(second.path, "utf8")).toBe("two");
    expect(files()).toEqual(["2026-10-18-notes-2.md", "2026-10-18-notes.md"]);
  });

  it("keeps a file someone else put there", () => {
    mkdirSync(join(root, RESEARCH_DIR), { recursive: true });
    writeFileSync(join(root, RESEARCH_DIR, "2026-10-18-notes.md"), "mine");
    saveResearch(root, { title: "Notes", content: "new" }, DAY);
    expect(readFileSync(join(root, RESEARCH_DIR, "2026-10-18-notes.md"), "utf8")).toBe("mine");
  });

  it("refuses traversal, absolute paths, drives and control characters in the title", () => {
    for (const title of [
      "../escape",
      "..\\escape",
      "a/b",
      "a\\b",
      "/etc/passwd",
      "C:\\Windows\\x",
      "C:notes",
      "..",
      "line\nbreak",
      "tab\there",
      "nul\u0000",
      "",
      "   ",
    ]) {
      expect(() => saveResearch(root, { title, content: "x" }, DAY), JSON.stringify(title)).toThrow(
        /title/,
      );
    }
    expect(files()).toEqual([]);
  });

  it("writes only .md: an extension in the title stays part of the name", () => {
    const saved = saveResearch(root, { title: "payload.sh", content: "x" }, DAY);
    expect(saved.path.endsWith("2026-10-18-payload-sh.md")).toBe(true);
  });

  it("refuses content that is not text, empty, or over 200 KB", () => {
    expect(() => saveResearch(root, { title: "t", content: 42 }, DAY)).toThrow(/content/);
    expect(() => saveResearch(root, { title: "t", content: "" }, DAY)).toThrow(/content/);
    expect(() =>
      saveResearch(root, { title: "t", content: "x".repeat(RESEARCH_MAX_BYTES + 1) }, DAY),
    ).toThrow(/200 KB/);
    expect(() => saveResearch(root, { title: "t", content: "a\u0000b" }, DAY)).toThrow(/content/);
    expect(files()).toEqual([]);
  });

  it("refuses a research folder that leads outside the project", () => {
    const outside = mkdtempSync(join(tmpdir(), "haril-outside-"));
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      // A junction (Windows) or a symlink pointing elsewhere: the write must not follow it out.
      symlinkSync(
        outside,
        join(root, RESEARCH_DIR),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() => saveResearch(root, { title: "t", content: "x" }, DAY)).toThrow(/outside/);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("slugs titles to plain ASCII words", () => {
    expect(researchSlug("Diseño de la delegación: capas")).toBe("diseno-de-la-delegacion-capas");
    expect(researchSlug("¿¿??")).toBe("research");
    expect(researchSlug("a".repeat(200)).length).toBeLessThanOrEqual(60);
  });
});
