import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { installApp, uninstallApp } from "../src/app-install.js";
import { runCli } from "../src/index.js";
import { createFakeExec, createMemoryFs, type MemoryFs } from "./fakes.js";

// `install` and `uninstall` of HARIL itself (M3-T3): a payload under app/<version>, shims under bin/,
// current.json as the ledger of what was created, and no PATH edits. Real fs is never used here.

const SRC = "C:\\src\\haril";
const ROOT = "C:\\HARIL";
const VERSION = "0.4.1";
const APP = `${ROOT}\\app\\${VERSION}`;
const NOW = "2026-10-16T00:00:00.000Z";
const encoder = new TextEncoder();

function text(fs: MemoryFs, path: string): string {
  const bytes = fs.files.get(path);
  if (bytes === undefined) throw new Error(`missing ${path}`);
  return new TextDecoder().decode(bytes);
}

function sourceTree(fs: MemoryFs): void {
  fs.files.set(
    `${SRC}\\apps\\haril\\package.json`,
    encoder.encode(JSON.stringify({ version: VERSION })),
  );
  fs.files.set(`${SRC}\\apps\\haril\\dist\\haril.mjs`, encoder.encode("// haril bundle"));
  fs.files.set(
    `${SRC}\\apps\\haril\\dist\\blocks\\methodologies\\odd\\block.md`,
    encoder.encode("odd block"),
  );
  fs.files.set(
    `${SRC}\\integrations\\agent-pi-bridge\\dist\\bridge.mjs`,
    encoder.encode("// bridge"),
  );
  fs.files.set(
    `${SRC}\\apps\\bootstrap\\dist\\haril-bootstrap.mjs`,
    encoder.encode("// bootstrap"),
  );
  fs.files.set(`${SRC}\\apps\\shell\\dist\\shell.mjs`, encoder.encode("// shell"));
}

function installDeps(fs: MemoryFs, overrides: { sourceRoot?: string } = {}) {
  return {
    root: ROOT,
    sourceRoot: overrides.sourceRoot ?? SRC,
    platform: "win32",
    fs,
    now: () => NOW,
  };
}

function manifestWithNode(fs: MemoryFs): string {
  const nodePath = `${ROOT}\\runtime\\node\\v24.22.0-win-x64\\node.exe`;
  fs.files.set(nodePath, encoder.encode("node"));
  fs.files.set(
    `${ROOT}\\runtime\\manifest.json`,
    encoder.encode(
      JSON.stringify({
        schemaVersion: 1,
        node: { version: "24.22.0", path: nodePath, sha256: null },
        pi: { version: "1.2.0", cliPath: `${ROOT}\\vendor\\pi\\1.2.0\\cli.js` },
        installedAt: NOW,
      }),
    ),
  );
  return nodePath;
}

function keysUnder(fs: MemoryFs, dir: string): string[] {
  return [...fs.files.keys()].filter((key) => key.startsWith(`${dir}\\`));
}

describe("installApp", () => {
  it("copies the payload under app/<version>, writes the shims and current.json", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);

    const result = await installApp(installDeps(fs));

    expect(result.ok).toBe(true);
    expect(result.version).toBe(VERSION);
    expect(fs.files.has(`${APP}\\haril.mjs`)).toBe(true);
    expect(fs.files.has(`${APP}\\blocks\\methodologies\\odd\\block.md`)).toBe(true);
    expect(fs.files.has(`${APP}\\integrations\\agent-pi-bridge\\dist\\bridge.mjs`)).toBe(true);
    expect(fs.files.has(`${APP}\\haril-bootstrap.mjs`)).toBe(true);
    expect(fs.files.has(`${APP}\\shell.mjs`)).toBe(true);
    for (const shim of ["haril.cmd", "haril.ps1", "haril"]) {
      expect(fs.files.has(`${ROOT}\\bin\\${shim}`)).toBe(true);
    }

    const current = JSON.parse(text(fs, `${ROOT}\\app\\current.json`));
    expect(current.version).toBe(VERSION);
    expect(current.installedAt).toBe(NOW);
    const haril = current.files.find(
      (file: { path: string }) => file.path === `app/${VERSION}/haril.mjs`,
    );
    expect(haril.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(current.files.map((file: { path: string }) => file.path)).toContain("bin/haril.cmd");
    expect(current.files.map((file: { path: string }) => file.path)).toContain(
      `app/${VERSION}/shell.mjs`,
    );
  });

  it("points the shims at the isolated Node of runtime/manifest.json when it exists", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);
    const nodePath = manifestWithNode(fs);

    const result = await installApp(installDeps(fs));

    expect(result.nodeSource).toBe("manifest");
    expect(text(fs, `${ROOT}\\bin\\haril.cmd`)).toContain(`"${nodePath}" "${APP}\\haril.mjs"`);
    expect(text(fs, `${ROOT}\\bin\\haril.ps1`)).toContain(`& '${nodePath}' '${APP}\\haril.mjs'`);
    expect(text(fs, `${ROOT}\\bin\\haril`)).toContain(`"${nodePath}" "${APP}\\haril.mjs"`);
  });

  it("falls back to node on PATH and says so when there is no runtime manifest", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);

    const result = await installApp(installDeps(fs));

    expect(result.nodeSource).toBe("path");
    expect(text(fs, `${ROOT}\\bin\\haril.cmd`)).toContain(`node "${APP}\\haril.mjs"`);
  });

  it("reports skipped on a second install of the same version and rewrites nothing", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);
    await installApp(installDeps(fs));
    const before = new Map(fs.files);

    const second = await installApp(installDeps(fs));

    expect(second.ok).toBe(true);
    expect(second.steps.map((step) => step.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(fs.files).toEqual(before);
  });

  it("repairs a payload file whose hash no longer matches", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);
    await installApp(installDeps(fs));
    fs.files.set(`${APP}\\haril.mjs`, encoder.encode("tampered"));

    const second = await installApp(installDeps(fs));

    expect(second.ok).toBe(true);
    expect(text(fs, `${APP}\\haril.mjs`)).toBe("// haril bundle");
    expect(second.steps[0]?.status).toBe("ok");
  });

  it("fails without writing anything when the shell bundle is not built", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);
    fs.files.delete(`${SRC}\\apps\\shell\\dist\\shell.mjs`);

    const result = await installApp(installDeps(fs));

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.detail).toContain("apps/shell/dist/shell.mjs");
    expect(keysUnder(fs, ROOT)).toEqual([]);
  });

  it("fails without writing anything when the build output is missing", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);
    fs.files.delete(`${SRC}\\apps\\haril\\dist\\haril.mjs`);

    const result = await installApp(installDeps(fs));

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.name).toBe("build");
    expect(result.steps[0]?.detail).toContain("run npm run build first");
    expect(keysUnder(fs, ROOT)).toEqual([]);
  });

  it("writes only under app/ and bin/ and never touches PATH or other roots", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);
    const exec = createFakeExec(fs, win32);

    await installApp(installDeps(fs));

    const written = [...fs.files.keys()].filter((key) => key.startsWith(ROOT));
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) {
      expect(key.startsWith(`${ROOT}\\app\\`) || key.startsWith(`${ROOT}\\bin\\`)).toBe(true);
    }
    expect(exec.calls).toEqual([]);
  });
});

describe("uninstallApp", () => {
  it("removes the entries recorded in current.json and keeps data, runtime and vendor", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);
    await installApp(installDeps(fs));
    fs.files.set(`${ROOT}\\data\\haril.db`, encoder.encode("db"));
    manifestWithNode(fs);
    fs.files.set(`${ROOT}\\vendor\\pi\\1.2.0\\cli.js`, encoder.encode("pi"));

    const result = await uninstallApp({ root: ROOT, platform: "win32", fs });

    expect(result.ok).toBe(true);
    expect(keysUnder(fs, `${ROOT}\\app`)).toEqual([]);
    expect(fs.files.has(`${ROOT}\\bin\\haril.cmd`)).toBe(false);
    expect(fs.files.has(`${ROOT}\\app\\current.json`)).toBe(false);
    expect(fs.files.has(`${ROOT}\\data\\haril.db`)).toBe(true);
    expect(fs.files.has(`${ROOT}\\vendor\\pi\\1.2.0\\cli.js`)).toBe(true);
    expect(fs.files.has(`${ROOT}\\runtime\\manifest.json`)).toBe(true);
    expect(result.kept).toEqual(expect.arrayContaining(["data", "runtime", "vendor"]));
  });

  it("keeps entries it did not create under app/ and bin/", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);
    await installApp(installDeps(fs));
    fs.files.set(`${ROOT}\\app\\notes.txt`, encoder.encode("mine"));
    fs.files.set(`${ROOT}\\bin\\custom.cmd`, encoder.encode("mine"));

    const result = await uninstallApp({ root: ROOT, platform: "win32", fs });

    expect(fs.files.has(`${ROOT}\\app\\notes.txt`)).toBe(true);
    expect(fs.files.has(`${ROOT}\\bin\\custom.cmd`)).toBe(true);
    expect(result.kept).toEqual(expect.arrayContaining(["app/notes.txt", "bin/custom.cmd"]));
  });

  it("succeeds with nothing removed when no install is recorded", async () => {
    const fs = createMemoryFs();

    const result = await uninstallApp({ root: ROOT, platform: "win32", fs });

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it("refuses to act on a current.json it cannot read", async () => {
    const fs = createMemoryFs();
    fs.files.set(`${ROOT}\\app\\current.json`, encoder.encode("{not json"));

    const result = await uninstallApp({ root: ROOT, platform: "win32", fs });

    expect(result.ok).toBe(false);
    expect(result.removed).toEqual([]);
    expect(fs.files.has(`${ROOT}\\app\\current.json`)).toBe(true);
  });

  it("refuses a current.json that names paths outside app/ and bin/", async () => {
    const fs = createMemoryFs();
    fs.files.set(`${ROOT}\\data\\haril.db`, encoder.encode("db"));
    fs.files.set(
      `${ROOT}\\app\\current.json`,
      encoder.encode(
        JSON.stringify({
          version: VERSION,
          installedAt: NOW,
          files: [{ path: "data/haril.db", sha256: "0".repeat(64) }],
        }),
      ),
    );

    const result = await uninstallApp({ root: ROOT, platform: "win32", fs });

    expect(result.ok).toBe(false);
    expect(fs.files.has(`${ROOT}\\data\\haril.db`)).toBe(true);
  });
});

describe("haril-bootstrap install and uninstall", () => {
  function harness() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
      out,
      err,
    };
  }

  function cliHost(fs: MemoryFs) {
    return {
      platform: "win32",
      arch: "x64",
      env: {},
      homeDir: "C:\\Users\\tester",
      cwd: "C:\\work",
      fs,
      exec: createFakeExec(fs, win32),
      fetch: { get: async () => new Uint8Array() },
      now: () => NOW,
    };
  }

  it("install prints the bin directory and exits 0; --json is parseable", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);
    const text_ = harness();
    expect(await runCli(["install", "--root", ROOT, "--from", SRC], text_.io, cliHost(fs))).toBe(0);
    expect(text_.out.join("\n")).toContain(`${ROOT}\\bin\\haril.ps1`);

    const json = harness();
    expect(
      await runCli(["install", "--root", ROOT, "--from", SRC, "--json"], json.io, cliHost(fs)),
    ).toBe(0);
    const parsed = JSON.parse(json.out.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.version).toBe(VERSION);
  });

  it("install exits 1 and asks for npm run build when the build output is missing", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);
    fs.files.delete(`${SRC}\\apps\\haril\\dist\\haril.mjs`);
    const run = harness();

    expect(await runCli(["install", "--root", ROOT, "--from", SRC], run.io, cliHost(fs))).toBe(1);
    expect(run.err.join("\n")).toContain("run npm run build first");
  });

  it("uninstall exits 0 after an install", async () => {
    const fs = createMemoryFs();
    sourceTree(fs);
    await runCli(["install", "--root", ROOT, "--from", SRC], harness().io, cliHost(fs));
    const run = harness();

    expect(await runCli(["uninstall", "--root", ROOT], run.io, cliHost(fs))).toBe(0);
    expect(fs.files.has(`${ROOT}\\bin\\haril.cmd`)).toBe(false);
  });

  it("install rejects an unknown option with exit 1", async () => {
    const run = harness();
    expect(await runCli(["install", "--force"], run.io, cliHost(createMemoryFs()))).toBe(1);
    expect(run.err.join("\n")).toContain("--force");
  });
});
