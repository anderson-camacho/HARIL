import { describe, expect, it } from "vitest";
import type { GitSummary } from "../src/git-summary.js";
import type { ConsoleTheme } from "../src/pi-types.js";
import { stripAnsi, textWidth } from "../src/text.js";
import { type BarFacts, renderBarLayout } from "../src/view.js";

// The folder line of the full bar. Without `powerline` it is the plain dim line it has always been; with it, the folder
// and the git branch are powerline segments, and the statuses other extensions set stay after them.

const TAGGED: ConsoleTheme = {
  fg: (tone, text) => `{${tone}:${text}}`,
  bold: (text) => `*${text}*`,
};
const IDENTITY: ConsoleTheme = { fg: (_tone, text) => text, bold: (text) => text };
const ESC = String.fromCharCode(0x1b);
const TRUECOLOR: ConsoleTheme = {
  fg: (tone, text) =>
    `${ESC}[38;2;${tone === "warning" ? "245;194;107" : "120;130;140"}m${text}${ESC}[39m`,
  bold: (text) => `${ESC}[1m${text}${ESC}[22m`,
};

const ARROW = String.fromCodePoint(0xe0b0);
const BRANCH = String.fromCodePoint(0xe0a0);
const FOLDER = String.fromCodePoint(0xf07b);
const SOME: GitSummary = { staged: 1, modified: 2, untracked: 3 };

function bar(overrides: Partial<BarFacts> = {}): BarFacts {
  return {
    place: "fake-project",
    model: "Gemini1/gemini-3-flash",
    level: "medium",
    contextPercent: 12,
    cost: 0,
    pending: 0,
    runtime: "idle",
    cwd: "fake-cwd",
    branch: "main",
    statuses: ["indexer ready"],
    mode: "ACTION",
    ...overrides,
  };
}

describe("the folder line without powerline", () => {
  it("is the dim line it has always been: the folder, the branch in parentheses and the statuses", () => {
    const layout = renderBarLayout(bar(), 140, TAGGED);
    expect(layout.lines[1]).toBe("{dim:fake-cwd}{dim: (main)}{dim:  indexer ready}");
  });

  it("leaves out the branch outside a repository and shortens at the width, as before", () => {
    expect(renderBarLayout(bar({ branch: null }), 140, TAGGED).lines[1]).toBe(
      "{dim:fake-cwd}{dim:  indexer ready}",
    );
    expect(renderBarLayout(bar(), 14, TAGGED).lines[1]).toBe("{dim:fake-cwd}{dim: (m…}");
  });

  it("is the same bar when the powerline fact is explicitly undefined", () => {
    const withoutFact = renderBarLayout(bar(), 90, TAGGED);
    const withUndefined = renderBarLayout(bar({ powerline: undefined }), 90, TAGGED);
    expect(withUndefined).toEqual(withoutFact);
  });
});

describe("the folder line as powerline segments", () => {
  it("shows the folder and the branch with the counts, then the statuses", () => {
    const layout = renderBarLayout(bar({ powerline: { git: SOME } }), 140, IDENTITY);
    expect(layout.lines).toHaveLength(2);
    expect(stripAnsi(layout.lines[1] ?? "")).toBe(
      ` ${FOLDER} fake-cwd ${ARROW} ${BRANCH} main +1 ~2 ?3 ${ARROW}  indexer ready`,
    );
  });

  it("draws HARIL and the mode as blocks on the first line, and leaves the button where it was", () => {
    for (const width of [20, 40, 80, 200]) {
      const plain = renderBarLayout(bar(), width, TRUECOLOR);
      const segments = renderBarLayout(bar({ powerline: { git: SOME } }), width, TRUECOLOR);
      expect(segments.hits.find((hit) => hit.target === "stop")).toEqual(
        plain.hits.find((hit) => hit.target === "stop"),
      );
      expect(textWidth(stripAnsi(segments.lines[0] ?? ""))).toBe(
        textWidth(stripAnsi(plain.lines[0] ?? "")),
      );
    }
    const wide = renderBarLayout(bar({ powerline: { git: SOME } }), 200, TRUECOLOR);
    expect(wide.lines[0]).not.toBe(renderBarLayout(bar(), 200, TRUECOLOR).lines[0]);
    expect(stripAnsi(wide.lines[0] ?? "")).toContain(" ◆ HARIL ");
    const mode = wide.hits.find((hit) => hit.target === "mode");
    // The arrow that closes the block is not part of what is clicked.
    expect(stripAnsi(wide.lines[0] ?? "").slice(mode?.start, mode?.end)).toBe(" MODE: ACTION ");
  });

  it("has no git segment outside a repository, and still shows the statuses", () => {
    const layout = renderBarLayout(
      bar({ branch: null, powerline: { git: undefined } }),
      140,
      IDENTITY,
    );
    expect(stripAnsi(layout.lines[1] ?? "")).toBe(` ${FOLDER} fake-cwd ${ARROW}  indexer ready`);
  });

  it("shows the branch without counts while git has not answered", () => {
    const layout = renderBarLayout(bar({ powerline: { git: undefined } }), 140, IDENTITY);
    expect(stripAnsi(layout.lines[1] ?? "")).toContain(` ${BRANCH} main ${ARROW}`);
  });

  it("keeps every status, in order, each after two spaces and as plain dim text", () => {
    const layout = renderBarLayout(
      bar({ statuses: ["one", `${ESC}[31mtwo${ESC}[0m`, "  ", "three"], powerline: { git: SOME } }),
      140,
      TAGGED,
    );
    expect(layout.lines[1]?.endsWith("{dim:  one}{dim:  two}{dim:  three}")).toBe(true);
  });

  it("never exceeds the width: 20, 40, 80 and 200 columns, and every width from 1 to 120", () => {
    const facts = [
      bar({ powerline: { git: SOME } }),
      bar({
        cwd: `/very/long/${"folder/".repeat(30)}end`,
        branch: "feature/a-branch-with-a-long-name-for-the-bar",
        statuses: ["a status that is long, as another extension may set it", "second"],
        powerline: { git: SOME },
      }),
      bar({ branch: null, powerline: { git: undefined } }),
    ];
    for (const item of facts) {
      for (const width of [20, 40, 80, 200, ...Array.from({ length: 120 }, (_, i) => i + 1)]) {
        const layout = renderBarLayout(item, width, TRUECOLOR);
        for (const line of layout.lines) {
          expect(textWidth(stripAnsi(line)), `width ${width}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("is two lines at width 1 and nothing at width 0", () => {
    expect(renderBarLayout(bar({ powerline: { git: SOME } }), 1, IDENTITY).lines).toHaveLength(2);
    expect(renderBarLayout(bar({ powerline: { git: SOME } }), 0, IDENTITY).lines).toEqual([]);
  });

  it("falls back to the plain line where not even one segment fits", () => {
    const narrow = renderBarLayout(bar({ powerline: { git: SOME } }), 3, TAGGED);
    expect(narrow.lines[1]).toBe(renderBarLayout(bar(), 3, TAGGED).lines[1]);
  });

  it("gives the statuses what the segments leave, and cuts them with an ellipsis", () => {
    const facts = bar({
      statuses: ["a very long status line from an extension"],
      powerline: { git: SOME },
    });
    const text = stripAnsi(renderBarLayout(facts, 60, IDENTITY).lines[1] ?? "");
    expect(textWidth(text)).toBeLessThanOrEqual(60);
    expect(text.startsWith(` ${FOLDER} fake-cwd ${ARROW} ${BRANCH} main +1 ~2 ?3 ${ARROW}`)).toBe(
      true,
    );
    expect(text.endsWith("…")).toBe(true);
  });

  it("shows hostile text from the folder, the branch and the statuses as plain characters", () => {
    const hostile = `x${ESC}]0;owned${String.fromCharCode(7)}${ESC}[2Jy${String.fromCodePoint(0x202e)}z`;
    const layout = renderBarLayout(
      bar({ cwd: hostile, branch: hostile, statuses: [hostile], powerline: { git: SOME } }),
      200,
      TRUECOLOR,
    );
    const line = layout.lines[1] ?? "";
    expect(line).not.toContain(`${ESC}]`);
    expect(line).not.toContain(`${ESC}[2J`);
    expect(stripAnsi(line)).not.toContain(String.fromCodePoint(0x202e));
  });

  it("draws no bar at all, folder line included, when compact", () => {
    const layout = renderBarLayout(bar({ compact: true, powerline: { git: SOME } }), 140, TAGGED);
    expect(layout).toEqual({ lines: [], hits: [] });
  });
});
