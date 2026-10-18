import { describe, expect, it } from "vitest";
import { ORDER_PREVIEW_MAX, orderPreview } from "../../src/delegation/index.js";

// The preview an order keeps in the log (docs/modos-y-delegacion.md 4.5, P15): at most 200 characters, on one line,
// with basic redaction of keys and tokens. The full text is never stored. Fake secrets are built at run time so no
// literal in this file looks like a real credential.

const fakeKey = (prefix: string, length = 32) => `${prefix}${"x".repeat(length)}`;

describe("orderPreview", () => {
  it("keeps a short order as typed, on one line", () => {
    expect(orderPreview("Change the primary button color\nand test it")).toBe(
      "Change the primary button color and test it",
    );
  });

  it("cuts at 200 characters, the last one an ellipsis", () => {
    const preview = orderPreview("a".repeat(500));
    expect(Array.from(preview)).toHaveLength(ORDER_PREVIEW_MAX);
    expect(preview.endsWith("…")).toBe(true);
    expect(orderPreview("b".repeat(ORDER_PREVIEW_MAX))).toBe("b".repeat(ORDER_PREVIEW_MAX));
  });

  it("counts characters, not UTF-16 units, so an emoji is never split", () => {
    const preview = orderPreview("😀".repeat(300));
    expect(Array.from(preview)).toHaveLength(ORDER_PREVIEW_MAX);
    expect(preview.includes("�")).toBe(false);
  });

  it("redacts provider-style keys, bearer tokens and JWTs", () => {
    const jwt = `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`;
    const text = `use ${fakeKey("sk-")} then Bearer ${"y".repeat(40)} and ${jwt} please`;
    const preview = orderPreview(text);
    expect(preview).toBe("use [redacted] then Bearer [redacted] and [redacted] please");
  });

  it("redacts the value of a key, token, secret or password assignment", () => {
    for (const label of ["api_key", "API-KEY", "token", "secret", "password", "client_secret"]) {
      expect(orderPreview(`set ${label}=hunter2value and go`)).toBe(
        `set ${label}=[redacted] and go`,
      );
      expect(orderPreview(`${label}: "hunter2value"`)).toBe(`${label}: [redacted]`);
    }
  });

  it("redacts the value of a quoted key, as JSON or a Python dict writes it", () => {
    expect(orderPreview(`send {"password": "hunter2value", "user": "ana"}`)).toBe(
      'send {"password": [redacted], "user": "ana"}',
    );
    expect(orderPreview(`cfg = {'token': 'abc', 'x': 1}`)).toBe(
      "cfg = {'token': [redacted], 'x': 1}",
    );
    expect(orderPreview(`{"api_key":"hunter2value"}`)).toBe('{"api_key":[redacted]}');
  });

  it("redacts the credential of an Authorization header, not only its scheme word", () => {
    const credential = "x".repeat(16);
    expect(orderPreview(`Authorization: Basic ${credential} then go`)).toBe(
      "Authorization: Basic [redacted] then go",
    );
    expect(orderPreview("authorization=Bearer abc next")).toBe(
      "authorization=Bearer [redacted] next",
    );
    expect(orderPreview(`{"Authorization": "Bearer short"}`)).toBe(
      '{"Authorization": "Bearer [redacted]"}',
    );
    expect(orderPreview(`Authorization: ${credential}`)).toBe("Authorization: [redacted]");
    expect(orderPreview(`curl -H "Basic ${credential}"`)).toBe('curl -H "Basic [redacted]"');
  });

  it("redacts long hex and base64-looking runs that mix letters and digits", () => {
    const hex = "0123456789abcdef".repeat(3);
    const base64 = `${"Ab3".repeat(12)}==`;
    expect(orderPreview(`hash ${hex} blob ${base64}`)).toBe("hash [redacted] blob [redacted]");
    expect(orderPreview(`word ${"a".repeat(40)}`)).toBe(`word ${"a".repeat(40)}`);
  });

  it("redacts before cutting, so a secret at the edge is never half shown", () => {
    const text = `${"w ".repeat(95)}${fakeKey("sk-", 40)}`;
    const preview = orderPreview(text);
    expect(preview.includes("xxxxx")).toBe(false);
  });

  it("returns an empty preview for blank text", () => {
    expect(orderPreview("   \n\t ")).toBe("");
  });
});
