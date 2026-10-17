// Hermetic OpenAI-compatible servers on loopback for the e2e scripts (M2, criterion 6, LD-T7b). Each runs in a worker
// thread, because the steps block on spawnSync and would starve a server on the main thread. This file is also the
// worker: loaded as one, it serves the role named in its workerData.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const UPSTREAM_ROLE = "fake-upstream";
const CATALOG_ROLE = "fake-catalog";
const REPLY_CHUNKS = ["Hello ", "from the e2e model."];
const WORKER_START_TIMEOUT_MS = 10_000;

// The text of every ordinary streamed reply.
export const FAKE_UPSTREAM_REPLY = REPLY_CHUNKS.join("");

// Starts one worker and settles once: with its port when it listens, or with a clear refusal when it fails, exits or
// stays silent before listening, so a broken server never hangs a script.
function startWorker(data) {
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: data });
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = () => {
      const first = !settled;
      settled = true;
      clearTimeout(timer);
      return first;
    };
    const fail = (why) => {
      if (!settle()) return;
      void worker.terminate();
      reject(new Error(`the ${data.role} worker ${why}`));
    };
    const timer = setTimeout(
      () => fail(`did not listen within ${WORKER_START_TIMEOUT_MS} ms`),
      WORKER_START_TIMEOUT_MS,
    );
    worker.once("message", (port) => {
      if (settle()) resolve({ port, close: () => worker.terminate() });
    });
    worker.once("error", (error) => fail(`failed before it listened: ${error.message}`));
    worker.once("exit", (code) => fail(`exited with code ${code} before it listened`));
  });
}

// One streamed reply with usage for the model it lists, behind the bearer key it checks. A request whose body holds
// longMarker gets longChunks chunks instead: a reply longer than any token cap, which the Broker must cut.
export function startUpstream({ key, model, longMarker, longChunks }) {
  return startWorker({ role: UPSTREAM_ROLE, key, model, longMarker, longChunks });
}

// A keyless catalog: GET /v1/models only (criterion 6).
export async function startCatalogServer(modelIds) {
  const { port, close } = await startWorker({ role: CATALOG_ROLE, models: modelIds });
  return { url: `http://127.0.0.1:${port}/v1`, close };
}

function sendError(response, status, type, message) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { type, message } }));
}

function serveCatalog(modelIds) {
  if (!Array.isArray(modelIds)) throw new Error("the fake catalog needs a list of model ids");
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ object: "list", data: modelIds.map((id) => ({ id, object: "model" })) }),
      );
      return;
    }
    sendError(response, 404, "not_found", "no route");
  });
  server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
  parentPort.on("message", () => server.close());
}

function serveUpstream({ key, model, longMarker, longChunks }) {
  if (typeof key !== "string" || key === "" || typeof model !== "string" || model === "") {
    throw new Error("the fake upstream needs a key and a model");
  }
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${key}`) {
      sendError(response, 401, "auth", "bad key");
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      sendError(response, 404, "not_found", "no route");
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      // Only the listed model is served, so a completed reply proves which model the request named.
      let requested;
      try {
        requested = JSON.parse(body).model;
      } catch {
        requested = undefined;
      }
      if (requested !== model) {
        sendError(response, 404, "model_not_found", "this upstream serves one model");
        return;
      }
      const base = {
        id: "chatcmpl-e2e",
        object: "chat.completion.chunk",
        created: 0,
        model,
      };
      const send = (choices, extra = {}) =>
        response.write(`data: ${JSON.stringify({ ...base, choices, ...extra })}\n\n`);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunks =
        longMarker !== undefined && body.includes(longMarker)
          ? Array.from({ length: longChunks }, () => "long ")
          : REPLY_CHUNKS;
      for (const content of chunks) {
        send([{ index: 0, delta: { content }, finish_reason: null }]);
      }
      send([{ index: 0, delta: {}, finish_reason: "stop" }]);
      send([], { usage: { prompt_tokens: 12, completion_tokens: 5 } });
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
  parentPort.on("message", () => server.close());
}

if (!isMainThread && workerData?.role === UPSTREAM_ROLE) serveUpstream(workerData);
if (!isMainThread && workerData?.role === CATALOG_ROLE) serveCatalog(workerData.models);
