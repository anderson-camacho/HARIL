import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installModes } from "../src/mode-controller.js";
import { fakeContext, fakePi } from "./fake-pi.js";

// haril_save_research writes under haril.json's research folder (delegation.research.folder, P18; phase F7), read
// through the CLI; without one it keeps docs/investigacion. A folder outside the project is refused, never followed.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-research-folder-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function consult(folder: string | undefined) {
  const fake = fakePi();
  const ctx = fakeContext(root);
  const modes = installModes(fake.pi, {
    researchRoot: () => root,
    researchFolder: async () => folder,
    now: () => 1_000,
    redraw: () => undefined,
  });
  modes.switchTo("consult", ctx);
  return (title: string) =>
    fake.tools
      .get("haril_save_research")
      ?.execute("c1", { title, content: "# Findings" }, undefined, undefined, ctx);
}

describe("the research folder", () => {
  it("is haril.json's folder when it names one", async () => {
    const result = await consult("notes/research")("Runtime claims");
    expect(result?.content[0]?.text).toMatch(
      /^saved notes[\\/]research[\\/][\d-]+-runtime-claims\.md/,
    );
    expect(readdirSync(join(root, "notes", "research"))).toHaveLength(1);
    expect(existsSync(join(root, "docs", "investigacion"))).toBe(false);
  });

  it("is docs/investigacion without one", async () => {
    await consult(undefined)("Runtime claims");
    expect(readdirSync(join(root, "docs", "investigacion"))).toHaveLength(1);
  });

  it("is refused when it leaves the project", async () => {
    await expect(consult("../outside")("Runtime claims")).rejects.toThrow(/inside the project/);
    await expect(consult("C:\\outside")("Runtime claims")).rejects.toThrow(/inside the project/);
  });
});
