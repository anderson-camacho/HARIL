import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { type ToolsServices, tools } from "../src/commands/tools.js";
import type { HostInfo } from "../src/context.js";
import { emptyToolsState, type ToolsState } from "../src/tools/state.js";
import type { InstallRun, RunLimits, TailLimits } from "../src/tools/system.js";
import type { ToolsReport } from "../src/tools/types.js";
import type { ExecResult } from "../src/tools/version.js";
import { VERSION } from "../src/version.js";
import { harness, parseJson } from "./helpers.js";

// `haril tools update gentle-ai` with every process, the network, the filesystem, the clock and the terminal faked:
// nothing here runs `go`, and "installing" only adds a file to an in-memory map.

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const MODULE = "github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai";
const GO_BIN = "/home/ana/go/bin/gentle-ai";
const UPDATE_USAGE = "usage: haril tools update gentle-ai [--yes] [--json]";

const GO_OK: ExecResult = {
  code: 0,
  output: "go version go1.27.0 windows/amd64\n",
  timedOut: false,
};
const INSTALL_OK: InstallRun = { code: 0, output: "", timedOut: false };

interface Call {
  readonly kind: "exec" | "install";
  readonly file: string;
  readonly args: readonly string[];
  readonly limits: RunLimits | TailLimits | undefined;
}

interface Options {
  // Each existing gentle-ai and its version; "unreadable" is a file whose version command fails.
  files?: Record<string, string>;
  go?: ExecResult;
  install?: InstallRun;
  // The version the install leaves at the destination; null leaves nothing there.
  installs?: string | null;
  destination?: string;
  answers?: string[];
  state?: ToolsState;
  // The tag the releases/latest redirect points to; null answers 404.
  tag?: string | null;
  signal?: AbortSignal;
}

function machine(options: Options = {}) {
  const files: Record<string, string> = { ...(options.files ?? {}) };
  const calls: Call[] = [];
  const asked: string[] = [];
  const urls: string[] = [];
  const saved: ToolsState[] = [];
  const answers = [...(options.answers ?? [])];
  const destination = options.destination ?? GO_BIN;
  const tag = options.tag === undefined ? "v4.3.1" : options.tag;
  let state = options.state ?? emptyToolsState();
  const services: ToolsServices = {
    detect: {
      isFile: (path) => path in files,
      realPath: (path) => path,
      readVersion: async (path) => {
        const version = files[path];
        return version === undefined || version === "unreadable"
          ? { error: "exit 1" }
          : { version };
      },
    },
    fetch: async (url) => {
      urls.push(url);
      return tag === null
        ? { status: 404, headers: new Headers(), body: null }
        : {
            status: 302,
            headers: new Headers({ location: `https://github.com/x/tool/releases/tag/${tag}` }),
            body: null,
          };
    },
    now: () => NOW,
    readState: () => state,
    writeState: (next) => {
      saved.push(next);
      state = next;
    },
    update: {
      exec: async (file, args, limits) => {
        calls.push({ kind: "exec", file, args, limits });
        return options.go ?? GO_OK;
      },
      install: async (file, args, limits) => {
        calls.push({ kind: "install", file, args, limits });
        const result = options.install ?? INSTALL_OK;
        if (result.code === 0 && options.installs !== null) {
          files[destination] = options.installs ?? "4.3.1";
        }
        return result;
      },
      ask: async (question) => {
        asked.push(question);
        return answers.shift() ?? "";
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  };
  return { files, calls, asked, urls, saved, services, destination };
}

type Machine = ReturnType<typeof machine>;

function hostWith(env: Record<string, string> = {}, overrides: Partial<HostInfo> = {}): HostInfo {
  return {
    nodeVersion: "v24.21.0",
    platform: "linux",
    arch: "x64",
    homeDir: "/home/ana",
    interactive: true,
    env: { HARIL_RUNTIME_DIR: "/data/haril", PATH: "/usr/local/bin:/home/ana/go/bin", ...env },
    ...overrides,
  };
}

const WIN_HOST = hostWith(
  { HARIL_RUNTIME_DIR: "C:\\haril", PATH: "C:\\Windows;C:\\Users\\ana\\go\\bin" },
  { platform: "win32", homeDir: "C:\\Users\\ana" },
);
const WIN_BIN = "C:\\Users\\ana\\go\\bin\\gentle-ai.exe";

interface UpdateJson {
  schema: string;
  gentleAi: {
    action: string;
    from?: string;
    to?: string;
    path?: string;
    message?: string;
    warnings: string[];
  };
  status: ToolsReport;
}

async function update(m: Machine, args: string[] = [], host: HostInfo = hostWith()) {
  const h = harness();
  const code = await tools(["update", "gentle-ai", ...args], h.io, host, m.services);
  return { code, out: h.out, err: h.err, text: h.out.join("\n"), errText: h.err.join("\n") };
}

async function updateJson(m: Machine, args: string[] = [], host: HostInfo = hostWith()) {
  const result = await update(m, ["--json", ...args], host);
  return { ...result, json: parseJson<UpdateJson>(result.out) };
}

const installCall = (m: Machine) => m.calls.find((call) => call.kind === "install");
// The limits the install ran with; the test fails when there was no install.
function installLimits(m: Machine): TailLimits {
  const call = installCall(m);
  if (call === undefined) throw new Error("go install did not run");
  return call.limits as TailLimits;
}
const summary = (m: Machine) =>
  m.calls.map((call) => `${call.kind}:${call.file} ${call.args.join(" ")}`);

describe("haril tools update gentle-ai: the confirmation", () => {
  it("prints the plan and, when the answer is no, builds nothing", async () => {
    const m = machine({ files: { [GO_BIN]: "4.0.0" }, answers: ["n"] });
    const { code, text, err } = await update(m);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(text).toContain(`go install ${MODULE}@v4.3.1`);
    expect(text).toContain(GO_BIN);
    expect(text).toContain("4.0.0 -> 4.3.1");
    expect(text).toContain("go1.27.0");
    expect(m.asked).toEqual(["Proceed? [y/N] "]);
    expect(summary(m)).toEqual(["exec:go version"]);
    expect(text).toContain("gentle-ai: aborted");
    expect(m.files[GO_BIN]).toBe("4.0.0");
  });

  it("keeps stdout a single JSON document and writes the plan and question to stderr", async () => {
    const m = machine({ files: { [GO_BIN]: "4.0.0" }, answers: ["no"] });
    const { code, out, errText, json } = await updateJson(m);
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(json.schema).toBe("haril.tools.update/1");
    expect(json.gentleAi).toMatchObject({ action: "aborted", warnings: [] });
    expect(json.status.schema).toBe("haril.tools.status/1");
    expect(errText).toContain(`go install ${MODULE}@v4.3.1`);
    expect(summary(m)).toEqual(["exec:go version"]);
  });

  it("refuses with exit 2 when there is no terminal and no --yes, naming the command", async () => {
    const m = machine({ files: { [GO_BIN]: "4.0.0" } });
    const { code, out, errText } = await update(m, [], hostWith({}, { interactive: false }));
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(errText).toContain("confirmation required");
    expect(errText).toContain(`go install ${MODULE}@v4.3.1`);
    expect(errText).toContain("--yes");
    expect(m.asked).toEqual([]);
    expect(summary(m)).toEqual(["exec:go version"]);
    expect(m.files[GO_BIN]).toBe("4.0.0");
  });

  it("treats a host that does not say it is interactive as having no terminal", async () => {
    const m = machine({ files: { [GO_BIN]: "4.0.0" } });
    const host: HostInfo = { ...hostWith(), interactive: undefined as unknown as boolean };
    const { code } = await update(m, [], host);
    expect(code).toBe(2);
    expect(m.asked).toEqual([]);
  });

  it.each(["y", "Y", "yes", "YES", "  yes  "])("builds after the answer %j", async (answer) => {
    const m = machine({ files: { [GO_BIN]: "4.0.0" }, answers: [answer] });
    const { code, text } = await update(m);
    expect(code).toBe(0);
    expect(text).toContain("gentle-ai: updated 4.0.0 -> 4.3.1");
    expect(m.files[GO_BIN]).toBe("4.3.1");
  });

  it.each(["", "n", "no", "yep", "sure", "ok", "yes please"])(
    "aborts with exit 0 after the answer %j",
    async (answer) => {
      const m = machine({ files: { [GO_BIN]: "4.0.0" }, answers: [answer] });
      const { code, text } = await update(m);
      expect(code).toBe(0);
      expect(text).toContain("gentle-ai: aborted");
      expect(installCall(m)).toBeUndefined();
    },
  );
});

describe("haril tools update gentle-ai: what runs", () => {
  it("with --yes runs exactly go install <module>@<exact tag>, without asking", async () => {
    const m = machine({ files: { [GO_BIN]: "4.0.0" } });
    const { code } = await update(m, ["--yes"], hostWith({}, { interactive: false }));
    expect(code).toBe(0);
    expect(m.asked).toEqual([]);
    expect(summary(m)).toEqual(["exec:go version", `install:go install ${MODULE}@v4.3.1`]);
    expect(installCall(m)?.limits).toMatchObject({ timeoutMs: 600_000 });
    expect(installCall(m)?.args).not.toContain(`${MODULE}@latest`);
  });

  it("limits the version probe to 10 seconds", async () => {
    const m = machine();
    await update(m, ["--yes"]);
    expect(m.calls[0]).toMatchObject({ kind: "exec", file: "go", args: ["version"] });
    expect(m.calls[0]?.limits).toMatchObject({ timeoutMs: 10_000 });
  });

  it("takes the tag from the cached latest version without asking GitHub again", async () => {
    const fresh = new Date(NOW - 3_600_000).toISOString();
    const state: ToolsState = {
      version: 1,
      tools: {
        engram: { latest: "3.6.0", latestCheckedAt: fresh },
        "gentle-ai": { latest: "4.2.0", latestCheckedAt: fresh },
      },
    };
    const m = machine({ state, installs: "4.2.0" });
    const { json } = await updateJson(m, ["--yes"]);
    expect(m.urls).toEqual([]);
    expect(installCall(m)?.args).toEqual(["install", `${MODULE}@v4.2.0`]);
    expect(json.gentleAi).toMatchObject({ action: "installed", to: "4.2.0" });
  });

  it("asks GitHub for the latest version when the cache is due and keeps the answer", async () => {
    const m = machine();
    await update(m, ["--yes"]);
    expect(m.urls.some((url) => url.includes("/gentle-ai/"))).toBe(true);
    expect(m.saved).toHaveLength(1);
  });

  it("hands the abort signal to the install", async () => {
    const controller = new AbortController();
    const m = machine({ signal: controller.signal });
    await update(m, ["--yes"]);
    expect(installLimits(m).signal).toBe(controller.signal);
  });
});

describe("haril tools update gentle-ai: the environment", () => {
  const ENV = {
    HARIL_RUNTIME_DIR: "/data/haril",
    PATH: "/usr/local/bin:/home/ana/go/bin",
    GOFLAGS: "-mod=mod",
    GOPROXY: "https://proxy.example",
    GOSUMDB: "sum.example",
    GONOSUMDB: "example.com",
    GOMODCACHE: "/tmp/mod",
  };

  it("passes the host environment through unchanged, checksum database settings included", async () => {
    const m = machine();
    await update(m, ["--yes"], hostWith(ENV));
    expect(installLimits(m).env).toEqual(ENV);
    expect(m.calls[0]).toMatchObject({ kind: "exec", limits: { env: ENV } });
  });

  it("adds none of the Go settings that Go's checksum verification depends on", async () => {
    const m = machine();
    await update(m, ["--yes"]);
    const env = installLimits(m).env ?? {};
    for (const name of [
      "GOFLAGS",
      "GOPROXY",
      "GOSUMDB",
      "GONOSUMDB",
      "GONOSUMCHECK",
      "GOINSECURE",
    ]) {
      expect(name in env).toBe(false);
    }
  });

  it("drops only the variables that have no value", async () => {
    const m = machine();
    const env = { PATH: "/p", GOFLAGS: "-x", GONE: undefined };
    await update(m, ["--yes"], hostWith({}, { env }));
    expect(installLimits(m).env).toEqual({ PATH: "/p", GOFLAGS: "-x" });
  });
});

describe("haril tools update gentle-ai: where it lands", () => {
  it("uses GOBIN first", async () => {
    const destination = "/opt/gobin/gentle-ai";
    const m = machine({ destination });
    const { json } = await updateJson(
      m,
      ["--yes"],
      hostWith({ GOBIN: "/opt/gobin", GOPATH: "/a/gp" }),
    );
    expect(json.gentleAi.path).toBe(destination);
  });

  it("then the first GOPATH entry's bin", async () => {
    const destination = "/a/gp/bin/gentle-ai";
    const m = machine({ destination });
    const { json } = await updateJson(m, ["--yes"], hostWith({ GOPATH: "/a/gp:/b/gp" }));
    expect(json.gentleAi.path).toBe(destination);
  });

  it("then ~/go/bin", async () => {
    const m = machine();
    const { json } = await updateJson(m, ["--yes"]);
    expect(json.gentleAi.path).toBe(GO_BIN);
  });

  it("names the .exe on Windows and never runs go env to find out", async () => {
    const m = machine({ destination: WIN_BIN });
    const { json } = await updateJson(m, ["--yes"], WIN_HOST);
    expect(json.gentleAi).toMatchObject({ action: "installed", path: WIN_BIN });
    expect(m.calls.every((call) => !call.args.includes("env"))).toBe(true);
  });

  it("ignores a relative GOBIN, which Go itself rejects", async () => {
    const m = machine();
    const { json } = await updateJson(m, ["--yes"], hostWith({ GOBIN: "bin" }));
    expect(json.gentleAi.path).toBe(GO_BIN);
  });
});

describe("haril tools update gentle-ai: the outcome", () => {
  it("installs when gentle-ai is missing, and says installed, not updated", async () => {
    const m = machine();
    const { code, json } = await updateJson(m, ["--yes"]);
    expect(code).toBe(0);
    expect(json.gentleAi).toEqual({
      action: "installed",
      to: "4.3.1",
      path: GO_BIN,
      warnings: [],
    });
    expect(json.status.tools[1]).toMatchObject({ id: "gentle-ai", state: "ok" });
  });

  it("updates the active install in place and records where it came from", async () => {
    const m = machine({ files: { [GO_BIN]: "4.0.0" } });
    const { code, json } = await updateJson(m, ["--yes"]);
    expect(code).toBe(0);
    expect(json.gentleAi).toEqual({
      action: "updated",
      from: "4.0.0",
      to: "4.3.1",
      path: GO_BIN,
      warnings: [],
    });
    expect(json.status.tools[1]?.active).toMatchObject({ path: GO_BIN, version: "4.3.1" });
  });

  it("does nothing when the active install is already the latest", async () => {
    const m = machine({ files: { [GO_BIN]: "4.3.1" } });
    const { code, json } = await updateJson(m);
    expect(code).toBe(0);
    expect(json.gentleAi).toMatchObject({
      action: "none",
      to: "4.3.1",
      path: GO_BIN,
      warnings: [],
    });
    expect(json.gentleAi.message).toContain("4.3.1");
    expect(m.calls).toEqual([]);
    expect(m.asked).toEqual([]);
  });

  it("never downgrades an install that is newer than the latest known release", async () => {
    const m = machine({ files: { [GO_BIN]: "4.4.0" } });
    const { code, json } = await updateJson(m, ["--yes"]);
    expect(code).toBe(0);
    expect(json.gentleAi).toMatchObject({ action: "none", to: "4.4.0" });
    expect(m.calls).toEqual([]);
  });

  it("reports installed with a warning naming both paths when the active install is older and elsewhere", async () => {
    const OTHER = "/usr/bin/gentle-ai";
    const m = machine({ files: { [OTHER]: "4.0.0" } });
    const host = hostWith({ PATH: "/usr/bin:/home/ana/go/bin" });
    const { code, json } = await updateJson(m, ["--yes"], host);
    expect(code).toBe(0);
    expect(json.gentleAi).toMatchObject({ action: "installed", to: "4.3.1", path: GO_BIN });
    expect(json.gentleAi.warnings).toHaveLength(1);
    const [warning] = json.gentleAi.warnings;
    expect(warning).toContain(OTHER);
    expect(warning).toContain(GO_BIN);
    expect(warning).toContain("was not updated");
    expect(warning).toContain("PATH");
    // Nothing else is touched.
    expect(m.files[OTHER]).toBe("4.0.0");
  });

  it("warns that an active install whose version cannot be read was not replaced", async () => {
    const OTHER = "/usr/bin/gentle-ai";
    const m = machine({ files: { [OTHER]: "unreadable" } });
    const host = hostWith({ PATH: "/usr/bin:/home/ana/go/bin" });
    const { json } = await updateJson(m, ["--yes"], host);
    expect(json.gentleAi.action).toBe("installed");
    expect(json.gentleAi.warnings.join("\n")).toContain(OTHER);
  });

  it("warns when the new install is in a folder that is not on PATH", async () => {
    const m = machine();
    const { json } = await updateJson(m, ["--yes"], hostWith({ PATH: "/usr/local/bin" }));
    expect(json.gentleAi.action).toBe("installed");
    expect(json.gentleAi.warnings).toHaveLength(1);
    expect(json.gentleAi.warnings[0]).toContain("/home/ana/go/bin");
    expect(json.gentleAi.warnings[0]).toContain("not on PATH");
  });

  it("reinstalls when only a copy in the Go bin is current but the active one is older", async () => {
    const OTHER = "/usr/bin/gentle-ai";
    const m = machine({ files: { [OTHER]: "4.0.0", [GO_BIN]: "4.3.1" } });
    const host = hostWith({ PATH: "/usr/bin:/home/ana/go/bin" });
    const { json } = await updateJson(m, ["--yes"], host);
    expect(json.gentleAi.action).toBe("installed");
    expect(json.gentleAi.warnings[0]).toContain("was not updated");
    expect(m.files[OTHER]).toBe("4.0.0");
  });
});

describe("haril tools update gentle-ai: failures", () => {
  it("fails when the latest version is unknown and the lookup fails, running nothing", async () => {
    const m = machine({ tag: null });
    const { code, json } = await updateJson(m, ["--yes"]);
    expect(code).toBe(1);
    expect(json.gentleAi.action).toBe("failed");
    expect(json.gentleAi.message).toContain("latest gentle-ai version");
    expect(m.calls).toEqual([]);
    expect(m.asked).toEqual([]);
  });

  it("fails with an install hint when Go is not installed", async () => {
    const go: ExecResult = { code: null, output: "", timedOut: false, error: "spawn go ENOENT" };
    const m = machine({ go });
    const { code, json } = await updateJson(m, ["--yes"]);
    expect(code).toBe(1);
    expect(json.gentleAi.action).toBe("failed");
    expect(json.gentleAi.message).toContain("Go was not found");
    expect(json.gentleAi.message).toContain("https://go.dev/dl/");
    expect(installCall(m)).toBeUndefined();
  });

  it("does not ask for confirmation before it knows Go is there", async () => {
    const go: ExecResult = { code: null, output: "", timedOut: false, error: "spawn go ENOENT" };
    const m = machine({ go, answers: ["y"] });
    const { code } = await update(m);
    expect(code).toBe(1);
    expect(m.asked).toEqual([]);
  });

  it.each([
    ["a timeout", { code: null, output: "", timedOut: true }, "timed out"],
    ["a failing go version", { code: 2, output: "go: boom", timedOut: false }, "go: boom"],
    [
      "output that is not a Go version",
      { code: 0, output: "hello", timedOut: false },
      "unexpected",
    ],
  ] satisfies [string, ExecResult, string][])(
    "fails on %s from go version",
    async (_name, go, text) => {
      const m = machine({ go });
      const { code, json } = await updateJson(m, ["--yes"]);
      expect(code).toBe(1);
      expect(json.gentleAi.action).toBe("failed");
      expect(json.gentleAi.message).toContain(text);
      expect(installCall(m)).toBeUndefined();
    },
  );

  it("surfaces only the last 20 lines of a failed go install", async () => {
    const output = Array.from({ length: 30 }, (_, i) => `compile error ${i + 1}`).join("\n");
    const m = machine({ install: { code: 1, output, timedOut: false } });
    const { code, json } = await updateJson(m, ["--yes"]);
    expect(code).toBe(1);
    const message = json.gentleAi.message ?? "";
    expect(json.gentleAi.action).toBe("failed");
    expect(message).toContain("go install failed (exit 1)");
    expect(message).toContain("compile error 30");
    expect(message).toContain("compile error 11");
    expect(message).not.toContain("compile error 10");
  });

  it("surfaces a Go version problem from the install output", async () => {
    const output = "go: github.com/x/y@v4.3.1 requires go >= 1.29 (running go 1.27.0)";
    const m = machine({ install: { code: 1, output, timedOut: false } });
    const { json } = await updateJson(m, ["--yes"]);
    expect(json.gentleAi.message).toContain("requires go >= 1.29");
  });

  it.each([
    "go: moving C:\\Users\\ana\\go\\bin\\gentle-ai-4a1b.exe to C:\\Users\\ana\\go\\bin\\gentle-ai.exe: Access is denied.",
    "rename C:\\Users\\ana\\go\\bin\\gentle-ai-4a1b.exe C:\\Users\\ana\\go\\bin\\gentle-ai.exe: The process cannot access the file because it is being used by another process.",
  ])("maps %j to a running-program message", async (output) => {
    const m = machine({ install: { code: 1, output, timedOut: false }, destination: WIN_BIN });
    const { code, json } = await updateJson(m, ["--yes"], WIN_HOST);
    expect(code).toBe(1);
    expect(json.gentleAi.action).toBe("failed");
    expect(json.gentleAi.message).toContain("gentle-ai is running: close it and retry");
  });

  it("does not blame a running program for an access error elsewhere", async () => {
    const output = "mkdir C:\\Windows\\Temp\\go-build: Access is denied.";
    const m = machine({ install: { code: 1, output, timedOut: false }, destination: WIN_BIN });
    const { json } = await updateJson(m, ["--yes"], WIN_HOST);
    expect(json.gentleAi.message).not.toContain("is running");
    expect(json.gentleAi.message).toContain("Access is denied");
  });

  it("reports an install that outlives its 10 minutes", async () => {
    const m = machine({ install: { code: null, output: "building", timedOut: true } });
    const { code, json } = await updateJson(m, ["--yes"]);
    expect(code).toBe(1);
    expect(json.gentleAi.message).toContain("10 minutes");
  });

  it("reports an interrupted install", async () => {
    const m = machine({ install: { code: null, output: "", timedOut: false, aborted: true } });
    const { code, json } = await updateJson(m, ["--yes"]);
    expect(code).toBe(1);
    expect(json.gentleAi.action).toBe("failed");
    expect(json.gentleAi.message).toContain("interrupted");
  });

  it("reports a go that could not start", async () => {
    const install: InstallRun = {
      code: null,
      output: "",
      timedOut: false,
      error: "spawn go EACCES",
    };
    const m = machine({ install });
    const { code, json } = await updateJson(m, ["--yes"]);
    expect(code).toBe(1);
    expect(json.gentleAi.message).toContain("could not start go");
  });

  it("fails when the installed binary reports another version than the target", async () => {
    const m = machine({ installs: "4.3.0" });
    const { code, json } = await updateJson(m, ["--yes"]);
    expect(code).toBe(1);
    expect(json.gentleAi.action).toBe("failed");
    const message = json.gentleAi.message ?? "";
    expect(message).toContain(GO_BIN);
    expect(message).toContain("4.3.0");
    expect(message).toContain("4.3.1");
  });

  it("fails when no gentle-ai shows up where Go puts binaries", async () => {
    const m = machine({ installs: null });
    const { code, json } = await updateJson(m, ["--yes"]);
    expect(code).toBe(1);
    expect(json.gentleAi.action).toBe("failed");
    expect(json.gentleAi.message).toContain(GO_BIN);
  });

  it("records no cooldown or failure for gentle-ai, only the latest version it looked up", async () => {
    const m = machine({ install: { code: 1, output: "boom", timedOut: false } });
    const { code } = await update(m, ["--yes"]);
    expect(code).toBe(1);
    expect(m.saved).toHaveLength(1);
    const [state] = m.saved;
    expect(state?.engramInstall).toBeUndefined();
    expect(state?.tools["gentle-ai"]).toEqual({
      latest: "4.3.1",
      latestCheckedAt: new Date(NOW).toISOString(),
    });
  });
});

describe("haril tools update gentle-ai: the text output", () => {
  it("prints the action, the path and each warning", async () => {
    const m = machine();
    const { code, out } = await update(m, ["--yes"], hostWith({ PATH: "/usr/local/bin" }));
    expect(code).toBe(0);
    expect(out[0]).toBe(`haril ${VERSION} tools update`);
    expect(out[1]).toBe("gentle-ai: installed 4.3.1");
    expect(out).toContain(`  path        ${GO_BIN}`);
    expect(
      out.some((line) => line.startsWith("  warning     ") && line.includes("not on PATH")),
    ).toBe(true);
    expect(out.join("\n")).toContain("gentle-ai: ok");
    expect(out.join("\n")).not.toContain("engram");
  });

  it("prints an update as from -> to", async () => {
    const m = machine({ files: { [GO_BIN]: "4.0.0" } });
    const { out } = await update(m, ["--yes"]);
    expect(out[1]).toBe("gentle-ai: updated 4.0.0 -> 4.3.1");
  });

  it("prints that nothing was needed", async () => {
    const m = machine({ files: { [GO_BIN]: "4.3.1" } });
    const { out } = await update(m, ["--yes"]);
    expect(out[1]).toBe("gentle-ai: up to date (4.3.1)");
  });

  it("prints a failure with its message indented under it", async () => {
    const output = "first line\nsecond line";
    const m = machine({ install: { code: 1, output, timedOut: false } });
    const { code, out } = await update(m, ["--yes"]);
    expect(code).toBe(1);
    expect(out[1]).toBe("gentle-ai: failed");
    expect(out).toContain("  message     go install failed (exit 1)");
    expect(out).toContain("              first line");
    expect(out).toContain("              second line");
  });
});

describe("haril tools update gentle-ai: JSON", () => {
  it("has stable keys for each action", async () => {
    const keys = async (m: Machine) =>
      Object.keys((await updateJson(m, ["--yes"])).json.gentleAi).sort();
    expect(await keys(machine())).toEqual(["action", "path", "to", "warnings"]);
    expect(await keys(machine({ files: { [GO_BIN]: "4.0.0" } }))).toEqual([
      "action",
      "from",
      "path",
      "to",
      "warnings",
    ]);
    expect(await keys(machine({ files: { [GO_BIN]: "4.3.1" } }))).toEqual([
      "action",
      "message",
      "path",
      "to",
      "warnings",
    ]);
    expect(await keys(machine({ tag: null }))).toEqual(["action", "message", "warnings"]);
  });
});

describe("haril tools update: usage", () => {
  it.each([
    ["no tool", ["update"]],
    ["engram, which ensure handles", ["update", "engram"]],
    ["an unknown tool", ["update", "bogus"]],
    ["extra arguments", ["update", "gentle-ai", "extra"]],
  ])("refuses %s with exit 2 and runs nothing", async (_name, args) => {
    const m = machine();
    const h = harness();
    const code = await tools(args, h.io, hostWith(), m.services);
    expect(code).toBe(2);
    expect(h.err).toEqual([UPDATE_USAGE]);
    expect(h.out).toEqual([]);
    expect(m.calls).toEqual([]);
    expect(m.urls).toEqual([]);
  });

  it("refuses an unknown option", async () => {
    const m = machine();
    const { code, err } = await update(m, ["--force"]);
    expect(code).toBe(2);
    expect(err).toEqual(['haril: unknown option "--force"']);
    expect(m.calls).toEqual([]);
  });

  it("is reachable through the CLI dispatcher", async () => {
    const h = harness();
    const code = await run(["tools", "update"], h.io, hostWith());
    expect(code).toBe(2);
    expect(h.err).toEqual([UPDATE_USAGE]);
  });
});

describe("haril tools ensure gentle-ai stays detect-only", () => {
  it("never runs Go and never installs", async () => {
    const m = machine({ files: { [GO_BIN]: "4.0.0" } });
    const h = harness();
    const code = await tools(["ensure", "gentle-ai", "--json"], h.io, hostWith(), m.services);
    expect(code).toBe(0);
    const json = parseJson<{ gentleAi: { action: string; message: string } }>(h.out);
    expect(json.gentleAi.action).toBe("none");
    expect(json.gentleAi.message).toContain("does not install it");
    expect(m.calls).toEqual([]);
    expect(m.files[GO_BIN]).toBe("4.0.0");
  });
});
