import { describe, expect, it } from "vitest";
import { reasoningFromLevels } from "../src/bridge.js";

// The model's reasoning as the bridge registers it (docs/modos-y-delegacion.md 7.10 item 6; phase F7): the runtime
// passes the levels the gateway publishes (HARIL_MODEL_LEVELS) only when the agent's layer asks for a level. Then the
// model reasons with a level map of those levels, so Pi keeps --thinking and sends it as reasoning_effort (P27);
// otherwise it stays a model that does not reason, as before.

describe("the reasoning the bridge registers", () => {
  it("is none without published levels, or with none Pi knows", () => {
    expect(reasoningFromLevels(undefined)).toEqual({ reasoning: false });
    expect(reasoningFromLevels("")).toEqual({ reasoning: false });
    expect(reasoningFromLevels("auto")).toEqual({ reasoning: false });
  });

  it("maps each published level to itself, and off to none only when none is published", () => {
    expect(reasoningFromLevels("minimal,low,medium,high")).toEqual({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
    });
    expect(reasoningFromLevels("none,low,high,xhigh").thinkingLevelMap).toMatchObject({
      off: "none",
      minimal: null,
      xhigh: "xhigh",
    });
  });
});
