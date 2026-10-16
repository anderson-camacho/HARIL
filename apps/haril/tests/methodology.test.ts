import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  type Harness,
  harness,
  makeSandbox,
  parseJson,
  projectRoot,
  type Sandbox,
} from "./helpers.js";

// `haril methodology list` and `project init --methodology` validated against the native blocks (M3-T1).
const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const BLOCKS = join(REPO, "blocks");
const CORE_SRC = join(REPO, "packages", "core", "src");

const blockSha = (name: string) =>
  createHash("sha256")
    .update(readFileSync(join(BLOCKS, "methodologies", name, "block.md")))
    .digest("hex");

let sb: Sandbox;
let h: Harness;

beforeEach(() => {
  sb = makeSandbox();
  h = harness();
});

afterEach(() => {
  sb.cleanup();
});

describe("haril methodology list", () => {
  it("prints the three native methodologies with version and sha256 prefix (exit 0)", () => {
    expect(run(["methodology", "list"], h.io, sb.host)).toBe(0);
    const text = h.out.join("\n");
    for (const name of ["odd", "tdd", "custom"]) {
      expect(text).toContain(`haril.methodology.${name}`);
      expect(text).toContain(blockSha(name).slice(0, 12));
    }
    expect(text).toContain("0.1.0");
  });

  it("emits the methodologies as JSON with the full sha256", () => {
    expect(run(["methodology", "list", "--json"], h.io, sb.host)).toBe(0);
    const result = parseJson<{
      methodologies: { id: string; version: string; sha256: string; summary: string }[];
    }>(h.out);
    expect(result.methodologies.map((item) => item.id)).toEqual([
      "haril.methodology.custom",
      "haril.methodology.odd",
      "haril.methodology.tdd",
    ]);
    const odd = result.methodologies.find((item) => item.id === "haril.methodology.odd");
    expect(odd?.sha256).toBe(blockSha("odd"));
    expect(odd?.summary.length).toBeGreaterThan(0);
  });

  it("refuses with exit 2 and the reasons when a native block is invalid (fail closed)", () => {
    const broken = mkdtempSync(join(tmpdir(), "haril-broken-"));
    try {
      mkdirSync(join(broken, "methodologies", "odd"), { recursive: true });
      writeFileSync(join(broken, "methodologies", "odd", "block.md"), "---\n{}\n---\n", "utf8");
      const bad = harness();
      expect(run(["methodology", "list"], bad.io, { ...sb.host, blocksDir: broken })).toBe(2);
      expect(bad.err.join("\n")).toContain("methodologies/odd/block.md");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("rejects an unknown option (exit 2)", () => {
    expect(run(["methodology", "list", "--verbose"], h.io, sb.host)).toBe(2);
  });

  it("rejects a missing subcommand (exit 2)", () => {
    expect(run(["methodology"], h.io, sb.host)).toBe(2);
  });
});

describe("project init --methodology", () => {
  it.each(["odd", "tdd", "custom"])(
    "stores %s as {id, version, sha256} in the manifest",
    (name) => {
      const root = projectRoot(sb, name);
      expect(
        run(
          ["project", "init", root, "--name", "Demo", "--methodology", name, "--yes", "--json"],
          h.io,
          sb.host,
        ),
      ).toBe(0);
      const manifest = JSON.parse(readFileSync(join(root, ".haril", "project.json"), "utf8"));
      expect(manifest.methodology).toEqual({
        id: `haril.methodology.${name}`,
        version: "0.1.0",
        sha256: blockSha(name),
      });
    },
  );

  it("rejects an unknown methodology and lists the valid ones (exit 2)", () => {
    expect(
      run(
        ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--methodology", "scrum"],
        h.io,
        sb.host,
      ),
    ).toBe(2);
    expect(h.err.join("\n")).toContain("use one of: custom, odd, tdd");
  });

  it("keeps an old plain-string manifest instead of reporting a conflict", () => {
    const root = projectRoot(sb, "legacy");
    mkdirSync(join(root, ".haril"));
    const path = join(root, ".haril", "project.json");
    const legacy = {
      schemaVersion: 1,
      name: "Legacy",
      slug: "legacy",
      methodology: "odd",
      security: {
        minLevel: "N0",
        shell: "deny",
        allowedPaths: ["."],
        dataClass: "internal",
        optIn: [],
      },
    };
    writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const before = readFileSync(path, "utf8");

    expect(
      run(
        ["project", "init", root, "--name", "Legacy", "--methodology", "odd", "--yes"],
        h.io,
        sb.host,
      ),
    ).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

// V14-7 (H13): the core tree is byte-identical before and after choosing another methodology.
function treeHash(dir: string): string {
  const hash = createHash("sha256");
  const files = readdirSync(dir, { recursive: true })
    .map((entry) => String(entry).split("\\").join("/"))
    .filter((entry) => statSync(join(dir, entry)).isFile())
    .sort();
  for (const file of files) {
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(join(dir, file)))
      .update("\0");
  }
  return hash.digest("hex");
}

describe("V14-7 methodology switch leaves packages/core untouched", () => {
  it("hashes packages/core/src identically across odd and tdd projects", () => {
    const before = treeHash(CORE_SRC);
    const odd = projectRoot(sb, "odd-project");
    const tdd = projectRoot(sb, "tdd-project");
    expect(
      run(
        ["project", "init", odd, "--name", "Odd", "--methodology", "odd", "--yes"],
        h.io,
        sb.host,
      ),
    ).toBe(0);
    expect(
      run(
        ["project", "init", tdd, "--name", "Tdd", "--methodology", "tdd", "--yes"],
        h.io,
        sb.host,
      ),
    ).toBe(0);
    expect(existsSync(join(tdd, ".haril", "project.json"))).toBe(true);
    expect(treeHash(CORE_SRC)).toBe(before);
  });
});
