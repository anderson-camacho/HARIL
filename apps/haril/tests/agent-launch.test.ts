import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDelegationSettings } from "@haril/contracts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "@haril/gateway/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { agentLaunchOf } from "../src/runtime/real-agent.js";
import { harness, makeSandbox, parseJson, projectRoot, type Sandbox } from "./helpers.js";

// A real agent's launch (docs/modos-y-delegacion.md 3.12, 7.10 item 6; ADR-0021 S3; phase F7): the live catalog's
// context window and max output for its model instead of the 32 768 / 4 096 fallback, its layer's compaction threshold
// (the workflow's snapshot, else haril.json's) and its layer's reasoning level. The end-to-end part runs `haril run`
// with the fake Pi (HARIL_PI_CLI_OVERRIDE) against a fake gateway; nothing reaches the network.

const FACTS = { contextWindow: 1_048_576, maxTokens: 65_536, levels: ["low", "medium", "high"] };

describe("a real agent's launch", () => {
  const settings = resolveDelegationSettings({
    context: { compactAtTokens: 250_000, perLayer: { orchestrator: 400_000 } },
    models: { layers: { executor: { model: null, level: "high" } } },
  });

  it("takes the catalog's limits, the layer's level with the model's levels, and haril.json's threshold", () => {
    expect(
      agentLaunchOf({ settings, facts: FACTS, layer: "executor", workflowLimits: {} }),
    ).toEqual({
      modelContextWindow: 1_048_576,
      modelMaxTokens: 65_536,
      compactAtTokens: 250_000,
      thinkingLevel: "high",
      modelLevels: ["low", "medium", "high"],
    });
    expect(
      agentLaunchOf({ settings, facts: FACTS, layer: "orchestrator", workflowLimits: {} }),
    ).toEqual({ modelContextWindow: 1_048_576, modelMaxTokens: 65_536, compactAtTokens: 400_000 });
  });

  it("prefers the threshold the workflow kept when it started (P11)", () => {
    const workflowLimits = {
      context: { compactAtTokens: 200_000, perLayer: { executor: 350_000 } },
    };
    expect(
      agentLaunchOf({ settings, facts: FACTS, layer: "executor", workflowLimits }).compactAtTokens,
    ).toBe(350_000);
    expect(
      agentLaunchOf({ settings, facts: FACTS, layer: "auditor", workflowLimits }).compactAtTokens,
    ).toBe(200_000);
  });

  it("keeps the fallback limits and asks for no level when the catalog does not know the model", () => {
    expect(
      agentLaunchOf({ settings, facts: undefined, layer: "executor", workflowLimits: undefined }),
    ).toEqual({ compactAtTokens: 250_000, thinkingLevel: "high" });
  });

  it("gives a task outside a workflow the general threshold and no level", () => {
    expect(
      agentLaunchOf({ settings, facts: FACTS, layer: undefined, workflowLimits: undefined }),
    ).toEqual({ modelContextWindow: 1_048_576, modelMaxTokens: 65_536, compactAtTokens: 250_000 });
  });
});

const GATEWAY_KEY = "gateway-test-key-0123456789";
const FAKE_PI = new URL("../../../integrations/agent-pi/testing/fake-pi.mjs", import.meta.url);

let sb: Sandbox;
let upstream: FakeOpenAiServer;

beforeEach(async () => {
  sb = makeSandbox();
  upstream = await startFakeOpenAiServer({
    apiKey: GATEWAY_KEY,
    models: [{ id: "big-model", context_length: 1_048_576, max_output_tokens: 65_536 }],
    completion: {
      textChunks: ["Hello ", "from the model."],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    },
  });
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    harness().io,
    sb.host,
  );
});

afterEach(async () => {
  await upstream.close();
  sb.cleanup();
});

function piWrapper(scenario: string): string {
  const path = join(sb.root, `pi-${scenario}.mjs`);
  const fakePi = pathToFileURL(fileURLToPath(FAKE_PI)).href;
  writeFileSync(
    path,
    `process.env.FAKE_PI_SCENARIO = ${JSON.stringify(scenario)};\nawait import(${JSON.stringify(fakePi)});\n`,
  );
  return path;
}

describe("haril run with a real agent (phase F7)", () => {
  it("launches Pi with the catalog's window and output and compacts at haril.json's threshold", async () => {
    const config = join(sb.root, "haril.json");
    writeFileSync(
      config,
      JSON.stringify({
        providers: [{ id: "cliproxy", baseUrl: upstream.baseUrl, keyEnv: "HARIL_CLIPROXYAPI_KEY" }],
        delegation: { context: { compactAtTokens: 200_000 } },
      }),
    );
    const add = harness();
    expect(
      run(
        [
          "task",
          "add",
          "Summarize the README",
          "--agent",
          "analyst",
          "--model",
          "cliproxy/big-model",
        ],
        add.io,
        sb.host,
      ),
    ).toBe(0);
    const host = {
      ...sb.host,
      env: {
        ...sb.host.env,
        HARIL_PI_CLI_OVERRIDE: piWrapper("ok_via_broker"),
        HARIL_CLIPROXYAPI_KEY: GATEWAY_KEY,
        HARIL_CONFIG: config,
      },
    };
    const h = harness();
    expect(await run(["run", "--project", "demo"], h.io, host)).toBe(0);

    const events = harness();
    expect(run(["events", "--project", "demo", "--json"], events.io, sb.host)).toBe(0);
    const started = parseJson<{ type: string; payload: unknown }[]>(events.out).find(
      (event) => event.type === "run.started",
    );
    {
      expect(started?.payload).toEqual({
        agentRuntime: "pi",
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        limitsSource: "catalog",
        compactAtTokens: 200_000,
        reserveTokens: 848_576,
        thinkingLevel: null,
      });
      const runs = join(sb.dataDir, "runs");
      const [runId] = readdirSync(runs);
      expect(
        JSON.parse(readFileSync(join(runs, runId as string, "agent", "settings.json"), "utf8")),
      ).toEqual({ compaction: { reserveTokens: 848_576 } });
    }
  }, 30_000);
});
