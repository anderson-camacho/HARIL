import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidModelDescriptor } from "@haril/contracts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "@haril/gateway/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { harness, makeSandbox, parseJson, type Sandbox } from "./helpers.js";

// `haril models` (M3-T7, ACE-06) against two fake OpenAI servers with different catalogs: "alpha" needs a key
// (through keyEnv), "beta" is keyless. Every request stays on 127.0.0.1; nothing calls the network.
const ALPHA_KEY = "alpha-test-key-0123456789";
const WRONG_KEY = "wrong-key-value-xyz";
const ALPHA_ENV = "HARIL_TEST_ALPHA_KEY";

let sb: Sandbox;
let alpha: FakeOpenAiServer;
let beta: FakeOpenAiServer;

beforeEach(async () => {
  sb = makeSandbox();
  alpha = await startFakeOpenAiServer({
    apiKey: ALPHA_KEY,
    models: [{ id: "gpt-alpha", context_length: 200000, max_output_tokens: 32000 }, "shared-model"],
  });
  beta = await startFakeOpenAiServer({ apiKey: null, models: ["beta-model", "shared-model"] });
});

afterEach(async () => {
  await alpha.close();
  await beta.close();
  sb.cleanup();
});

// A config file in the sandbox that points the providers at the two fake servers.
let configCount = 0;
function useConfig(providers: unknown[]): string {
  configCount += 1;
  const path = join(sb.root, `haril-${configCount}.json`);
  writeFileSync(path, JSON.stringify({ providers }));
  return path;
}

function providersHost(extra: Record<string, string | undefined> = {}) {
  return {
    ...sb.host,
    env: {
      ...sb.host.env,
      HARIL_CONFIG: useConfig([
        { id: "alpha", baseUrl: alpha.baseUrl, keyEnv: ALPHA_ENV },
        { id: "beta", baseUrl: beta.baseUrl },
      ]),
      [ALPHA_ENV]: ALPHA_KEY,
      ...extra,
    },
    gatewayTimeoutMs: 30_000,
  };
}

interface ModelsReport {
  readonly providers: {
    readonly id: string;
    readonly url: string;
    readonly key: string;
    readonly status: "ok" | "skipped" | "failed";
    readonly detail: string;
  }[];
  readonly models: { readonly providerId: string; readonly id: string }[];
}

describe("haril models with two providers (ACE-06)", () => {
  it("lists both providers with namespaced model ids, exit 0", async () => {
    const { io, out } = harness();
    expect(await run(["models"], io, providersHost())).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/alpha\/gpt-alpha\s+200000\s+32000/);
    expect(text).toMatch(/beta\/beta-model/);
    expect(text).toMatch(/alpha\/shared-model/);
    expect(text).toMatch(/beta\/shared-model/);
  });

  it("reports per-provider status and validates every descriptor against ModelDescriptor", async () => {
    const { io, out } = harness();
    expect(await run(["models", "--json"], io, providersHost())).toBe(0);
    const report = parseJson<ModelsReport>(out);
    expect(report.providers.map((p) => [p.id, p.status])).toEqual([
      ["alpha", "ok"],
      ["beta", "ok"],
    ]);
    expect(report.models.map((m) => `${m.providerId}/${m.id}`)).toEqual([
      "alpha/gpt-alpha",
      "alpha/shared-model",
      "beta/beta-model",
      "beta/shared-model",
    ]);
    for (const model of report.models) expect(isValidModelDescriptor(model)).toBe(true);
    expect(report.providers.map((p) => p.key)).toEqual(["set", "none needed"]);
  });

  it("sends the key to the keyed provider and no Authorization header to the keyless one", async () => {
    const { io } = harness();
    await run(["models"], io, providersHost());
    expect(alpha.requests.at(-1)?.headers.authorization).toBe(`Bearer ${ALPHA_KEY}`);
    expect(beta.requests.at(-1)?.headers.authorization).toBeUndefined();
  });

  it("skips a provider whose keyEnv is unset, reports 'key not set', and exits 1 when another answered", async () => {
    const { io, out } = harness();
    const code = await run(["models", "--json"], io, providersHost({ [ALPHA_ENV]: undefined }));
    expect(code).toBe(1);
    const report = parseJson<ModelsReport>(out);
    expect(report.providers.find((p) => p.id === "alpha")).toMatchObject({
      status: "skipped",
      detail: "key not set",
    });
    expect(report.models.every((m) => m.providerId === "beta")).toBe(true);
    expect(alpha.requests).toHaveLength(0);
  });

  it("exits 2 when no provider answered", async () => {
    const { io, err } = harness();
    const code = await run(
      ["models"],
      io,
      providersHost({
        [ALPHA_ENV]: undefined,
        HARIL_CONFIG: useConfig([{ id: "alpha", baseUrl: alpha.baseUrl, keyEnv: ALPHA_ENV }]),
      }),
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("no provider answered");
  });

  it("reports a rejected key as failed and exits 1 when the keyless provider answered", async () => {
    const { io, out } = harness();
    const code = await run(["models", "--json"], io, providersHost({ [ALPHA_ENV]: WRONG_KEY }));
    expect(code).toBe(1);
    const report = parseJson<ModelsReport>(out);
    expect(report.providers.find((p) => p.id === "alpha")).toMatchObject({
      status: "failed",
      detail: "key rejected",
    });
    expect(out.join("\n") + JSON.stringify(report)).not.toContain(WRONG_KEY);
  });

  it("queries only the provider named by --provider", async () => {
    const { io, out } = harness();
    expect(await run(["models", "--json", "--provider", "beta"], io, providersHost())).toBe(0);
    const report = parseJson<ModelsReport>(out);
    expect(report.providers.map((p) => p.id)).toEqual(["beta"]);
    expect(alpha.requests).toHaveLength(0);
  });

  it("exits 2 for an unknown --provider id", async () => {
    const { io, err } = harness();
    expect(await run(["models", "--provider", "nope"], io, providersHost())).toBe(2);
    expect(err.join("\n")).toContain('no provider with id "nope"');
  });

  it("exits 2 for an invalid config, naming the literal apiKey field and never echoing a key", async () => {
    const { io, err } = harness();
    const host = providersHost({
      HARIL_CONFIG: useConfig([{ id: "alpha", baseUrl: alpha.baseUrl, apiKey: ALPHA_KEY }]),
    });
    expect(await run(["models"], io, host)).toBe(2);
    expect(err.join("\n")).toContain("keys are never stored in haril.json");
    expect(err.join("\n")).not.toContain(ALPHA_KEY);
  });

  it("exits 2 for a provider URL that is not http or https", async () => {
    const { io, err } = harness();
    const host = providersHost({
      HARIL_CONFIG: useConfig([{ id: "alpha", baseUrl: "ftp://127.0.0.1:21/v1" }]),
    });
    expect(await run(["models"], io, host)).toBe(2);
    expect(err.join("\n")).toContain("must be an http or https URL");
  });

  it("rejects unknown options with exit 2", async () => {
    const { io, err } = harness();
    expect(await run(["models", "--verbose"], io, providersHost())).toBe(2);
    expect(err.join("\n")).toContain("--verbose");
  });
});
