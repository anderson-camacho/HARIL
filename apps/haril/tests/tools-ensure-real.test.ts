import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tools } from "../src/commands/tools.js";
import type { HostInfo } from "../src/context.js";
import { ENGRAM_VERSION } from "../src/memory-config.js";
import { harness, parseJson } from "./helpers.js";

// Explicit opt-in: it downloads the official Engram release from github.com into a temporary runtime folder, checks it
// and starts it for the health smoke. It never touches the real HARIL runtime folder or ~/.engram.
describe.skipIf(process.env.HARIL_TEST_ENGRAM_REAL_INSTALL !== "1")(
  "haril tools ensure against the real Engram release",
  () => {
    let root: string;
    let host: HostInfo;

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "haril-ensure-real-")));
      mkdirSync(join(root, "home"));
      host = {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        homeDir: join(root, "home"),
        env: {
          ...process.env,
          HARIL_RUNTIME_DIR: join(root, "runtime"),
          HARIL_CONFIG: join(root, "runtime", "config", "haril.json"),
          HARIL_HOME: join(root, "data"),
        },
      };
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    async function ensure(args: string[] = []) {
      const h = harness();
      const code = await tools(["ensure", "--json", ...args], h.io, host);
      return {
        code,
        json: parseJson<{
          engram: { action: string; to?: string; message?: string; path?: string };
          status: { tools: { id: string; state: string }[] };
        }>(h.out),
      };
    }

    it("installs, verifies, smoke-tests, then repairs a damaged copy", async () => {
      const first = await ensure();
      expect(first.json.engram, JSON.stringify(first.json.engram)).toMatchObject({
        action: "installed",
        to: ENGRAM_VERSION,
      });
      expect(first.code).toBe(0);
      const path = first.json.engram.path ?? "";
      expect(existsSync(path)).toBe(true);
      expect(first.json.status.tools.find((tool) => tool.id === "engram")?.state).toBe("ok");
      const config = JSON.parse(
        readFileSync(join(root, "runtime", "config", "haril.json"), "utf8"),
      );
      expect(config.memory).toEqual({ provider: "engram", binary: path, version: ENGRAM_VERSION });

      const second = await ensure();
      expect(second.json.engram.action).toBe("none");

      writeFileSync(path, "damaged");
      const repaired = await ensure();
      expect(repaired.json.engram, JSON.stringify(repaired.json.engram)).toMatchObject({
        action: "installed",
      });
      expect(repaired.code).toBe(0);
    }, 240_000);
  },
);
