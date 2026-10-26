import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  installVisualTools,
  TTE_VERSION,
  UV_VERSION,
  verifyUvArchive,
  visualToolPaths,
} from "../install-visual-tools.mjs";

test("downloaded uv archives must match the official SHA-256 manifest", () => {
  const binary = Buffer.from("synthetic test archive");
  const sha = createHash("sha256").update(binary).digest("hex");
  assert.doesNotThrow(() => verifyUvArchive(binary, `${sha}  uv-test.zip`));
  assert.throws(() => verifyUvArchive(Buffer.from("tampered"), sha), /SHA-256 mismatch/);
  assert.throws(() => verifyUvArchive(binary, "not a checksum"), /checksum is missing/);
});

test("Matrix dependency is installed in a private HARIL directory with pinned versions", async () => {
  assert.match(UV_VERSION, /^\d+\.\d+\.\d+$/);
  const root = "/haril/runtime";
  const paths = visualToolPaths(root, "linux");
  const calls = [];
  const lines = [];
  const result = await installVisualTools(root, {
    platform: "linux",
    arch: "x64",
    env: { PATH: "/usr/bin" },
    exists: (path) => path === paths.uv || path === paths.tte,
    execute: async (...args) => calls.push(args),
    output: (line) => lines.push(line),
  });
  assert.deepEqual(result, { status: "installed", binary: paths.tte });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], paths.uv);
  assert.deepEqual(calls[0][1], [
    "tool",
    "install",
    "--python",
    "3.12",
    `terminaltexteffects==${TTE_VERSION}`,
  ]);
  assert.equal(calls[0][2].UV_TOOL_DIR, paths.toolDir);
  assert.equal(calls[0][2].UV_TOOL_BIN_DIR, paths.binDir);
  assert.equal(calls[0][2].UV_PYTHON_INSTALL_DIR, paths.pythonDir);
  assert.match(lines.join(" "), /Matrix ready/);
});

test("a missing uv is automatically prepared before installing TTE", async () => {
  const root = "C:\\Users\\Anderson\\AppData\\Local\\HARIL";
  const paths = visualToolPaths(root, "win32");
  let ready = false;
  const calls = [];
  const bootstraps = [];
  const result = await installVisualTools(root, {
    platform: "win32",
    arch: "x64",
    env: {},
    exists: (path) => (path === paths.uv ? ready : path === paths.tte),
    bootstrap: async (...args) => {
      bootstraps.push(args);
      ready = true;
      return paths.uv;
    },
    execute: async (...args) => calls.push(args),
    output: () => undefined,
  });
  assert.equal(result.status, "installed");
  assert.equal(bootstraps.length, 1);
  assert.deepEqual(bootstraps[0].slice(0, 3), [root, "win32", "x64"]);
  assert.equal(calls[0][0], paths.uv);
  assert.match(paths.tte, /tte\.exe$/);
});

test("CI and explicit opt-out do not download or install anything", async () => {
  for (const env of [
    { CI: "true" },
    { HARIL_AUTO_INSTALL_VISUALS: "off" },
    { HARIL_STARTUP_ANIMATION: "off" },
  ]) {
    const result = await installVisualTools("/tmp/haril", {
      env,
      bootstrap: () => {
        throw new Error("unexpected bootstrap");
      },
      execute: () => {
        throw new Error("unexpected install");
      },
      output: () => undefined,
    });
    assert.deepEqual(result, { status: "skipped" });
  }
});

test("installer refuses to report success without the managed tte binary", async () => {
  await assert.rejects(
    installVisualTools("/haril", {
      platform: "linux",
      env: {},
      exists: (path) => path.endsWith("/uv"),
      execute: async () => undefined,
      output: () => undefined,
    }),
    /was not created/,
  );
});
