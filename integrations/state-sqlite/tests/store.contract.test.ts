import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, openStore, type StoreError } from "../src/index.js";
import { fixedClock, makeTempDir, removeTempDir, sequentialIds, testRules } from "./support.js";

// Contract suite of the Store port (M1-D3), run against :memory: and a temporary file database.
let dir = "";

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => {
  removeTempDir(dir);
});

function caught(action: () => unknown): StoreError {
  try {
    action();
  } catch (error) {
    return error as StoreError;
  }
  throw new Error("expected the operation to throw");
}

const backends: [string, () => Store][] = [
  [
    "in-memory",
    () => openMemoryStore({ clock: fixedClock(), ids: sequentialIds(), rules: testRules }),
  ],
  [
    "temporary file",
    () => openStore({ dataDir: dir, clock: fixedClock(), ids: sequentialIds(), rules: testRules }),
  ],
];

describe.each(backends)("Store contract (%s)", (_name, open) => {
  let store: Store;

  beforeEach(() => {
    store = open();
  });

  afterEach(() => {
    store.close();
  });

  it("info reports schema 8, a SQLite of at least 3.51.3 and the pragmas read back", () => {
    const info = store.info();
    expect(info.storeId).not.toBe("");
    expect(info.schemaVersion).toBe(8);
    const [major = 0, minor = 0, patch = 0] = info.sqliteVersion.split(".").map(Number);
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(3_051_003);
    expect(info.pragmas.synchronous).toBe(2);
    expect(info.pragmas.foreignKeys).toBe(true);
    expect(info.pragmas.busyTimeoutMs).toBeLessThanOrEqual(200);
    expect(info.gates.find((gate) => gate.name === "sqlite")?.status).toBe("ok");
  });

  it("registers projects, lists them and finds one by slug", () => {
    const project = store.projects.register({
      slug: "haril",
      name: "HARIL",
      rootPath: "D:/github/haril",
    });
    expect(project.slug).toBe("haril");
    expect(store.projects.list().map((p) => p.slug)).toEqual(["haril"]);
    expect(store.projects.getBySlug("haril")?.projectId).toBe(project.projectId);
    expect(store.projects.getBySlug("missing")).toBeUndefined();
  });

  it("rejects a duplicate project slug with store.conflict", () => {
    store.projects.register({ slug: "haril", name: "HARIL", rootPath: "D:/a" });
    const error = caught(() =>
      store.projects.register({ slug: "haril", name: "again", rootPath: "D:/b" }),
    );
    expect(error.code).toBe("store.conflict");
  });

  it("[INV-08] enqueues a command once per idempotency key", () => {
    const first = store.commands.enqueue({
      type: "task.add",
      args: { goal: "x" },
      idempotencyKey: "key-1",
      requestHash: "hash-a",
    });
    expect(first.duplicate).toBe(false);

    const replay = store.commands.enqueue({
      type: "task.add",
      args: { goal: "x" },
      idempotencyKey: "key-1",
      requestHash: "hash-a",
    });
    expect(replay).toEqual({ commandId: first.commandId, duplicate: true });
    expect(store.commands.listQueued()).toHaveLength(1);
  });

  it("[INV-08] rejects a reused idempotency key with a different request hash", () => {
    store.commands.enqueue({
      type: "task.add",
      args: {},
      idempotencyKey: "key-1",
      requestHash: "hash-a",
    });
    const error = caught(() =>
      store.commands.enqueue({
        type: "task.add",
        args: {},
        idempotencyKey: "key-1",
        requestHash: "hash-b",
      }),
    );
    expect(error.code).toBe("store.conflict");
  });

  it("lists queued commands in enqueue order", () => {
    store.commands.enqueue({
      type: "task.add",
      args: { n: 1 },
      idempotencyKey: "a",
      requestHash: "h",
    });
    store.commands.enqueue({
      type: "task.add",
      args: { n: 2 },
      idempotencyKey: "b",
      requestHash: "h",
    });
    expect(store.commands.listQueued().map((c) => c.args)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("[INV-10] appends events with increasing seq and lists them in order", () => {
    const a = store.events.append({
      aggregateType: "task",
      aggregateId: "t-1",
      type: "task.created",
      actorKind: "system",
      actorId: "haril",
      payload: { goal: "one" },
    });
    const b = store.events.append({
      aggregateType: "task",
      aggregateId: "t-2",
      type: "task.created",
      actorKind: "system",
      actorId: "haril",
      payload: { goal: "two" },
    });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(store.events.list().map((e) => e.payload)).toEqual([{ goal: "one" }, { goal: "two" }]);
    expect(store.events.list({ aggregateId: "t-2" })).toHaveLength(1);
  });
});
