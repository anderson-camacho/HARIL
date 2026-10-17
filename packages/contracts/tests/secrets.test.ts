import { describe, expect, it } from "vitest";
import {
  checkSealedSecret,
  envSecretRef,
  parseSecretRef,
  REDACTED,
  sealSecret,
} from "../src/index.js";

// Secret references and sealed secret values (ARCH 5.1, 9.7; ADR-0020 SEC-1, SEC-5; model-provider.md 2.4).
const FAKE_SECRET = "fake-secret-fixture";

describe("parseSecretRef", () => {
  it("reads env:<NAME> with an environment variable name", () => {
    expect(parseSecretRef("env:HARIL_CLIPROXYAPI_KEY")).toEqual({
      ok: true,
      ref: "env:HARIL_CLIPROXYAPI_KEY",
      scheme: "env",
      name: "HARIL_CLIPROXYAPI_KEY",
    });
    expect(parseSecretRef("env:_X1").ok).toBe(true);
  });

  it("refuses other schemes and names that are not environment variable names, without echoing the text", () => {
    const messages = new Set<string>();
    for (const text of [
      "",
      "env:",
      "env:lower",
      "env:1ABC",
      "env:A B",
      "ENV:ABC",
      "keyring:ABC",
      ` env:ABC`,
      `env:${"A".repeat(129)}`,
      FAKE_SECRET,
      undefined,
      7,
    ]) {
      const parsed = parseSecretRef(text);
      expect(parsed.ok, String(text)).toBe(false);
      if (!parsed.ok) messages.add(parsed.message);
    }
    // One fixed message whatever was given, so a value given as a reference is never quoted.
    expect(messages.size).toBe(1);
    expect([...messages][0]).not.toContain(FAKE_SECRET);
  });

  it("builds the reference of an environment variable", () => {
    expect(envSecretRef("HARIL_CLIPROXYAPI_KEY")).toBe("env:HARIL_CLIPROXYAPI_KEY");
  });
});

describe("sealSecret", () => {
  it("gives the value only through reveal()", () => {
    expect(sealSecret(FAKE_SECRET).reveal()).toBe(FAKE_SECRET);
  });

  it("never shows the value when printed, interpolated, joined or serialized", () => {
    const material = sealSecret(FAKE_SECRET);
    expect(String(material)).toBe(REDACTED);
    expect(`${material}`).toBe(REDACTED);
    expect([material, material].join("")).toBe(`${REDACTED}${REDACTED}`);
    expect(JSON.stringify(material)).toBe(JSON.stringify(REDACTED));
    expect(JSON.stringify({ nested: [material] })).not.toContain(FAKE_SECRET);
    expect(Object.values(material).map((member) => typeof member)).toEqual([
      "function",
      "function",
      "function",
    ]);
  });

  it("keeps a sealed, non-empty value given to a store as a fresh sealed copy and refuses anything else unquoted", () => {
    const checked = checkSealedSecret(sealSecret(FAKE_SECRET));
    expect(checked.ok && checked.material.reveal()).toBe(FAKE_SECRET);
    for (const given of [FAKE_SECRET, sealSecret(""), { reveal: FAKE_SECRET }, null, 7]) {
      const refused = checkSealedSecret(given);
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).not.toContain(FAKE_SECRET);
    }
    expect(checkSealedSecret({ reveal: () => 7 }).ok).toBe(false);
  });

  it("cannot be altered to give another value", () => {
    const material = sealSecret(FAKE_SECRET);
    expect(Object.isFrozen(material)).toBe(true);
    expect(() => {
      (material as { reveal: () => string }).reveal = () => "fake-other";
    }).toThrow();
  });
});
