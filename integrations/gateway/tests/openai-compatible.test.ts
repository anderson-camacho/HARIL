import { sealSecret } from "@haril/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type ChatEvent, createOpenAiCompatibleClient, ProviderError } from "../src/index.js";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "../src/testing/index.js";

const KEY = "gw-test-key-7f3c9e21";
const MESSAGES = [{ role: "user" as const, content: "say hello" }];
let server: FakeOpenAiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(completion: Parameters<typeof startFakeOpenAiServer>[0]["completion"] = {}) {
  server = await startFakeOpenAiServer({ apiKey: KEY, models: ["beta", "alpha"], completion });
  return server;
}

function clientFor(baseUrl: string, extra: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  return createOpenAiCompatibleClient({
    baseUrl,
    credential: sealSecret(KEY),
    timeoutMs: extra.timeoutMs ?? 2000,
    ...(extra.fetch === undefined ? {} : { fetch: extra.fetch }),
  });
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function failure(promise: AsyncIterable<ChatEvent> | Promise<unknown>): Promise<unknown> {
  try {
    if (Symbol.asyncIterator in promise) await collect(promise as AsyncIterable<ChatEvent>);
    else await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

// Serves the bytes in the given pieces, so the parser sees the same stream split anywhere.
function fetchFromPieces(pieces: Uint8Array[], status = 200): typeof fetch {
  return async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      },
    });
    return new Response(stream, {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

const SSE_BODY = [
  'data: {"choices":[{"index":0,"delta":{"content":"Hé"},"finish_reason":null}]}\r\n\r\n',
  ": keep-alive comment\n\n",
  'data: {"choices":[{"index":0,"delta":{"content":"llo 🌍"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":2}}}\n\n',
  "data: [DONE]\n\n",
].join("");

const EXPECTED_SSE_EVENTS: ChatEvent[] = [
  { type: "text", delta: "Hé" },
  { type: "text", delta: "llo 🌍" },
  {
    type: "done",
    finishReason: "stop",
    usage: {
      schemaVersion: 1,
      inputTokens: 11,
      outputTokens: 4,
      cachedInputTokens: 2,
      reasoningTokens: null,
    },
  },
];

describe("listModels", () => {
  it("maps /v1/models to ModelDescriptor values, sorted by id, with the client's provider id", async () => {
    const started = await start();
    const models = await clientFor(started.baseUrl).listModels();
    expect(models.map((model) => model.id)).toEqual(["alpha", "beta"]);
    expect(models[0]).toEqual({ providerId: "openai-compatible", id: "alpha" });
  });

  it("sends the bearer key on the request", async () => {
    const started = await start();
    await clientFor(started.baseUrl).listModels();
    expect(started.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("reveals the sealed credential only for the header: no request, error or option shows it otherwise", async () => {
    const started = await start();
    const options = { baseUrl: started.baseUrl, credential: sealSecret(KEY), timeoutMs: 2000 };
    await createOpenAiCompatibleClient(options).listModels();
    const request = started.requests[0];
    expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify({ ...request, headers: {} })).not.toContain(KEY);
    expect(JSON.stringify(options)).not.toContain(KEY);
    const wrong = createOpenAiCompatibleClient({
      ...options,
      credential: sealSecret("fake-wrong"),
    });
    const error = await failure(wrong.listModels());
    expect((error as ProviderError).code).toBe("auth");
    expect(String(error)).not.toContain("fake-wrong");
  });

  it("sends no Authorization header without a credential", async () => {
    server = await startFakeOpenAiServer({ apiKey: null, models: ["alpha"] });
    await createOpenAiCompatibleClient({ baseUrl: server.baseUrl, timeoutMs: 2000 }).listModels();
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });
});

describe("chat streaming", () => {
  it("yields text deltas, then one done event with usage and finishReason", async () => {
    const started = await start({
      textChunks: ["Hel", "lo"],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    });
    const events = await collect(
      clientFor(started.baseUrl).chat({ model: "alpha", messages: MESSAGES, maxTokens: 64 }),
    );
    expect(events).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      {
        type: "done",
        finishReason: "stop",
        usage: {
          schemaVersion: 1,
          inputTokens: 7,
          outputTokens: 2,
          cachedInputTokens: null,
          reasoningTokens: null,
        },
      },
    ]);
  });

  it("sends the OpenAI request shape with include_usage and the bearer key", async () => {
    const started = await start({
      textChunks: ["x"],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await collect(
      clientFor(started.baseUrl).chat({ model: "alpha", messages: MESSAGES, maxTokens: 64 }),
    );
    const request = started.requests.at(-1);
    expect(request?.path).toBe("/v1/chat/completions");
    expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request?.body).toMatchObject({
      model: "alpha",
      messages: MESSAGES,
      max_tokens: 64,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("reports usage: null when the stream carries no usage chunk (never zeros)", async () => {
    const started = await start({ textChunks: ["x"], usage: null });
    const events = await collect(
      clientFor(started.baseUrl).chat({ model: "alpha", messages: MESSAGES, maxTokens: 8 }),
    );
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop", usage: null });
  });

  it("parses the same events when the SSE bytes are split at every byte boundary", async () => {
    const bytes = new TextEncoder().encode(SSE_BODY);
    for (let cut = 1; cut < bytes.length; cut++) {
      const pieces = [bytes.slice(0, cut), bytes.slice(cut)];
      const events = await collect(
        createOpenAiCompatibleClient({
          baseUrl: "http://127.0.0.1:9/v1",
          credential: sealSecret(KEY),
          timeoutMs: 1000,
          fetch: fetchFromPieces(pieces),
        }).chat({ model: "alpha", messages: MESSAGES, maxTokens: 8 }),
      );
      expect(events, `cut at byte ${cut}`).toEqual(EXPECTED_SSE_EVENTS);
    }
  });

  it("parses the same events when the bytes arrive one at a time", async () => {
    const bytes = new TextEncoder().encode(SSE_BODY);
    const pieces = Array.from(bytes, (byte) => new Uint8Array([byte]));
    const events = await collect(
      createOpenAiCompatibleClient({
        baseUrl: "http://127.0.0.1:9/v1",
        credential: sealSecret(KEY),
        timeoutMs: 1000,
        fetch: fetchFromPieces(pieces),
      }).chat({ model: "alpha", messages: MESSAGES, maxTokens: 8 }),
    );
    expect(events).toEqual(EXPECTED_SSE_EVENTS);
  });

  it("raises upstream_stream_error for an error object received mid-stream with HTTP 200", async () => {
    const started = await start({
      textChunks: ["a", "b"],
      errorAfterChunks: { message: "upstream exploded" },
    });
    const seen: ChatEvent[] = [];
    const error = await failure(
      (async function* () {
        for await (const event of clientFor(started.baseUrl).chat({
          model: "alpha",
          messages: MESSAGES,
          maxTokens: 8,
        })) {
          seen.push(event);
          yield event;
        }
      })(),
    );
    expect(seen).toEqual([
      { type: "text", delta: "a" },
      { type: "text", delta: "b" },
    ]);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("upstream_stream_error");
    expect((error as ProviderError).message).toContain("upstream exploded");
  });

  it("treats a stream that ends before finish or [DONE] as upstream_stream_error", async () => {
    const body =
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
    const error = await failure(
      createOpenAiCompatibleClient({
        baseUrl: "http://127.0.0.1:9/v1",
        credential: sealSecret(KEY),
        timeoutMs: 1000,
        fetch: fetchFromPieces([new TextEncoder().encode(body)]),
      }).chat({ model: "alpha", messages: MESSAGES, maxTokens: 8 }),
    );
    expect((error as ProviderError).code).toBe("upstream_stream_error");
  });
});

describe("HTTP error mapping", () => {
  const cases: [number, string, Record<string, string> | undefined][] = [
    [401, "auth", undefined],
    [403, "auth", undefined],
    [402, "quota", undefined],
    [429, "rate_limited", { "retry-after": "7" }],
    [500, "upstream", undefined],
    [503, "upstream", undefined],
  ];

  it.each(cases)("maps HTTP %i to %s", async (status, code, headers) => {
    const started = await start({
      status,
      ...(headers === undefined ? {} : { headers }),
      body: { error: { message: "nope" } },
    });
    const error = await failure(
      clientFor(started.baseUrl).chat({ model: "alpha", messages: MESSAGES, maxTokens: 8 }),
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe(code);
    expect((error as ProviderError).httpStatus).toBe(status);
  });

  it("reads Retry-After in seconds into retryAfterMs on 429", async () => {
    const started = await start({ status: 429, headers: { "retry-after": "7" }, body: {} });
    const error = (await failure(
      clientFor(started.baseUrl).chat({ model: "alpha", messages: MESSAGES, maxTokens: 8 }),
    )) as ProviderError;
    expect(error.retryAfterMs).toBe(7000);
  });

  it("maps a refused connection to unreachable", async () => {
    const started = await start();
    const url = started.baseUrl;
    await started.close();
    server = undefined;
    const error = await failure(clientFor(url).listModels());
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("unreachable");
  });

  it("maps a stalled response past timeoutMs to unreachable", async () => {
    const started = await start({ delayMs: 400, textChunks: ["late"] });
    const error = await failure(
      clientFor(started.baseUrl, { timeoutMs: 100 }).chat({
        model: "alpha",
        messages: MESSAGES,
        maxTokens: 8,
      }),
    );
    expect((error as ProviderError).code).toBe("unreachable");
  });

  it("never puts the key in an error message, its string form or its JSON", async () => {
    const started = await start({ status: 401, body: { error: { message: "bad" } } });
    const error = (await failure(
      clientFor(started.baseUrl).chat({ model: "alpha", messages: MESSAGES, maxTokens: 8 }),
    )) as ProviderError;
    expect(error.message).not.toContain(KEY);
    expect(String(error)).not.toContain(KEY);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(KEY);
  });

  it("redacts the key if the upstream echoes it back in a mid-stream error", async () => {
    const started = await start({ textChunks: [], errorAfterChunks: { message: `echo ${KEY}` } });
    const error = (await failure(
      clientFor(started.baseUrl).chat({ model: "alpha", messages: MESSAGES, maxTokens: 8 }),
    )) as ProviderError;
    expect(error.code).toBe("upstream_stream_error");
    expect(error.message).not.toContain(KEY);
  });
});

// A key whose every encoding differs: base64 gives "+" and "/", base64url "-" and "_", and URL encoding escapes the
// quote, the backslash and the question mark.
const ECHO_VALUE = String.raw`fake-"canary"\run~ab?`;
const ECHO_FORMS: readonly (readonly [string, string])[] = [
  ["in clear", ECHO_VALUE],
  ["in base64", Buffer.from(ECHO_VALUE).toString("base64")],
  ["in base64url", Buffer.from(ECHO_VALUE).toString("base64url")],
  ["URL-encoded", encodeURIComponent(ECHO_VALUE)],
];

function replying(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function echoClient(fetchImpl: typeof fetch) {
  return createOpenAiCompatibleClient({
    baseUrl: "http://127.0.0.1:9/v1",
    credential: sealSecret(ECHO_VALUE),
    timeoutMs: 1000,
    fetch: fetchImpl,
  });
}

describe("redaction of a key the upstream echoes back", () => {
  it("covers four distinct forms of the echo", () => {
    expect(new Set(ECHO_FORMS.map(([, form]) => form)).size).toBe(ECHO_FORMS.length);
  });

  const httpCases = [500, 402, 429].flatMap((status) =>
    ECHO_FORMS.map(([how, form]) => [status, how, form] as const),
  );
  it.each(httpCases)(
    "redacts an HTTP %i error body that echoes the key %s, for chat and for the catalog",
    async (status, _how, form) => {
      const body = { error: { message: `bad credential ${form} here` } };
      const calls = [
        () =>
          echoClient(replying(status, body)).chat({
            model: "alpha",
            messages: MESSAGES,
            maxTokens: 8,
          }),
        () => echoClient(replying(status, body)).listModels(),
      ];
      for (const call of calls) {
        const error = (await failure(call())) as ProviderError;
        expect(error).toBeInstanceOf(ProviderError);
        expect(error.message).toContain("bad credential [redacted] here");
        for (const [, shown] of ECHO_FORMS) expect(String(error)).not.toContain(shown);
      }
    },
  );

  it.each(ECHO_FORMS)("redacts a mid-stream error that echoes the key %s", async (_how, form) => {
    const sse = `data: ${JSON.stringify({ error: { message: `echo ${form}` } })}\n\n`;
    const error = (await failure(
      echoClient(fetchFromPieces([new TextEncoder().encode(sse)])).chat({
        model: "alpha",
        messages: MESSAGES,
        maxTokens: 8,
      }),
    )) as ProviderError;
    expect(error.code).toBe("upstream_stream_error");
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(form);
  });
});

describe("cancellation", () => {
  it("stops the stream when the caller aborts and yields no done event", async () => {
    const started = await start({ delayMs: 200, textChunks: ["a", "b", "c"] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const seen: ChatEvent[] = [];
    const error = await failure(
      (async function* () {
        for await (const event of clientFor(started.baseUrl, { timeoutMs: 5000 }).chat({
          model: "alpha",
          messages: MESSAGES,
          maxTokens: 8,
          signal: controller.signal,
        })) {
          seen.push(event);
          yield event;
        }
      })(),
    );
    expect(error).toBeDefined();
    expect(seen.some((event) => event.type === "done")).toBe(false);
  });
});
