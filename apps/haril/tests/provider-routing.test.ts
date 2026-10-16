import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "@haril/gateway/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { harness, makeSandbox, parseJson, projectRoot, type Sandbox } from "./helpers.js";

// M3-T7 routing: a task names its provider in --model (<provider>/<model>) and the Broker sends it to that
// provider's upstream only. Pi is the test-only fake-pi stand-in, as in real-agent.test.ts. Loopback only.
const ALPHA_KEY = "alpha-route-key-0123456789";
const FAKE_PI = new URL("../../../integrations/agent-pi/testing/fake-pi.mjs", import.meta.url);
const TEST_TIMEOUT_MS = 30_000;
const ROUTED_GOAL = "Route to beta";
const AMBIGUOUS_GOAL = "Ambiguous bare model";

let sb: Sandbox;
let alpha: FakeOpenAiServer;
let beta: FakeOpenAiServer;
let providerEnv: Record<string, string> = {};

function hostOf() {
  return { ...sb.host, env: { ...sb.host.env, ...providerEnv } };
}

const REPLY = {
  textChunks: ["Routed ", "reply."],
  usage: { prompt_tokens: 7, completion_tokens: 3 },
};

beforeEach(async () => {
  sb = makeSandbox();
  alpha = await startFakeOpenAiServer({
    apiKey: ALPHA_KEY,
    models: ["shared-model", "alpha-only"],
    completion: REPLY,
  });
  beta = await startFakeOpenAiServer({
    apiKey: null,
    models: ["beta-model", "shared-model"],
    completion: REPLY,
  });
  const configPath = join(sb.root, "haril.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: [
        { id: "alpha", baseUrl: alpha.baseUrl, keyEnv: "HARIL_TEST_ALPHA_KEY" },
        { id: "beta", baseUrl: beta.baseUrl },
      ],
    }),
  );
  const init = harness();
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    init.io,
    hostOf(),
  );
  providerEnv = { HARIL_CONFIG: configPath, HARIL_TEST_ALPHA_KEY: ALPHA_KEY };
});

afterEach(async () => {
  await alpha.close();
  await beta.close();
  sb.cleanup();
});

// A wrapper that selects the ok_via_broker fake-pi scenario and runs fake-pi.mjs with the current Node.
function piWrapper(): string {
  const path = join(sb.root, "pi-ok-via-broker.mjs");
  const fakePi = pathToFileURL(fileURLToPath(FAKE_PI)).href;
  writeFileSync(
    path,
    `process.env.FAKE_PI_SCENARIO = "ok_via_broker";\nawait import(${JSON.stringify(fakePi)});\n`,
  );
  return path;
}

function realHost() {
  return { ...hostOf(), env: { ...hostOf().env, HARIL_PI_CLI_OVERRIDE: piWrapper() } };
}

function chatsOf(server: FakeOpenAiServer): number {
  return server.requests.filter((r) => r.path === "/v1/chat/completions").length;
}

function taskIdOf(goal: string): string {
  const status = harness();
  run(["status", "--json"], status.io, hostOf());
  const found = parseJson<{ taskList: { taskId: string; goal: string }[] }>(
    status.out,
  ).taskList.find((task) => task.goal === goal);
  if (found === undefined) throw new Error(`no task "${goal}"`);
  return found.taskId;
}

interface TaskView {
  readonly state: string;
  readonly result: { model?: string } | null;
  readonly error: { code: string } | null;
}

function taskView(goal: string): TaskView {
  const show = harness();
  expect(run(["task", "show", taskIdOf(goal), "--json"], show.io, hostOf())).toBe(0);
  return parseJson<TaskView>(show.out);
}

describe("provider routing (M3-T7)", () => {
  it(
    "sends a task named beta/<model> to the beta upstream only, keyless",
    async () => {
      const add = harness();
      expect(
        run(
          ["task", "add", ROUTED_GOAL, "--agent", "analyst", "--model", "beta/beta-model"],
          add.io,
          hostOf(),
        ),
      ).toBe(0);
      expect(await run(["start", "--project", "demo"], harness().io, realHost())).toBe(0);

      const view = taskView(ROUTED_GOAL);
      expect(view.state).toBe("completed");
      expect(view.result?.model).toBe("beta/beta-model");
      expect(chatsOf(beta)).toBe(1);
      expect(chatsOf(alpha)).toBe(0);
      const forwarded = beta.requests.find((r) => r.path === "/v1/chat/completions");
      const forwardedBody = forwarded?.body as { model: string } | undefined;
      expect(forwardedBody?.model).toBe("beta-model");
      expect(forwarded?.headers.authorization).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails a bare model that two providers serve with model_ambiguous, without contacting either",
    async () => {
      const add = harness();
      expect(
        run(
          ["task", "add", AMBIGUOUS_GOAL, "--agent", "analyst", "--model", "shared-model"],
          add.io,
          hostOf(),
        ),
      ).toBe(0);
      expect(await run(["start", "--project", "demo"], harness().io, realHost())).toBe(1);

      const view = taskView(AMBIGUOUS_GOAL);
      expect(view.state).toBe("failed");
      expect(view.error?.code).toBe("model_ambiguous");
      expect(chatsOf(alpha)).toBe(0);
      expect(chatsOf(beta)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resolves a bare model that exactly one provider serves to that provider",
    async () => {
      const add = harness();
      expect(
        run(
          ["task", "add", "Bare alpha", "--agent", "analyst", "--model", "alpha-only"],
          add.io,
          hostOf(),
        ),
      ).toBe(0);
      expect(await run(["start", "--project", "demo"], harness().io, realHost())).toBe(0);

      expect(taskView("Bare alpha").result?.model).toBe("alpha/alpha-only");
      expect(chatsOf(alpha)).toBe(1);
      expect(chatsOf(beta)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
