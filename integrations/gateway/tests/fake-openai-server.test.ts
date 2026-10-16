import { afterEach, describe, expect, it } from "vitest";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "../src/testing/index.js";

const KEY = "fake-key-test-1234";
const BASE = (server: FakeOpenAiServer) => server.baseUrl;
let server: FakeOpenAiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("fake OpenAI server", () => {
  it("serves the configured models on GET /v1/models when the bearer key matches", async () => {
    server = await startFakeOpenAiServer({ apiKey: KEY, models: ["alpha", "beta"] });
    const response = await fetch(`${BASE(server)}/models`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; data: { id: string }[] };
    expect(body.object).toBe("list");
    expect(body.data.map((model) => model.id)).toEqual(["alpha", "beta"]);
  });

  it("answers 401 without a key or with a wrong key, on both routes", async () => {
    server = await startFakeOpenAiServer({ apiKey: KEY, models: ["alpha"] });
    const none = await fetch(`${BASE(server)}/models`);
    expect(none.status).toBe(401);
    const wrong = await fetch(`${BASE(server)}/models`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    const chat = await fetch(`${BASE(server)}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "alpha", messages: [], stream: true }),
    });
    expect(chat.status).toBe(401);
  });

  it("streams scripted text, a finish chunk, a usage chunk with choices [] and [DONE]", async () => {
    server = await startFakeOpenAiServer({
      apiKey: KEY,
      models: ["alpha"],
      completion: {
        textChunks: ["Hel", "lo"],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      },
    });
    const response = await fetch(`${BASE(server)}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: "alpha", messages: [], stream: true }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const payloads = text
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .map((block) => block.slice("data: ".length));
    expect(payloads.at(-1)).toBe("[DONE]");
    const chunks = payloads
      .slice(0, -1)
      .map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(chunks.map((chunk) => (chunk.choices as unknown[]).length)).toEqual([1, 1, 1, 0]);
    expect(chunks[3]).toMatchObject({ usage: { prompt_tokens: 7, completion_tokens: 2 } });
  });

  it("omits the usage chunk when the script says usage null", async () => {
    server = await startFakeOpenAiServer({
      apiKey: KEY,
      completion: { textChunks: ["x"], usage: null },
    });
    const text = await (
      await fetch(`${BASE(server)}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}` },
        body: "{}",
      })
    ).text();
    expect(text).not.toContain('"usage"');
  });

  it("emits a mid-stream error object after the scripted text, with HTTP 200", async () => {
    server = await startFakeOpenAiServer({
      apiKey: KEY,
      completion: { textChunks: ["a"], errorAfterChunks: { message: "boom" } },
    });
    const response = await fetch(`${BASE(server)}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}` },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"error"');
    expect(text).toContain("boom");
    expect(text).not.toContain("[DONE]");
  });

  it("returns the scripted HTTP status and headers for a non-streaming failure", async () => {
    server = await startFakeOpenAiServer({
      apiKey: KEY,
      completion: {
        status: 429,
        headers: { "retry-after": "7" },
        body: { error: { message: "slow down" } },
      },
    });
    const response = await fetch(`${BASE(server)}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}` },
      body: "{}",
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.json()).toEqual({ error: { message: "slow down" } });
  });

  it("records each request with its method, path, headers and parsed body", async () => {
    server = await startFakeOpenAiServer({ apiKey: KEY, models: ["alpha"] });
    await fetch(`${BASE(server)}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
    await fetch(`${BASE(server)}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "alpha", stream: true }),
    });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toMatchObject({ method: "GET", path: "/v1/models" });
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(server.requests[1]).toMatchObject({
      method: "POST",
      path: "/v1/chat/completions",
      body: { model: "alpha", stream: true },
    });
    server.clearRequests();
    expect(server.requests).toHaveLength(0);
  });

  it("closes the listening socket on close()", async () => {
    const started = await startFakeOpenAiServer({ apiKey: KEY });
    const url = started.baseUrl;
    await started.close();
    await expect(fetch(`${url}/models`)).rejects.toThrow();
  });
});
