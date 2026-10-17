// Fake Pi process for the agent-pi adapter tests. It speaks the RPC subset HARIL uses (ADR-0004) and
// plays the bridge side of the handshake by connecting to HARIL_BRIDGE itself. Not a Pi build: every
// behaviour below is a simulation chosen by FAKE_PI_SCENARIO. Run it with the host Node.
//
// Scenarios: ok, ok_with_read (reads FAKE_PI_READ_PATH through the bridge), read_outside (asks the bridge
// for a relative path, an absolute path from FAKE_PI_OUTSIDE_PATH and a UNC path, all outside the root, then
// settles with the denial codes), wrong_hello_tools,
// wrong_token, no_hello, wrong_model, crash_before_settled, nonzero_after_settled, hang (ignores abort
// and EOF), hang_abortable (answers abort with agent_settled), ui_request, huge_line, ok_via_broker (one
// streamed chat call to HARIL_BROKER_URL with HARIL_VKEY; the streamed text is the reply, a Broker refusal or
// stream error event becomes an assistant message with stopReason "error"). The last one is what M2-T6 runs end to end.
// RL-T4 scenarios: error_then_retry_ok (a failed reply, then a retry that succeeds), error_final, ended_aborted,
// echo_prompt (the reply repeats the prompt text), prompt_handled (prompt answered "handled"), ui_notify (a notify
// request that must not be answered; the reply says whether a stray answer arrived).
// LD-T4 scenarios: propose_plan (one valid plan through the bridge's plan.propose, as haril_propose_plan would send
// it), propose_plan_retry (an invalid plan first; after the refusal, the valid plan). The reply reports each answer.
// LD-T7b scenario: propose_analyst_plan, one wrapper for both runs of the live demo. A planner run (one offered
// haril_propose_plan) proposes a plan of analyst tasks with the token ceiling the planner prompt asks for; any other
// run answers through the Broker, as ok_via_broker does, and adds the first line of the first dependency result its
// prompt carries (MC-T1).
// Test-only: the real Pi is never replaced outside HARIL_PI_CLI_OVERRIDE.

import { connect } from "node:net";

const scenario = process.env.FAKE_PI_SCENARIO ?? "ok";
const runId = process.env.HARIL_RUN_ID ?? "";
const allowedTools = (process.env.HARIL_TOOLS ?? "").split(",").filter((name) => name !== "");
const [pipePath = "", token = ""] = splitBridge(process.env.HARIL_BRIDGE ?? "");
const expectedModel = argValue("--model");
const LARGE_LINE_BYTES = 8 * 1024 * 1024 + 1;
const PROPOSE_PLAN_TOOL = "haril_propose_plan";
const ANALYST_MAX_TOKENS = 20000;

const pendingBridge = new Map();
let bridgeSeq = 0;
let bridgeSocket;
let bridgeBuffer = "";
let stdinBuffer = "";
let abortRequested = false;
let promptText = "";
const pendingUi = new Map();
const UI_SETTLE_MS = 200;
let strayUiResponse = false;

process.stderr.write("fake-pi stderr marker\n");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function splitBridge(raw) {
  const index = raw.lastIndexOf("#");
  return index === -1 ? [raw, ""] : [raw.slice(0, index), raw.slice(index + 1)];
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function exitAfterFlush(code) {
  process.stdout.write("", () => process.exit(code));
}

function splitLines(buffer, onLine) {
  let rest = buffer;
  let lf = rest.indexOf("\n");
  while (lf !== -1) {
    let line = rest.slice(0, lf);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    onLine(line);
    rest = rest.slice(lf + 1);
    lf = rest.indexOf("\n");
  }
  return rest;
}

function connectBridge() {
  if (scenario === "no_hello" || pipePath === "") return;
  bridgeSocket = connect(pipePath);
  bridgeSocket.on("connect", () => {
    const tools = scenario === "wrong_hello_tools" ? ["read", "bash"] : allowedTools;
    const sentToken = scenario === "wrong_token" ? "wrong-token" : token;
    bridgeSocket.write(
      `${JSON.stringify({
        type: "hello",
        runId,
        token: sentToken,
        tools,
        bridgeVersion: "fake-bridge-1",
        piVersion: "fake",
      })}\n`,
    );
  });
  bridgeSocket.on("data", (chunk) => {
    bridgeBuffer = splitLines(bridgeBuffer + chunk.toString("utf8"), (line) => {
      const message = JSON.parse(line);
      pendingBridge.get(message.id)?.(message);
    });
  });
  bridgeSocket.on("error", () => {});
}

function bridgeRequest(operation) {
  return new Promise((resolve) => {
    const id = `op-${++bridgeSeq}`;
    pendingBridge.set(id, (message) => {
      pendingBridge.delete(id);
      resolve(message);
    });
    bridgeSocket.write(`${JSON.stringify({ id, ...operation })}\n`);
  });
}

function bridgeRead(path) {
  return bridgeRequest({ op: "read", path });
}

// A valid two-step plan for the goal (the first line of the prompt). By default its tasks are hermetic, so a granted
// plan runs without a model; the description marks the plan body, which no event may carry. The analyst variant
// (LD-T7b) is what the planner prompt asks for: read-only analyst tasks with a token ceiling of 20000.
function fakePlan(goal, { agent = "fake:succeed", maxTokens = 0 } = {}) {
  const step = (localId, dependsOn, n) => ({
    localId,
    dependsOn,
    goal: `${goal} (step ${n} of 2)`,
    description: "A step the fake Pi planner proposes.",
    priority: 5,
    kind: "work",
    agent,
    requires: [],
    context: [],
    surface: { write: [], read: [] },
    budget: { maxCostMicros: 0, maxTokens, maxWallMs: 60000 },
    timeoutMs: 60000,
    maxAttempts: 1,
    acceptance: [],
  });
  return { schemaVersion: 1, tasks: [step("survey", [], 1), step("report", ["survey"], 2)] };
}

async function proposePlan(plan) {
  const reply = await bridgeRequest({ op: "plan.propose", plan });
  return {
    ok: reply.ok === true,
    text: reply.ok ? `plan ok: ${reply.content}` : `plan refused: ${reply.error}`,
  };
}

function respond(command, id, data) {
  emit({ type: "response", id, command, success: true, data });
}

function uiRequest(id) {
  return new Promise((resolve) => {
    pendingUi.set(id, resolve);
    emit({
      type: "extension_ui_request",
      id,
      method: "confirm",
      title: "Allow fake action?",
      message: "fake confirm",
      timeout: 5000,
    });
  });
}

// What an analyst of the demo plan saw of the tasks it depends on (MC-T1): " | dependency result: <first line>" for
// the first block of the prompt's dependency section (the label, a blank line, "[<task id>] <goal>", then its result),
// or "" when the prompt has none. It lets the e2e prove that a task received its dependency's answer.
const DEPENDENCY_LABEL = "Results of the tasks this task depends on (";

function dependencyEcho(prompt) {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => line.startsWith(DEPENDENCY_LABEL));
  if (start === -1 || !(lines[start + 2] ?? "").startsWith("[")) return "";
  return ` | dependency result: ${lines[start + 3] ?? ""}`;
}

// One streamed OpenAI-style call through the Broker. Refusals (402 insufficient_quota, 401, 502) end the
// assistant message with stopReason "error", the way Pi reports a failed model call. A suffix, when given, is streamed
// after the upstream's reply, as if the model had added it.
async function brokerChat(prompt, suffix = "") {
  const response = await fetch(`${process.env.HARIL_BROKER_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.HARIL_VKEY}`,
    },
    body: JSON.stringify({
      model: process.env.HARIL_MODEL,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    emitAssistant("", body?.error?.message ?? `HTTP ${response.status}`);
    emit({ type: "agent_settled", aborted: false });
    return;
  }
  let text = "";
  let streamError;
  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let lf = pending.indexOf("\n");
    while (lf !== -1) {
      const line = pending.slice(0, lf).trim();
      pending = pending.slice(lf + 1);
      lf = pending.indexOf("\n");
      if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
      const parsed = JSON.parse(line.slice(5));
      // The Broker cuts a stream with an error event (insufficient_quota): Pi ends the message with that error.
      if (parsed?.error !== undefined) {
        streamError = String(parsed.error.message ?? "stream error");
        continue;
      }
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === "string") {
        text += delta;
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
      }
    }
  }
  if (suffix !== "" && streamError === undefined) {
    text += suffix;
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: suffix } });
  }
  emitAssistant(text, streamError);
  emit({ type: "turn_end" });
  emit({ type: "agent_settled", aborted: false });
}

function emitAssistant(
  text,
  errorMessage,
  stopReason = errorMessage === undefined ? "stop" : "error",
) {
  const message = { role: "assistant", content: [{ type: "text", text }], stopReason };
  if (errorMessage !== undefined) message.errorMessage = errorMessage;
  emit({ type: "message_end", message });
}

async function runPrompt() {
  emit({ type: "agent_start" });
  emit({ type: "future_event_xyz", payload: "ignored" });
  if (scenario === "crash_before_settled") {
    process.stderr.write("fake-pi crash before settled\n", () => process.exit(1));
    return;
  }
  if (scenario === "huge_line") {
    process.stdout.write(`${"x".repeat(LARGE_LINE_BYTES)}\n`);
    return;
  }
  if (scenario === "hang" || scenario === "hang_abortable") return;
  const planning = allowedTools.includes(PROPOSE_PLAN_TOOL);
  if (scenario === "ok_via_broker") {
    await brokerChat(promptText);
    return;
  }
  if (scenario === "propose_analyst_plan" && !planning) {
    await brokerChat(promptText, dependencyEcho(promptText));
    return;
  }
  // Pi retries a failed model call: the first assistant message ends with an error, the retry succeeds.
  if (scenario === "error_then_retry_ok") {
    emitAssistant("", "transient provider error");
    emitAssistant("retry reply");
    emit({ type: "turn_end" });
    emit({ type: "agent_settled", aborted: false });
    return;
  }
  if (scenario === "error_final") {
    emitAssistant("", "model unavailable");
    emit({ type: "turn_end" });
    emit({ type: "agent_settled", aborted: false });
    return;
  }
  if (scenario === "ended_aborted") {
    emitAssistant("partial", undefined, "aborted");
    emit({ type: "turn_end" });
    emit({ type: "agent_settled", aborted: false });
    return;
  }

  let text = "fake reply";
  if (scenario === "echo_prompt") text = `echo: ${promptText}`;
  if (scenario === "ok_with_read") {
    const reply = await bridgeRead(process.env.FAKE_PI_READ_PATH ?? "");
    text = reply.ok ? `read ok: ${reply.content}` : `read denied: ${reply.error}`;
  }
  if (scenario === "read_outside") {
    const requests = [
      "../outside.txt",
      process.env.FAKE_PI_OUTSIDE_PATH ?? "",
      "\\\\server\\share\\x.txt",
    ];
    const outcomes = [];
    for (const path of requests) {
      const reply = await bridgeRead(path);
      outcomes.push(reply.ok ? "allowed" : reply.error);
    }
    text = `read denials ${outcomes.length}: ${outcomes.join(", ")}`;
  }
  if (scenario === "propose_plan") {
    text = (await proposePlan(fakePlan(promptText.split("\n")[0] ?? ""))).text;
  }
  if (scenario === "propose_analyst_plan") {
    const plan = fakePlan(promptText.split("\n")[0] ?? "", {
      agent: "analyst",
      maxTokens: ANALYST_MAX_TOKENS,
    });
    text = (await proposePlan(plan)).text;
  }
  // The model sends a wrong plan, reads the refusal and sends the fixed one, as the planner prompt asks.
  if (scenario === "propose_plan_retry") {
    const first = await proposePlan({ schemaVersion: 2, tasks: [] });
    text = first.text;
    if (!first.ok) {
      text += ` | ${(await proposePlan(fakePlan(promptText.split("\n")[0] ?? ""))).text}`;
    }
  }
  if (scenario === "ui_request") {
    const ui = await uiRequest("ui-1");
    text = `ui cancelled=${ui.cancelled === true}`;
  }
  // A notify is fire-and-forget: HARIL must not answer it. The fake waits briefly and reports any stray answer.
  if (scenario === "ui_notify") {
    emit({
      type: "extension_ui_request",
      id: "ui-notify",
      method: "notify",
      message: "fake notice",
    });
    await new Promise((resolve) => setTimeout(resolve, UI_SETTLE_MS));
    text = strayUiResponse ? "stray ui response" : "notify ignored";
  }
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fake " } });
  emit({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  emit({ type: "turn_end" });
  emit({ type: "agent_settled", aborted: false });
}

function handleCommand(message) {
  switch (message.type) {
    case "get_state": {
      const model = scenario === "wrong_model" ? "other-model" : expectedModel;
      respond("get_state", message.id, {
        model: { id: model, provider: "haril" },
        isStreaming: false,
      });
      return;
    }
    case "prompt":
      // Pi 1.2.0 answers "handled" for an input its own commands took: no run starts and no agent_settled follows.
      if (scenario === "prompt_handled") {
        respond("prompt", message.id, { disposition: "handled" });
        return;
      }
      respond("prompt", message.id, { disposition: "started" });
      promptText = typeof message.message === "string" ? message.message : "";
      void runPrompt();
      return;
    case "abort":
      abortRequested = true;
      if (scenario === "hang_abortable") {
        emit({ type: "agent_settled", aborted: true });
      }
      return;
    case "extension_ui_response":
      if (pendingUi.has(message.id)) {
        pendingUi.get(message.id)(message);
        pendingUi.delete(message.id);
      } else {
        strayUiResponse = true;
      }
      return;
    default:
      return;
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer = splitLines(stdinBuffer + chunk, (line) => {
    if (line.trim() !== "") handleCommand(JSON.parse(line));
  });
});
process.stdin.on("end", () => {
  if (scenario === "hang") return;
  if (scenario === "nonzero_after_settled") {
    exitAfterFlush(3);
    return;
  }
  if (scenario === "hang_abortable" && !abortRequested) return;
  exitAfterFlush(0);
});
process.stdin.on("error", () => {});

connectBridge();
