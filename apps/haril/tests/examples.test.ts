import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CliIo, type HostInfo, run } from "../src/cli.js";

const HOST: HostInfo = { nodeVersion: "v24.21.0", platform: "linux", arch: "x64" };
const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));

// Real fs reads: these files are the shipped examples the smoke script validates.
function validateExample(name: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readFile: (path) => readFileSync(path, "utf8"),
  };
  const code = run(["plan", "validate", `${EXAMPLES}${name}`], io, HOST);
  return { code, out, err };
}

describe("example plans", () => {
  it("plan.valid.json validates with exit 0", () => {
    const { code, out, err } = validateExample("plan.valid.json");
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("4 tasks");
  });

  it("plan.cycle.json fails with a cycle and exit 1", () => {
    const { code, out } = validateExample("plan.cycle.json");
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("dependency cycle");
  });
});
