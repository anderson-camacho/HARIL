import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

// `haril project init|list` (M1-T3): preview by default, --yes applies, a foreign manifest is never overwritten.
let sb: Sandbox;
let h: Harness;

beforeEach(() => {
  sb = makeSandbox();
  h = harness();
});

afterEach(() => {
  sb.cleanup();
});

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const REPO_BLOCKS = fileURLToPath(new URL("../../../blocks", import.meta.url));

describe("haril project init", () => {
  it("previews the project and writes nothing without --yes (exit 0)", () => {
    const root = projectRoot(sb, "demo");
    expect(run(["project", "init", root, "--name", "Demo"], h.io, sb.host)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("demo");
    expect(text).toContain(join(root, ".haril", "project.json"));
    expect(text).toContain("Nothing applied. Re-run with --yes to apply.");
    expect(existsSync(join(root, ".haril"))).toBe(false);
    expect(existsSync(sb.dataDir)).toBe(false);
  });

  it("with --yes writes the manifest, registers the project and creates its data directory", () => {
    const root = projectRoot(sb, "demo");
    expect(run(["project", "init", root, "--name", "Demo", "--yes", "--json"], h.io, sb.host)).toBe(
      0,
    );
    const result = parseJson<{ applied: boolean; projectId: string; slug: string }>(h.out);
    expect(result).toMatchObject({ applied: true, slug: "demo" });

    const manifest = JSON.parse(readFileSync(join(root, ".haril", "project.json"), "utf8"));
    expect(manifest).toEqual({
      schemaVersion: 1,
      name: "Demo",
      slug: "demo",
      methodology: {
        id: "haril.methodology.odd",
        version: "0.1.0",
        sha256: sha256(join(REPO_BLOCKS, "methodologies", "odd", "block.md")),
      },
      security: {
        minLevel: "N0",
        shell: "deny",
        allowedPaths: ["."],
        dataClass: "internal",
        optIn: [],
      },
    });
    expect(existsSync(join(sb.dataDir, "projects", result.projectId))).toBe(true);
  });

  it("re-running with identical content is idempotent: one project, same manifest hash", () => {
    const root = projectRoot(sb, "demo");
    run(["project", "init", root, "--name", "Demo", "--yes"], h.io, sb.host);
    const before = sha256(join(root, ".haril", "project.json"));

    const again = harness();
    expect(run(["project", "init", root, "--name", "Demo", "--yes"], again.io, sb.host)).toBe(0);
    expect(sha256(join(root, ".haril", "project.json"))).toBe(before);

    const list = harness();
    run(["project", "list", "--json"], list.io, sb.host);
    expect(parseJson<{ projects: unknown[] }>(list.out).projects).toHaveLength(1);
  });

  it("never overwrites a different existing manifest: exit 2 and the hash is unchanged", () => {
    const root = projectRoot(sb, "demo");
    mkdirSync(join(root, ".haril"));
    const path = join(root, ".haril", "project.json");
    writeFileSync(path, '{"schemaVersion":1,"name":"Someone else"}\n');
    const before = sha256(path);

    expect(run(["project", "init", root, "--name", "Demo", "--yes"], h.io, sb.host)).toBe(2);
    expect(h.err.join("\n")).toContain("not overwritten");
    expect(sha256(path)).toBe(before);
    expect(existsSync(sb.dataDir)).toBe(false);
  });

  it("isolates two projects: distinct registrations and data directories", () => {
    const alpha = projectRoot(sb, "alpha");
    const beta = projectRoot(sb, "beta");
    expect(
      run(["project", "init", alpha, "--name", "Alpha", "--yes", "--json"], h.io, sb.host),
    ).toBe(0);
    const first = parseJson<{ projectId: string }>(h.out);
    const second = harness();
    expect(
      run(["project", "init", beta, "--name", "Beta", "--yes", "--json"], second.io, sb.host),
    ).toBe(0);
    const other = parseJson<{ projectId: string }>(second.out);

    expect(other.projectId).not.toBe(first.projectId);
    expect(existsSync(join(sb.dataDir, "projects", first.projectId))).toBe(true);
    expect(existsSync(join(sb.dataDir, "projects", other.projectId))).toBe(true);
  });

  it("refuses a slug already registered for another root (exit 2)", () => {
    run(["project", "init", projectRoot(sb, "a"), "--name", "Demo", "--yes"], h.io, sb.host);
    const second = harness();
    const code = run(
      ["project", "init", projectRoot(sb, "b"), "--name", "Demo", "--yes"],
      second.io,
      sb.host,
    );
    expect(code).toBe(2);
    expect(second.err.join("\n")).toContain("already registered");
  });

  it("defaults the methodology to odd and rejects an unknown one (exit 2)", () => {
    const root = projectRoot(sb, "demo");
    expect(
      run(["project", "init", root, "--name", "Demo", "--methodology", "scrum"], h.io, sb.host),
    ).toBe(2);
    expect(h.err.join("\n")).toContain("methodology");
  });

  it("requires --name (exit 2)", () => {
    expect(run(["project", "init", projectRoot(sb, "demo")], h.io, sb.host)).toBe(2);
    expect(h.err.join("\n")).toContain("--name");
  });
});

describe("haril project list", () => {
  it("prints the registered projects", () => {
    run(["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--yes"], h.io, sb.host);
    const list = harness();
    expect(run(["project", "list"], list.io, sb.host)).toBe(0);
    expect(list.out.join("\n")).toContain("demo");
  });

  it("says not initialized and creates nothing when there is no store", () => {
    const list = harness();
    expect(run(["project", "list"], list.io, sb.host)).toBe(0);
    expect(list.out.join("\n")).toContain("not initialized");
    expect(existsSync(sb.dataDir)).toBe(false);
  });
});
