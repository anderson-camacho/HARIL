import { type FakeOpenAiServer, startFakeOpenAiServer } from "@haril/gateway/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, type HostInfo, run } from "../src/cli.js";

// `haril models` against the fake OpenAI server: env injection only, no real gateway.
const KEY = "apps-models-key-42aa";
const WRONG_KEY = "wrong-key-value-xyz";
let server: FakeOpenAiServer;

beforeEach(async () => {
  server = await startFakeOpenAiServer({
    apiKey: KEY,
    models: [{ id: "gpt-alpha", context_length: 200000, max_output_tokens: 32000 }, { id: "beta" }],
  });
});

afterEach(async () => {
  await server.close();
});

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readFile: () => {
      throw new Error("not used");
    },
  };
  return { io, out, err };
}

const host = (env: Record<string, string | undefined>): HostInfo => ({
  nodeVersion: "v24.21.0",
  platform: "linux",
  arch: "x64",
  homeDir: "/home/tester",
  env,
  gatewayTimeoutMs: 30_000,
});

describe("haril models", () => {
  it("exits 2 with a clear message when HARIL_CLIPROXYAPI_KEY is not set, without calling the gateway", async () => {
    const { io, out, err } = harness();
    expect(await run(["models"], io, host({ HARIL_GATEWAY_URL: server.baseUrl }))).toBe(2);
    expect(err.join("\n")).toContain("HARIL_CLIPROXYAPI_KEY is not set");
    expect(out).toEqual([]);
    expect(server.requests).toHaveLength(0);
  });

  it("prints a table of id, context and max output for the gateway models, exit 0", async () => {
    const { io, out } = harness();
    const code = await run(
      ["models"],
      io,
      host({ HARIL_GATEWAY_URL: server.baseUrl, HARIL_CLIPROXYAPI_KEY: KEY }),
    );
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/id\s+context\s+max-output/);
    expect(text).toMatch(/gpt-alpha\s+200000\s+32000/);
    expect(text).toMatch(/beta\s+-\s+-/);
    expect(text).not.toContain(KEY);
  });

  it("prints JSON with the gateway URL and the model descriptors, without the key", async () => {
    const { io, out, err } = harness();
    const code = await run(
      ["models", "--json"],
      io,
      host({ HARIL_GATEWAY_URL: server.baseUrl, HARIL_CLIPROXYAPI_KEY: KEY }),
    );
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n")) as {
      gateway: string;
      models: {
        providerId: string;
        id: string;
        contextWindow?: number;
        maxOutputTokens?: number;
      }[];
    };
    expect(report.gateway).toBe(server.baseUrl);
    expect(report.models).toEqual([
      {
        providerId: "openai-compatible",
        id: "beta",
      },
      {
        providerId: "openai-compatible",
        id: "gpt-alpha",
        contextWindow: 200000,
        maxOutputTokens: 32000,
      },
    ]);
    expect(out.join("\n") + err.join("\n")).not.toContain(KEY);
  });

  it("exits 2 with a hint to check the key when the gateway rejects it, without echoing it", async () => {
    const { io, out, err } = harness();
    const code = await run(
      ["models"],
      io,
      host({ HARIL_GATEWAY_URL: server.baseUrl, HARIL_CLIPROXYAPI_KEY: WRONG_KEY }),
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("rejected");
    expect(err.join("\n")).toContain("HARIL_CLIPROXYAPI_KEY");
    expect(out.join("\n") + err.join("\n")).not.toContain(WRONG_KEY);
  });

  it("exits 2 with the docker hint when the gateway is unreachable", async () => {
    const closed = await startFakeOpenAiServer({ apiKey: KEY });
    const url = closed.baseUrl;
    await closed.close();
    const { io, err } = harness();
    const code = await run(
      ["models"],
      io,
      host({ HARIL_GATEWAY_URL: url, HARIL_CLIPROXYAPI_KEY: KEY }),
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("is CLIProxyAPI running? (docker start cli-proxy-api)");
  });

  it("exits 2 when HARIL_GATEWAY_URL is not a URL", async () => {
    const { io, err } = harness();
    const code = await run(
      ["models"],
      io,
      host({ HARIL_GATEWAY_URL: "not a url", HARIL_CLIPROXYAPI_KEY: KEY }),
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("HARIL_GATEWAY_URL is not a valid URL");
  });

  it("rejects unknown options with exit 2", async () => {
    const { io, err } = harness();
    expect(await run(["models", "--verbose"], io, host({ HARIL_CLIPROXYAPI_KEY: KEY }))).toBe(2);
    expect(err.join("\n")).toContain("--verbose");
  });
});
