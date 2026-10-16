import { win32 } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { installRuntime, parseManifest } from "../src/index.js";
import {
  createFakeExec,
  createFakeFetch,
  createMemoryFs,
  installDeps,
  type MemoryFs,
  RELEASE,
  shasumsFor,
  ZIP_BYTES,
  ZIP_NAME,
} from "./fakes.js";

// The installer with every port faked: the Node archive, the SHASUMS file, tar, node and npm.
const ARCHIVE_URL = `${RELEASE}${ZIP_NAME}`;
const SHASUMS_URL = `${RELEASE}SHASUMS256.txt`;
const NODE_EXE = "C:\\HARIL\\runtime\\node\\v24.22.0-win-x64\\node.exe";
const PI_CLI =
  "C:\\HARIL\\vendor\\pi\\1.2.0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js";
const MANIFEST = "C:\\HARIL\\runtime\\manifest.json";

let fs: MemoryFs;

beforeEach(() => {
  fs = createMemoryFs();
});

function responses() {
  return { [SHASUMS_URL]: shasumsFor(ZIP_BYTES), [ARCHIVE_URL]: ZIP_BYTES };
}

describe("installRuntime", () => {
  it("installs the pinned Node and Pi, then writes the manifest", async () => {
    const exec = createFakeExec(fs, win32);
    const fetch = createFakeFetch(responses());
    const result = await installRuntime(installDeps({ fs, exec, fetch }));

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => [step.name, step.status])).toEqual([
      ["node", "ok"],
      ["pi", "ok"],
      ["manifest", "ok"],
    ]);
    expect(fs.files.has(NODE_EXE)).toBe(true);
    expect(fs.files.has(PI_CLI)).toBe(true);

    const manifest = parseManifest(new TextDecoder().decode(fs.files.get(MANIFEST)));
    expect(manifest).toEqual({
      schemaVersion: 1,
      node: { version: "24.22.0", path: NODE_EXE, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      pi: { version: "1.2.0", cliPath: PI_CLI },
      installedAt: "2026-10-16T00:00:00.000Z",
    });
    expect(manifest.node.sha256).not.toBeNull();
    // The verified archive is removed from staging once it has been extracted.
    expect([...fs.files.keys()].some((key) => key.includes(".staging"))).toBe(false);
  });

  it("runs npm with the isolated Node, no user npmrc, and a clean environment", async () => {
    const exec = createFakeExec(fs, win32);
    const fetch = createFakeFetch(responses());
    await installRuntime(
      installDeps({
        fs,
        exec,
        fetch,
        env: {
          SystemRoot: "C:\\Windows",
          TEMP: "C:\\Temp",
          HARIL_CLIPROXYAPI_KEY: "secret-key-7f",
          NPM_CONFIG_USERCONFIG: "C:\\Users\\me\\.npmrc",
          NODE_OPTIONS: "--require evil.js",
          GITHUB_TOKEN: "ghp_secret",
        },
      }),
    );

    const npm = exec.calls.find((call) => call.args.includes("install"));
    expect(npm).toBeDefined();
    expect(npm?.file).toBe(NODE_EXE);
    expect(npm?.args[0]).toMatch(/npm-cli\.js$/);
    const argv = npm?.args ?? [];
    expect(argv).toEqual(
      expect.arrayContaining([
        "install",
        "--prefix",
        "C:\\HARIL\\vendor\\pi\\1.2.0",
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--userconfig",
        "--cache",
        "@earendil-works/pi-coding-agent@1.2.0",
      ]),
    );
    const userconfig = argv[argv.indexOf("--userconfig") + 1] ?? "";
    expect(userconfig).not.toBe("");
    expect(userconfig).not.toContain("Users\\me");

    const env = npm?.options.env ?? {};
    const keys = Object.keys(env);
    expect(keys.every((key) => ["PATH", "SystemRoot", "TEMP", "TMP"].includes(key))).toBe(true);
    expect(keys.some((key) => /TOKEN|SECRET|KEY|PASSWORD|NPM_CONFIG|NODE_OPTIONS/i.test(key))).toBe(
      false,
    );
    expect(JSON.stringify(env)).not.toContain("secret-key-7f");
    expect(env.PATH?.startsWith("C:\\HARIL\\runtime\\node\\v24.22.0-win-x64;")).toBe(true);
  });

  it("skips every step on a second run without downloading or running npm", async () => {
    await installRuntime(
      installDeps({ fs, exec: createFakeExec(fs, win32), fetch: createFakeFetch(responses()) }),
    );

    const exec = createFakeExec(fs, win32);
    const fetch = createFakeFetch(responses());
    const result = await installRuntime(installDeps({ fs, exec, fetch }));

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(fetch.calls).toEqual([]);
    expect(exec.calls.some((call) => call.args.includes("install"))).toBe(false);
  });

  it("deletes the archive, fails the node step and writes nothing on a SHA-256 mismatch", async () => {
    const wrong = new TextEncoder().encode(`${"0".repeat(64)}  ${ZIP_NAME}\n`);
    const fetch = createFakeFetch({ [SHASUMS_URL]: wrong, [ARCHIVE_URL]: ZIP_BYTES });
    const exec = createFakeExec(fs, win32);
    const result = await installRuntime(installDeps({ fs, exec, fetch }));

    expect(result.ok).toBe(false);
    const [node, pi, manifest] = result.steps;
    expect(node?.status).toBe("failed");
    expect(node?.detail).toMatch(/SHA-256 mismatch/);
    expect(pi?.status).toBe("failed");
    expect(manifest?.status).toBe("failed");
    expect([...fs.files.keys()].some((key) => key.endsWith(ZIP_NAME))).toBe(false);
    expect(fs.files.has(NODE_EXE)).toBe(false);
    expect(fs.files.has(MANIFEST)).toBe(false);
    expect(exec.calls.some((call) => call.args.includes("install"))).toBe(false);
  });

  it("retries a failed download once and succeeds", async () => {
    const fetch = createFakeFetch(responses(), { [SHASUMS_URL]: 1 });
    const result = await installRuntime(
      installDeps({ fs, exec: createFakeExec(fs, win32), fetch }),
    );

    expect(result.ok).toBe(true);
    expect(fetch.calls.filter((url) => url === SHASUMS_URL)).toHaveLength(2);
  });

  it("fails after the second consecutive download failure", async () => {
    const fetch = createFakeFetch(responses(), { [ARCHIVE_URL]: 2 });
    const result = await installRuntime(
      installDeps({ fs, exec: createFakeExec(fs, win32), fetch }),
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.detail).toContain("network error");
  });

  it("reports a failed npm install and leaves no manifest", async () => {
    const exec = createFakeExec(fs, win32);
    exec.npmExitCode = 1;
    const result = await installRuntime(
      installDeps({ fs, exec, fetch: createFakeFetch(responses()) }),
    );

    expect(result.ok).toBe(false);
    expect(result.steps.map((step) => step.status)).toEqual(["ok", "failed", "failed"]);
    expect(result.steps[1]?.detail).toContain("npm install failed");
    expect(fs.files.has(MANIFEST)).toBe(false);
  });
});
