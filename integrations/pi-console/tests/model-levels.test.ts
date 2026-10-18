import { describe, expect, it } from "vitest";
import {
  findCatalogModel,
  gatewayLevelMap,
  levelLabel,
  levelMapFromGateway,
  normalizeModelName,
  parseModelDetails,
  reasoningFor,
  supportedLevels,
  tokenCount,
} from "../src/model-levels.js";
import type { PiModel } from "../src/pi-types.js";

// Where each model's reasoning levels come from (FM, docs/modos-y-delegacion.md 7.10): the gateway's
// ?client_version= listing first, then Pi's catalog by normalized name, else no published levels and only "off".

describe("normalizeModelName", () => {
  it("drops the provider or account prefix and the case", () => {
    expect(normalizeModelName("Gemini1/gemini-3-flash")).toBe("gemini-3-flash");
    expect(normalizeModelName("google/Gemini-3-Flash")).toBe("gemini-3-flash");
    expect(normalizeModelName("gpt-5")).toBe("gpt-5");
  });

  it("tolerates preview, latest and dated variants", () => {
    expect(normalizeModelName("gemini-3-flash-preview")).toBe("gemini-3-flash");
    expect(normalizeModelName("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(normalizeModelName("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(normalizeModelName("gemini-2.5-flash-preview-05-20")).toBe("gemini-2.5-flash");
    expect(normalizeModelName("chatgpt-4o-latest")).toBe("chatgpt-4o");
  });
});

describe("parseModelDetails", () => {
  it("reads the models array with slug ids and object level entries", () => {
    const details = parseModelDetails({
      models: [
        {
          slug: "Gemini1/gemini-3-flash",
          display_name: "Gemini 3 Flash",
          context_window: 1_048_576,
          max_tokens: 65_536,
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "minimal", description: "fake" },
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
          ],
        },
      ],
    });
    expect(details?.get("Gemini1/gemini-3-flash")).toEqual({
      id: "Gemini1/gemini-3-flash",
      displayName: "Gemini 3 Flash",
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      levels: ["minimal", "low", "medium", "high"],
      defaultLevel: "medium",
    });
  });

  it("reads the data array with id and plain string level entries", () => {
    const details = parseModelDetails({
      data: [
        {
          id: "fake-reasoner",
          supported_reasoning_levels: ["LOW", "high", "xhigh", "unknown-level", 7],
          default_reasoning_level: "low",
        },
      ],
    });
    expect(details?.get("fake-reasoner")?.levels).toEqual(["low", "high", "xhigh"]);
    expect(details?.get("fake-reasoner")?.defaultLevel).toBe("low");
  });

  it("marks a described model without levels as publishing none", () => {
    const details = parseModelDetails({
      models: [{ slug: "Gemini1/claude-sonnet-4-6", context_window: 200_000, max_tokens: 64_000 }],
    });
    const claude = details?.get("Gemini1/claude-sonnet-4-6");
    expect(claude?.levels).toEqual([]);
    expect(claude?.defaultLevel).toBeUndefined();
    expect(claude?.contextWindow).toBe(200_000);
  });

  it("does not claim levels from a plain OpenAI listing", () => {
    const details = parseModelDetails({
      object: "list",
      data: [{ id: "fake-plain", object: "model", owned_by: "fake", context_length: 32_000 }],
    });
    expect(details?.get("fake-plain")?.levels).toBeUndefined();
    expect(details?.get("fake-plain")?.contextWindow).toBe(32_000);
  });

  it("skips entries without an id, keeps the first of duplicates and ignores bad numbers", () => {
    const details = parseModelDetails({
      models: [
        { display_name: "no id" },
        { slug: "fake-a", context_window: -5, max_tokens: 1.5 },
        { slug: "fake-a", context_window: 999 },
      ],
    });
    expect([...(details?.keys() ?? [])]).toEqual(["fake-a"]);
    expect(details?.get("fake-a")?.contextWindow).toBeUndefined();
    expect(details?.get("fake-a")?.maxTokens).toBeUndefined();
  });

  it("returns undefined for anything that is not a listing", () => {
    for (const body of [undefined, null, "fake html", 42, [], { models: "x" }, {}]) {
      expect(parseModelDetails(body)).toBeUndefined();
    }
  });
});

describe("levelMapFromGateway", () => {
  it("offers only the published levels and keeps off out unless none is published", () => {
    expect(levelMapFromGateway(["minimal", "low", "medium", "high"])).toEqual({
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(levelMapFromGateway(["none", "low", "high", "max"])).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
  });

  it("has no map when no published level is one of Pi's (auto and none alone)", () => {
    expect(levelMapFromGateway([])).toBeUndefined();
    expect(levelMapFromGateway(["auto"])).toBeUndefined();
    expect(levelMapFromGateway(["none", "auto"])).toBeUndefined();
  });
});

describe("gatewayLevelMap", () => {
  it("keeps gateway values, turns other level values into unsupported and drops an unknown off", () => {
    expect(
      gatewayLevelMap({
        off: "off",
        minimal: null,
        low: "LOW-BUDGET",
        medium: "medium",
        max: "max",
      }),
    ).toEqual({ minimal: null, low: null, medium: "medium", max: "max" });
    expect(gatewayLevelMap({ off: "none", high: "high" })).toEqual({ off: "none", high: "high" });
    expect(gatewayLevelMap(undefined)).toBeUndefined();
  });
});

describe("supportedLevels (Pi 1.2.0 getSupportedThinkingLevels)", () => {
  it("is only off for a model that does not reason", () => {
    expect(supportedLevels({ reasoning: false })).toEqual(["off"]);
    expect(supportedLevels({})).toEqual(["off"]);
  });

  it("offers off..high by default and xhigh or max only when mapped", () => {
    expect(supportedLevels({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(supportedLevels({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(
      supportedLevels({ reasoning: true, thinkingLevelMap: levelMapFromGateway(["low", "high"]) }),
    ).toEqual(["low", "high"]);
  });
});

const catalog: PiModel[] = [
  {
    provider: "haril-gw",
    id: "Gemini1/gemini-3-flash",
    reasoning: false,
  },
  {
    provider: "google",
    id: "gemini-3-flash-preview",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" },
    contextWindow: 1_048_576,
  },
  { provider: "openai", id: "gpt-5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
];
const skipHaril = (model: PiModel): boolean => model.provider.startsWith("haril-");

describe("findCatalogModel", () => {
  it("prefers the exact id, then the normalized name, and skips HARIL's own providers", () => {
    expect(findCatalogModel("gpt-5", catalog, skipHaril)?.provider).toBe("openai");
    expect(findCatalogModel("Gemini1/gemini-3-flash", catalog, skipHaril)?.id).toBe(
      "gemini-3-flash-preview",
    );
    expect(findCatalogModel("fake-unknown", catalog, skipHaril)).toBeUndefined();
  });
});

describe("reasoningFor", () => {
  const google = catalog[1];

  it("uses the gateway's published levels and default first", () => {
    const facts = reasoningFor(
      {
        id: "Gemini1/gemini-3-flash",
        displayName: undefined,
        contextWindow: undefined,
        maxTokens: undefined,
        levels: ["low", "medium", "high"],
        defaultLevel: "medium",
      },
      google,
    );
    expect(facts.source).toBe("gateway");
    expect(facts.reasoning).toBe(true);
    expect(facts.defaultLevel).toBe("medium");
    expect(supportedLevels(facts)).toEqual(["low", "medium", "high"]);
  });

  it("trusts a gateway that describes the model without levels over Pi's catalog", () => {
    const facts = reasoningFor(
      {
        id: "Gemini1/claude-sonnet-4-6",
        displayName: undefined,
        contextWindow: 200_000,
        maxTokens: 64_000,
        levels: [],
        defaultLevel: undefined,
      },
      { provider: "anthropic", id: "claude-sonnet-4-6", reasoning: true },
    );
    expect(facts).toEqual({
      reasoning: false,
      thinkingLevelMap: undefined,
      source: "none",
      defaultLevel: undefined,
    });
  });

  it("ignores a gateway default that the model does not publish", () => {
    const facts = reasoningFor(
      {
        id: "fake",
        displayName: undefined,
        contextWindow: undefined,
        maxTokens: undefined,
        levels: ["low", "high"],
        defaultLevel: "medium",
      },
      undefined,
    );
    expect(facts.defaultLevel).toBeUndefined();
  });

  it("falls back to Pi's catalog, copying reasoning and its level map", () => {
    const facts = reasoningFor(undefined, google);
    expect(facts.source).toBe("pi-catalog");
    expect(facts.reasoning).toBe(true);
    expect(facts.thinkingLevelMap).toEqual(google?.thinkingLevelMap);
    expect(facts.defaultLevel).toBeUndefined();
  });

  it("has no published levels without the gateway or a reasoning catalog model", () => {
    expect(reasoningFor(undefined, undefined)).toEqual({
      reasoning: false,
      thinkingLevelMap: undefined,
      source: "none",
      defaultLevel: undefined,
    });
    expect(reasoningFor(undefined, { provider: "x", id: "y", reasoning: false }).source).toBe(
      "none",
    );
  });
});

describe("levelLabel and tokenCount", () => {
  it("names the level, or says the model does not reason", () => {
    expect(levelLabel(undefined, "high")).toBeUndefined();
    expect(levelLabel({ provider: "p", id: "m", reasoning: false }, "off")).toBe("no reasoning");
    expect(levelLabel({ provider: "p", id: "m", reasoning: true }, "high")).toBe("high");
    expect(levelLabel({ provider: "p", id: "m", reasoning: true }, undefined)).toBe("unknown");
  });

  it("shortens token counts", () => {
    expect(tokenCount(1_048_576)).toBe("1M");
    expect(tokenCount(2_097_152)).toBe("2.1M");
    expect(tokenCount(200_000)).toBe("200k");
    expect(tokenCount(114_000)).toBe("114k");
    expect(tokenCount(512)).toBe("512");
    expect(tokenCount(undefined)).toBe("?");
  });
});
