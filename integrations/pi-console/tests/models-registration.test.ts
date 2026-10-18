import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchModelDetails, registerHarilModels } from "../src/models.js";
import type {
  ConsoleContext,
  ConsolePi,
  PiModel,
  ProviderConfig,
  ProviderModelConfig,
} from "../src/pi-types.js";

// HARIL registers each gateway model in Pi with `reasoning` and `thinkingLevelMap`, read from the gateway's
// `?client_version=` listing, so Pi's /thinking, Shift+Tab and selector offer the model's real levels. A fake
// OpenAI-compatible server on an ephemeral 127.0.0.1 port plays the gateway; a fake Pi records the registration.

const KEY_ENV = "HARIL_FAKE_GATEWAY_ENV";
const CREDENTIAL = "fake-key";

type Mode = "detailed" | "html" | "error" | "redirect" | "silent";

let server: Server;
let base: string;
let mode: Mode;
let requests: { url: string; authorization: string | undefined }[];

const DETAILED_LISTING = {
  models: [
    {
      slug: "Gemini1/gemini-3-flash",
      context_window: 1_048_576,
      max_tokens: 65_536,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "minimal" },
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
      ],
    },
    { slug: "Gemini1/claude-sonnet-4-6", context_window: 200_000, max_tokens: 64_000 },
  ],
};

function respond(request: IncomingMessage, response: ServerResponse): void {
  requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
  if (mode === "silent") return;
  if (mode === "redirect") {
    response.writeHead(302, { location: "/elsewhere" }).end();
    return;
  }
  if (mode === "error") {
    response.writeHead(500, { "content-type": "application/json" }).end('{"error":"fake"}');
    return;
  }
  if (mode === "html") {
    response.writeHead(200, { "content-type": "text/html" }).end("<html>fake</html>");
    return;
  }
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(DETAILED_LISTING));
}

beforeAll(async () => {
  server = createServer(respond);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mode = "detailed";
  requests = [];
  process.env[KEY_ENV] = CREDENTIAL;
});

afterEach(() => {
  delete process.env[KEY_ENV];
});

const CATALOG: PiModel[] = [
  {
    provider: "google",
    id: "gemini-3-flash-preview",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" },
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  { provider: "openai", id: "gpt-5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
];

function fakes(): {
  pi: ConsolePi;
  ctx: ConsoleContext;
  registered: Map<string, ProviderConfig>;
} {
  const registered = new Map<string, ProviderConfig>();
  const pi = {
    registerProvider(name: string, config: ProviderConfig) {
      registered.set(name, config);
    },
  } as unknown as ConsolePi;
  const ctx = { modelRegistry: { getAll: () => CATALOG } } as unknown as ConsoleContext;
  return { pi, ctx, registered };
}

function listing(url: string): () => Promise<unknown> {
  return async () => ({
    providers: [{ id: "fake-gw", url, keyEnv: KEY_ENV, status: "ok", detail: "" }],
    models: [
      { providerId: "fake-gw", id: "Gemini1/gemini-3-flash" },
      { providerId: "fake-gw", id: "Gemini1/claude-sonnet-4-6" },
      { providerId: "fake-gw", id: "gpt-5" },
    ],
  });
}

function model(config: ProviderConfig | undefined, id: string): ProviderModelConfig {
  const found = config?.models.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`${id} was not registered`);
  return found;
}

describe("registerHarilModels with the gateway listing", () => {
  it("registers each model's reasoning, level map and real limits, and sends the key", async () => {
    const { pi, ctx, registered } = fakes();
    const registration = await registerHarilModels(pi, ctx, { listing: listing(base) });
    const config = registered.get("haril-fake-gw");
    expect(config?.api).toBe("openai-completions");
    expect(config?.apiKey).toBe(`\${${KEY_ENV}}`);

    const gemini = model(config, "Gemini1/gemini-3-flash");
    expect(gemini.reasoning).toBe(true);
    expect(gemini.thinkingLevelMap).toEqual({
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(gemini.contextWindow).toBe(1_048_576);
    expect(gemini.maxTokens).toBe(65_536);
    expect(gemini.input).toEqual(["text", "image"]);

    const claude = model(config, "Gemini1/claude-sonnet-4-6");
    expect(claude.reasoning).toBe(false);
    expect(claude.thinkingLevelMap).toBeUndefined();
    expect(claude.contextWindow).toBe(200_000);
    expect(claude.maxTokens).toBe(64_000);

    // Not in the gateway listing: Pi's catalog decides.
    const gpt = model(config, "gpt-5");
    expect(gpt.reasoning).toBe(true);
    expect(gpt.thinkingLevelMap).toEqual({ xhigh: "xhigh" });

    expect(registration.defaultLevels.get("haril-fake-gw/Gemini1/gemini-3-flash")).toBe("medium");
    expect(registration.defaultLevels.has("haril-fake-gw/Gemini1/claude-sonnet-4-6")).toBe(false);
    expect(registration.notes).toEqual([]);
    expect(requests).toEqual([
      { url: "/v1/models?client_version=0.99.0", authorization: `Bearer ${CREDENTIAL}` },
    ]);
  });

  for (const failure of ["html", "error", "redirect"] as const) {
    it(`degrades to Pi's catalog when the listing answers ${failure}`, async () => {
      mode = failure;
      const { pi, ctx, registered } = fakes();
      const registration = await registerHarilModels(pi, ctx, { listing: listing(base) });
      const config = registered.get("haril-fake-gw");
      const gemini = model(config, "Gemini1/gemini-3-flash");
      expect(gemini.reasoning).toBe(true);
      expect(gemini.thinkingLevelMap).toEqual(CATALOG[0]?.thinkingLevelMap);
      const claude = model(config, "Gemini1/claude-sonnet-4-6");
      expect(claude.reasoning).toBe(false);
      expect(claude.contextWindow).toBe(128_000);
      expect(registration.defaultLevels.size).toBe(0);
      expect(registration.notes).toEqual([
        "HARIL provider fake-gw: its model details did not load, so reasoning levels come from Pi's catalog",
      ]);
    });
  }

  it("degrades when the gateway is unreachable", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const { pi, ctx, registered } = fakes();
    const registration = await registerHarilModels(pi, ctx, {
      listing: listing(`http://127.0.0.1:${port}/v1`),
    });
    expect(model(registered.get("haril-fake-gw"), "gpt-5").reasoning).toBe(true);
    expect(registration.notes).toHaveLength(1);
  });

  it("keeps today's behavior when haril models gives no listing", async () => {
    const { pi, ctx, registered } = fakes();
    const registration = await registerHarilModels(pi, ctx, { listing: async () => undefined });
    expect(registered.size).toBe(0);
    expect(registration.defaultLevels.size).toBe(0);
    expect(registration.notes).toEqual(["HARIL models unavailable: see haril models"]);
  });
});

describe("fetchModelDetails", () => {
  it("parses the listing and sends no authorization without a key", async () => {
    const details = await fetchModelDetails(`${base}/`, undefined);
    expect(details?.get("Gemini1/gemini-3-flash")?.levels).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(requests[0]?.authorization).toBeUndefined();
  });

  it("gives up after its timeout", async () => {
    mode = "silent";
    const started = Date.now();
    expect(await fetchModelDetails(base, CREDENTIAL, 100)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("never follows a redirect with the key", async () => {
    mode = "redirect";
    expect(await fetchModelDetails(base, CREDENTIAL)).toBeUndefined();
    expect(requests.map((request) => request.url)).toEqual(["/v1/models?client_version=0.99.0"]);
  });
});
