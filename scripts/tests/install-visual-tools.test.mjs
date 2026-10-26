import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  installVisualTools,
  toolVersionMatches,
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

test("version probe matches exact tool version, not misleading prefixes", () => {
  assert.equal(toolVersionMatches("uv 0.13.5", "0.13.5"), true);
  assert.equal(toolVersionMatches("TerminalTextEffects 0.15.0", "0.15.0"), true);
  assert.equal(toolVersionMatches("TerminalTextEffects 0.15.01", "0.15.0"), false);
  assert.equal(toolVersionMatches("TerminalTextEffects 0.14.0", "0.15.0"), false);
});

test("Matrix dependency is installed in a private HARIL directory with pinned versions", async () => {
  assert.match(UV_VERSION, /^\d+\.\d+\.\d+$/);
  const root = "/haril/runtime";
  const paths = visualToolPaths(root, "linux");
  const calls = [];
  const lines = [];
  let installed = false;
  const result = await installVisualTools(root, {
    platform: "linux",
    arch: "x64",
    env: { PATH: "/usr/bin" },
    exists: (path) => path === paths.uv || (path === paths.tte && installed),
    probe: async () => true,
    execute: async (...args) => {
      calls.push(args);
      installed = true;
    },
    output: (line) => lines.push(line),
  });
  assert.deepEqual(result, { status: "installed", binary: paths.tte });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], paths.uv);
  assert.deepEqual(calls[0][1], [
    "tool",
    "install",
    "--reinstall",
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
  let installed = false;
  const calls = [];
  const bootstraps = [];
  const result = await installVisualTools(root, {
    platform: "win32",
    arch: "x64",
    env: {},
    exists: (path) => (path === paths.uv ? ready : path === paths.tte && installed),
    probe: async () => true,
    bootstrap: async (...args) => {
      bootstraps.push(args);
      ready = true;
      return paths.uv;
    },
    execute: async (...args) => {
      calls.push(args);
      installed = true;
    },
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
      probe: async () => true,
      execute: async () => undefined,
      output: () => undefined,
    }),
    /was not created/,
  );
});

test("up-to-date managed tools are verified without reinstalling or downloading", async () => {
  const paths = visualToolPaths("/haril/runtime", "linux");
  const versions = [];
  const result = await installVisualTools("/haril/runtime", {
    platform: "linux",
    exists: (path) => path === paths.uv || path === paths.tte,
    probe: async (path, version) => {
      versions.push([path, version]);
      return true;
    },
    execute: () => {
      throw new Error("a healthy installation should not be modified");
    },
    bootstrap: () => {
      throw new Error("a healthy installation should not be downloaded");
    },
    output: () => undefined,
  });
  assert.deepEqual(result, { status: "verified", binary: paths.tte });
  assert.deepEqual(versions, [[paths.uv, UV_VERSION], [paths.tte, TTE_VERSION]]);
});

test("a damaged Matrix executable is reinstalled, then checked again", async () => {
  const paths = visualToolPaths("/haril/runtime", "linux");
  let healthy = false;
  const calls = [];
  const result = await installVisualTools("/haril/runtime", {
    platform: "linux",
    exists: (path) => path === paths.uv || path === paths.tte,
    probe: async (path) => path === paths.uv || healthy,
    bootstrap: () => {
      throw new Error("uv is already healthy");
    },
    execute: async (_bin, args) => {
      calls.push(args);
      healthy = true;
    },
    output: () => undefined,
  });
  assert.equal(result.status, "repaired");
  assert.ok(calls[0].includes("--reinstall"));
});

test("a broken managed uv is re-bootstrapped from a verified release", async () => {
  const paths = visualToolPaths("/haril/runtime", "linux");
  let uvHealthy = false;
  const calls = [];
  const result = await installVisualTools("/haril/runtime", {
    platform: "linux",
    exists: (path) => path === paths.uv || path === paths.tte,
    probe: async (path) => path !== paths.uv || uvHealthy,
    bootstrap: async (...args) => {
      calls.push(args);
      uvHealthy = true;
      return paths.uv;
    },
    execute: async () => undefined,
    output: () => undefined,
  });
  assert.equal(result.status, "repaired");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][4], true);
});

test("present-but-broken Matrix after installation is not treated as success", async () => {
  const paths = visualToolPaths("/haril/runtime", "linux");
  await assert.rejects(
    installVisualTools("/haril/runtime", {
      platform: "linux",
      exists: (path) => path === paths.uv || path === paths.tte,
      probe: async (path) => path === paths.uv,
      execute: async () => undefined,
      output: () => undefined,
    }),
    /failed the.*health check/,
  );
});
