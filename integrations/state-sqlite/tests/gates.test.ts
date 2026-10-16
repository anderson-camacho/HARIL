import { describe, expect, it } from "vitest";
import { evaluateGates } from "../src/index.js";

function statusOf(nodeVersion: string, sqliteVersion: string, name: "node" | "sqlite") {
  const gate = evaluateGates({ nodeVersion, sqliteVersion }).find((g) => g.name === name);
  return gate?.status;
}

describe("sqlite gate (hard, INV-16)", () => {
  it.each([
    ["3.53.3", "ok"],
    ["3.51.3", "ok"],
    ["3.51.2", "error"],
    ["3.50.7", "error"],
    ["3.44.6", "error"],
  ])("SQLite %s is %s", (sqliteVersion, status) => {
    expect(statusOf("v24.21.0", sqliteVersion, "sqlite")).toBe(status);
  });

  it("an unreadable SQLite version is an error", () => {
    expect(statusOf("v24.21.0", "unknown", "sqlite")).toBe("error");
  });
});

describe("node gate (warning outside the range, M1-D1)", () => {
  it.each([
    ["v24.21.0", "ok"],
    ["v24.22.1", "ok"],
    ["v26.8.0", "ok"],
    ["v24.19.0", "warn"],
    ["v25.1.0", "warn"],
    ["v26.7.9", "warn"],
    ["v22.12.0", "error"],
  ])("Node %s is %s", (nodeVersion, status) => {
    expect(statusOf(nodeVersion, "3.53.3", "node")).toBe(status);
  });
});
