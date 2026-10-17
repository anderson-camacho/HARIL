import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type StoreError } from "../src/index.js";
import { fixedClock, makeTempDir, removeTempDir, sequentialIds, testRules } from "./support.js";

// INV-19 (ARCH 14.2, MC-D6): a Node version outside the range is refused at store open, before any file is created.
// Kept deviation (MC-D6, M1-D1): a 24.x below the range (24.19.x, the libuv defect of the team's host) opens with a
// warning. Every other version outside ^24.21.0 || >=26.8.0 (the engines range) is refused, 25.x and 26.0 to 26.7
// included.
let dir = "";

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => {
  removeTempDir(dir);
});

function openWithNode(nodeVersion: string) {
  return openStore({
    dataDir: join(dir, "data"),
    clock: fixedClock(),
    ids: sequentialIds(),
    rules: testRules,
    runtime: { nodeVersion },
  });
}

// Returns the store error of a refused open, or undefined when the open succeeded.
function refusalOf(nodeVersion: string): StoreError | undefined {
  try {
    openWithNode(nodeVersion).close();
  } catch (error) {
    return error as StoreError;
  }
  return undefined;
}

describe("[INV-19] the Node version gate at store open", () => {
  it.each(["v23.11.0", "v22.12.0", "v20.19.0"])(
    "[INV-19] Node %s is refused with store.gate_failed and creates no data directory",
    (nodeVersion) => {
      const error = refusalOf(nodeVersion);
      expect(error?.code).toBe("store.gate_failed");
      expect(error?.details).toMatchObject({ gate: "node" });
      expect(existsSync(join(dir, "data"))).toBe(false);
    },
  );

  it("[INV-19] Node 24.19.0 opens with the documented warning (MC-D6 deviation)", () => {
    const store = openWithNode("v24.19.0");
    expect(store.info().gates.find((gate) => gate.name === "node")?.status).toBe("warn");
    store.close();
  });

  it.each(["v25.1.0", "v26.0.0", "v26.7.9"])(
    "[INV-19] Node %s is refused at open and creates no data directory",
    (nodeVersion) => {
      expect(refusalOf(nodeVersion)).toMatchObject({ code: "store.gate_failed" });
      expect(existsSync(join(dir, "data"))).toBe(false);
    },
  );
});
