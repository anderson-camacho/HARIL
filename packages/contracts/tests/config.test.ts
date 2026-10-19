import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { effectiveUiLocale, HarilConfigSchema, UiLocaleSchema } from "../src/config.js";

describe("UI locale config contract", () => {
  it("defaults to Spanish when locale is absent", () => {
    expect(effectiveUiLocale(undefined)).toBe("es");
    expect(effectiveUiLocale({})).toBe("es");
  });

  it("accepts explicit English and Spanish", () => {
    for (const locale of ["en", "es"] as const) {
      expect(Value.Check(UiLocaleSchema, locale)).toBe(true);
      expect(
        Value.Check(HarilConfigSchema, {
          providers: [{ id: "local", baseUrl: "http://127.0.0.1:8317/v1" }],
          ui: { locale },
        }),
      ).toBe(true);
      expect(effectiveUiLocale({ locale })).toBe(locale);
    }
  });

  it("rejects unsupported locale values", () => {
    for (const locale of ["fr", "EN", "", null, 1]) {
      expect(Value.Check(UiLocaleSchema, locale)).toBe(false);
      expect(
        Value.Check(HarilConfigSchema, {
          providers: [{ id: "local", baseUrl: "http://127.0.0.1:8317/v1" }],
          ui: { locale },
        }),
      ).toBe(false);
    }
  });
});
