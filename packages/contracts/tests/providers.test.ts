import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ModelDescriptorSchema, UsageSchema } from "../src/index.js";

const model = {
  providerId: "openai-compatible",
  id: "gpt-test",
};

describe("ModelDescriptor v1 (minimal M2 slice of schemas.md 9.2)", () => {
  it("accepts the required fields alone", () => {
    expect(Value.Check(ModelDescriptorSchema, model)).toBe(true);
  });

  it("accepts the optional context, output and capability fields", () => {
    expect(
      Value.Check(ModelDescriptorSchema, {
        ...model,
        displayName: "GPT Test",
        contextWindow: 200000,
        maxOutputTokens: 32000,
        capabilities: { tools: true },
      }),
    ).toBe(true);
  });

  it("rejects an empty id, a non-positive window and unknown fields", () => {
    expect(Value.Check(ModelDescriptorSchema, { ...model, id: "" })).toBe(false);
    expect(Value.Check(ModelDescriptorSchema, { ...model, contextWindow: 0 })).toBe(false);
    expect(Value.Check(ModelDescriptorSchema, { ...model, price: 1 })).toBe(false);
  });
});

describe("Usage v1 (schemas.md 8.1)", () => {
  const usage = { schemaVersion: 1, inputTokens: 11, outputTokens: 4 };

  it("accepts counts and the optional cached and reasoning counts", () => {
    expect(
      Value.Check(UsageSchema, {
        ...usage,
        cachedInputTokens: 2,
        reasoningTokens: null,
      }),
    ).toBe(true);
  });

  it("accepts null where the provider reports no value (never a silent 0)", () => {
    expect(Value.Check(UsageSchema, { ...usage, inputTokens: null, outputTokens: null })).toBe(
      true,
    );
  });

  it("rejects a string count and a missing schemaVersion", () => {
    expect(Value.Check(UsageSchema, { ...usage, inputTokens: "11" })).toBe(false);
    expect(Value.Check(UsageSchema, { inputTokens: 11, outputTokens: 4 })).toBe(false);
  });
});
