import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitFor, withoutHarilEnv, writeFakePiWrapper } from "../lib/e2e-harness.mjs";
import { startUpstream } from "../lib/fake-upstream.mjs";

// Helpers of the hermetic e2e scripts (LD-T7b). The values below are fixtures, not keys.

const FAKE_SECRET = "fake-secret-fixture";

test("withoutHarilEnv drops every HARIL_* variable by name, in any case, then adds the given ones", () => {
  const env = withoutHarilEnv(
    {
      PATH: "C:\\Tools",
      HARIL_CLIPROXYAPI_KEY: FAKE_SECRET,
      haril_default_model: "fixture model",
      Haril_Config: "fixture path",
      NOT_HARIL_X: "kept",
    },
    { HARIL_HOME: "C:\\temp\\home" },
  );
  assert.deepEqual(env, {
    PATH: "C:\\Tools",
    NOT_HARIL_X: "kept",
    HARIL_HOME: "C:\\temp\\home",
  });
});

test("waitFor returns the first truthy value and names what it waited for on a timeout", async () => {
  let calls = 0;
  const value = await waitFor(() => (++calls >= 2 ? "ready" : undefined), 5_000, "two calls");
  assert.equal(value, "ready");
  await assert.rejects(
    waitFor(() => false, 0, "nothing"),
    /timed out waiting for nothing/,
  );
});

test("writeFakePiWrapper selects the scenario and its environment, then imports fake-pi.mjs", () => {
  const dir = mkdtempSync(join(tmpdir(), "haril-harness-test-"));
  try {
    const path = writeFakePiWrapper(join(dir, "pi.mjs"), "ok", { FAKE_PI_READ_PATH: "a.txt" });
    const text = readFileSync(path, "utf8");
    assert.match(text, /^process\.env\["FAKE_PI_SCENARIO"\] = "ok";$/m);
    assert.match(text, /^process\.env\["FAKE_PI_READ_PATH"\] = "a\.txt";$/m);
    assert.match(
      text,
      /^await import\("file:.*\/integrations\/agent-pi\/testing\/fake-pi\.mjs"\);$/m,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fake upstream checks the bearer value and serves only its model", async () => {
  const upstream = await startUpstream({ key: FAKE_SECRET, model: "fixture-model" });
  try {
    const url = `http://127.0.0.1:${upstream.port}/v1`;
    const chat = (bearer, model) =>
      fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true, messages: [] }),
      });
    assert.equal((await chat("wrong", "fixture-model")).status, 401);
    const other = await chat(FAKE_SECRET, "other-model");
    assert.equal(other.status, 404);
    assert.equal((await other.json()).error.type, "model_not_found");
    const served = await chat(FAKE_SECRET, "fixture-model");
    assert.equal(served.status, 200);
    const body = await served.text();
    assert.match(body, /"content":"Hello "/);
    assert.match(body, /data: \[DONE\]/);
  } finally {
    await upstream.close();
  }
});
