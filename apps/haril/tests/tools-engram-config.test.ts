import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  engramMcpServer,
  planMcp,
  planMemory,
  readJsonObject,
  writeJsonAtomic,
} from "../src/tools/engram-config.js";
import { type EnsureFs, nodeEnsureFs } from "../src/tools/fs.js";

const VENDOR = "/data/haril/vendor/engram";
const CTX = {
  vendorRoot: VENDOR,
  pin: "3.6.0",
  pinBinary: `${VENDOR}/3.6.0/engram`,
  platform: "linux",
};
const MANAGED = { provider: "engram", binary: `${VENDOR}/3.6.0/engram`, version: "3.6.0" };

describe("planning the memory section of haril.json", () => {
  it("writes the section after an install when there is none, keeping every other key", () => {
    const document = { providers: { a: 1 }, ui: { theme: "x" } };
    const plan = planMemory(document, CTX, true);
    expect(plan).toMatchObject({ kind: "write" });
    expect(plan.kind === "write" && plan.document).toEqual({ ...document, memory: MANAGED });
    expect(document).toEqual({ providers: { a: 1 }, ui: { theme: "x" } });
  });

  it("writes into an empty document", () => {
    const plan = planMemory({}, CTX, true);
    expect(plan.kind === "write" && plan.document).toEqual({ memory: MANAGED });
  });

  it("does not add a section when nothing was installed", () => {
    expect(planMemory({ ui: {} }, CTX, false)).toEqual({ kind: "keep" });
  });

  it("never touches an existing provider: null the user chose", () => {
    expect(planMemory({ memory: { provider: "null" } }, CTX, true)).toEqual({ kind: "keep" });
  });

  it("leaves a current managed section alone", () => {
    expect(planMemory({ memory: MANAGED }, CTX, true)).toEqual({ kind: "keep" });
  });

  it("updates binary and version together when they name an older managed version", () => {
    const old = { provider: "engram", binary: `${VENDOR}/3.5.0/engram`, version: "3.5.0" };
    const plan = planMemory({ ui: 1, memory: old }, CTX, true);
    expect(plan).toMatchObject({ kind: "update", from: "3.5.0" });
    expect(plan.kind === "update" && plan.document).toEqual({ ui: 1, memory: MANAGED });
  });

  it("updates a managed section whose provider is null, keeping the user's provider", () => {
    const old = { provider: "null", binary: `${VENDOR}/3.5.0/engram`, version: "3.5.0" };
    const plan = planMemory({ memory: old }, CTX, false);
    expect(plan.kind === "update" && plan.document).toEqual({
      memory: { ...MANAGED, provider: "null" },
    });
  });

  it("updates a section that only names an older version", () => {
    const plan = planMemory({ memory: { provider: "engram", version: "3.5.0" } }, CTX, false);
    expect(plan).toMatchObject({ kind: "update", from: "3.5.0" });
    expect(plan.kind === "update" && plan.document).toEqual({ memory: MANAGED });
  });

  it("updates a section whose binary is an older managed version and has no version", () => {
    const old = { provider: "engram", binary: `${VENDOR}/3.4.1/engram` };
    const plan = planMemory({ memory: old }, CTX, false);
    expect(plan).toMatchObject({ kind: "update", from: "3.4.1" });
  });

  it("keeps unknown keys of the section when it updates it", () => {
    const old = { provider: "engram", version: "3.5.0", extra: true };
    const plan = planMemory({ memory: old }, CTX, false);
    expect(plan.kind === "update" && plan.document.memory).toEqual({ ...MANAGED, extra: true });
  });

  it("never downgrades a newer managed version", () => {
    const newer = { provider: "engram", binary: `${VENDOR}/3.7.0/engram`, version: "3.7.0" };
    expect(planMemory({ memory: newer }, CTX, true)).toEqual({ kind: "keep" });
  });

  it("recognises a user binary outside the vendor folder, and leaves it", () => {
    const user = { provider: "engram", binary: "/opt/engram/bin/engram", version: "3.6.0" };
    expect(planMemory({ memory: user }, CTX, true)).toEqual({
      kind: "override",
      binary: "/opt/engram/bin/engram",
    });
  });

  it("does not take a look-alike folder for the vendor folder", () => {
    const user = { provider: "engram", binary: `${VENDOR}-other/3.5.0/engram` };
    expect(planMemory({ memory: user }, CTX, true)).toMatchObject({ kind: "override" });
  });

  it("does not take a path that climbs out of the vendor folder for managed", () => {
    const user = { provider: "engram", binary: `${VENDOR}/../../evil/engram` };
    expect(planMemory({ memory: user }, CTX, true)).toMatchObject({ kind: "override" });
  });

  it("leaves a binary inside the vendor folder but outside a version folder alone", () => {
    const odd = { provider: "engram", binary: `${VENDOR}/custom/engram` };
    expect(planMemory({ memory: odd }, CTX, true)).toEqual({ kind: "keep" });
  });

  it("reports a section that is not an object", () => {
    expect(planMemory({ memory: "engram" }, CTX, true)).toMatchObject({ kind: "invalid" });
    expect(planMemory({ memory: [] }, CTX, true)).toMatchObject({ kind: "invalid" });
  });

  it("compares Windows paths without regard to case", () => {
    const win = {
      vendorRoot: "C:\\Users\\a\\AppData\\Local\\HARIL\\vendor\\engram",
      pin: "3.6.0",
      pinBinary: "C:\\Users\\a\\AppData\\Local\\HARIL\\vendor\\engram\\3.6.0\\engram.exe",
      platform: "win32",
    };
    const old = {
      provider: "engram",
      binary: "c:\\users\\a\\appdata\\local\\haril\\vendor\\engram\\3.5.0\\engram.exe",
      version: "3.5.0",
    };
    expect(planMemory({ memory: old }, win, true)).toMatchObject({ kind: "update", from: "3.5.0" });
  });
});

describe("reading and writing JSON settings", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "haril-json-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads a missing file as an empty object that did not exist", () => {
    expect(readJsonObject(join(root, "none.json"), nodeEnsureFs)).toEqual({
      ok: true,
      value: {},
      existed: false,
    });
  });

  it("reads an object", () => {
    writeFileSync(join(root, "a.json"), '{"x":1}');
    expect(readJsonObject(join(root, "a.json"), nodeEnsureFs)).toEqual({
      ok: true,
      value: { x: 1 },
      existed: true,
    });
  });

  it.each([
    ["not json", "{oops"],
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"x"'],
  ])("refuses %s", (_name, text) => {
    writeFileSync(join(root, "a.json"), text);
    const read = readJsonObject(join(root, "a.json"), nodeEnsureFs);
    expect(read).toMatchObject({ ok: false });
  });

  it("writes through a temporary file with a trailing newline and no leftovers", () => {
    const target = join(root, "config", "haril.json");
    writeJsonAtomic(target, { a: 1 }, nodeEnsureFs, "id1");
    expect(readFileSync(target, "utf8")).toBe('{\n  "a": 1\n}\n');
    expect(readdirSync(join(root, "config"))).toEqual(["haril.json"]);
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("replaces an existing file", () => {
    const target = join(root, "haril.json");
    writeFileSync(target, "old");
    writeJsonAtomic(target, { a: 2 }, nodeEnsureFs, "id1");
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ a: 2 });
  });

  it("keeps the old file and removes the temporary one when the rename fails", () => {
    const target = join(root, "haril.json");
    writeFileSync(target, "old");
    const failing: EnsureFs = {
      ...nodeEnsureFs,
      rename: () => {
        throw new Error("EPERM");
      },
    };
    expect(() => writeJsonAtomic(target, { a: 2 }, failing, "id1")).toThrow("EPERM");
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readdirSync(root)).toEqual(["haril.json"]);
    expect(existsSync(`${target}.id1.tmp`)).toBe(false);
  });
});

describe("the Pi MCP entry", () => {
  const server = engramMcpServer(
    "/data/haril/vendor/engram/3.6.0/engram",
    "/data/haril/data",
    "linux",
  );

  it("is the one npm run memory:install writes", () => {
    expect(server).toEqual({
      command: "/data/haril/vendor/engram/3.6.0/engram",
      args: ["mcp", "--tools=agent"],
      env: {
        ENGRAM_DATA_DIR: "/data/haril/data/memory/engram",
        ENGRAM_PROJECT: "haril",
        ENGRAM_STARTUP_POLICY: "deny",
        ENGRAM_NO_UPDATE_CHECK: "1",
      },
      exposure: "direct",
      description:
        "Local HARIL project memory: decisions, discoveries, preferences and session handoffs. Never store secrets.",
    });
  });

  it("is added to a file that has other servers, which stay", () => {
    const document = { mcpServers: { other: { command: "x" } }, theme: "dark" };
    const plan = planMcp(document, server, "register");
    expect(plan).toMatchObject({ changed: true });
    expect(plan.changed && plan.document).toEqual({
      mcpServers: { other: { command: "x" }, engram: server },
      theme: "dark",
    });
  });

  it("is added to an empty file when registering", () => {
    const plan = planMcp({}, server, "register");
    expect(plan.changed && plan.document).toEqual({ mcpServers: { engram: server } });
  });

  it("is not added when only refreshing and there is no entry", () => {
    expect(planMcp({ mcpServers: { other: {} } }, server, "refresh")).toEqual({ changed: false });
    expect(planMcp({}, server, "refresh")).toEqual({ changed: false });
  });

  it("replaces an older entry when refreshing", () => {
    const old = { ...server, command: "/data/haril/vendor/engram/3.5.0/engram" };
    const plan = planMcp({ mcpServers: { engram: old } }, server, "refresh");
    expect(plan.changed && plan.document).toEqual({ mcpServers: { engram: server } });
  });

  it("reports no change when the entry is already current", () => {
    expect(planMcp({ mcpServers: { engram: server } }, server, "register")).toEqual({
      changed: false,
    });
  });

  it("does not trust a mcpServers that is not an object", () => {
    const plan = planMcp({ mcpServers: [] }, server, "register");
    expect(plan.changed && plan.document).toEqual({ mcpServers: { engram: server } });
  });
});
