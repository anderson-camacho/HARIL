import { describe, expect, it, vi } from "vitest";
// The wire types are twins: the console cannot import the contracts package, so these comparisons are what keep them
// equal. A field added, removed or changed on one side stops this file compiling (tsc -p integrations/pi-console).
import {
  type FactoryModel as ContractModel,
  isFactoryModel,
} from "../../../packages/contracts/src/factory-model.js";
import type {
  WaitExplanation as ContractExplanation,
  WorkflowSnapshot as ContractSnapshot,
} from "../../../packages/contracts/src/workflow-snapshot.js";
import { parseFactoryLine, startFactoryFeed } from "../src/factory-feed.js";
import type { FactoryModel } from "../src/factory-types.js";
import type { WaitExplanation, WorkflowSnapshot } from "../src/orchestration-types.js";
import { model, task, workflow } from "./factory-fixture.js";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
type Same<A, B> =
  (<T>() => T extends Mutable<A> ? 1 : 2) extends <T>() => T extends Mutable<B> ? 1 : 2
    ? true
    : false;
const modelsAreTwins: Same<FactoryModel, ContractModel> = true;
const explanationsAreTwins: Same<WaitExplanation, ContractExplanation> = true;
const explanationOfWorkflow: Same<
  WorkflowSnapshot["workflow"]["explanation"],
  ContractSnapshot["workflow"]["explanation"]
> = true;

describe("the factory's wire types", () => {
  it("are the contracts' types, and the fixture is a model the contracts accept", () => {
    expect([modelsAreTwins, explanationsAreTwins, explanationOfWorkflow]).toEqual([
      true,
      true,
      true,
    ]);
    expect(isFactoryModel(model())).toBe(true);
  });
});

describe("parseFactoryLine", () => {
  it("reads a valid line", () => {
    expect(parseFactoryLine(JSON.stringify(model()))).toEqual(model());
  });

  it("drops a line that is not JSON, another version, or a model with a bad row", () => {
    const bad: unknown[] = [
      { ...model(), schemaVersion: 2 },
      { ...model(), workflows: [{ ...workflow(), state: "sleeping" }] },
      { ...model(), tasks: [{ ...task(), column: "limbo" }] },
      { ...model(), tasks: [{ ...task(), explanation: { code: "x" } }] },
      { ...model(), agents: [{ code: "e1" }] },
      { ...model(), events: "none" },
      { ...model(), humanRequests: [{ kind: "wish" }] },
      { ...model(), edges: [{ parent: 1 }] },
      [],
      null,
    ];
    expect(parseFactoryLine("not json")).toBeUndefined();
    for (const value of bad) expect(parseFactoryLine(JSON.stringify(value))).toBeUndefined();
  });
});

interface FakeChild {
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  closed: boolean;
  line(text: string): void;
  exit(code: number | null): void;
}

function fakeStream() {
  const children: FakeChild[] = [];
  const stream = ((
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly onLine: (line: string) => void;
      readonly onExit?: (code: number | null) => void;
    },
  ) => {
    const child: FakeChild = {
      args,
      cwd: options.cwd,
      closed: false,
      line: options.onLine,
      exit: (code) => options.onExit?.(code),
    };
    children.push(child);
    return {
      running: true,
      close() {
        child.closed = true;
      },
    };
  }) as Parameters<typeof startFactoryFeed>[1];
  return { children, stream };
}

function feedHost() {
  const models: FactoryModel[] = [];
  let ended = 0;
  return {
    models,
    ended: () => ended,
    host: {
      cwd: () => "/work",
      projectSlug: (): string | undefined => "demo",
      onModel: (row: FactoryModel) => {
        models.push(row);
      },
      onEnded: () => {
        ended += 1;
      },
    },
  };
}

describe("startFactoryFeed", () => {
  it("runs haril factory watch for the project, as a child that ends with the console", () => {
    const { children, stream } = fakeStream();
    const { host } = feedHost();
    startFactoryFeed(host, stream);
    expect(children[0]?.args).toEqual([
      "factory",
      "watch",
      "--json",
      "--project",
      "demo",
      "--exit-on-stdin-end",
    ]);
    expect(children[0]?.cwd).toBe("/work");
  });

  it("follows every project when the folder has none", () => {
    const { children, stream } = fakeStream();
    startFactoryFeed({ ...feedHost().host, projectSlug: () => undefined }, stream);
    expect(children[0]?.args).not.toContain("--project");
  });

  it("hands over valid lines, drops the rest, and hears nothing once it is closed", () => {
    const { children, stream } = fakeStream();
    const seen = feedHost();
    const feed = startFactoryFeed(seen.host, stream);
    children[0]?.line(JSON.stringify(model()));
    children[0]?.line("garbage");
    expect(seen.models).toHaveLength(1);
    feed.close();
    expect(children[0]?.closed).toBe(true);
    children[0]?.line(JSON.stringify(model()));
    children[0]?.exit(1);
    expect(seen.models).toHaveLength(1);
    expect(seen.ended()).toBe(0);
  });

  it("starts a child that died again, a bounded number of times, then says the data stopped", () => {
    vi.useFakeTimers();
    try {
      const { children, stream } = fakeStream();
      const seen = feedHost();
      startFactoryFeed(seen.host, stream, [10, 20]);
      children[0]?.exit(1);
      vi.advanceTimersByTime(10);
      expect(children).toHaveLength(2);
      // A line read resets the count: only a child that keeps dying gives up.
      children[1]?.line(JSON.stringify(model()));
      children[1]?.exit(1);
      vi.advanceTimersByTime(10);
      expect(children).toHaveLength(3);
      children[2]?.exit(1);
      vi.advanceTimersByTime(20);
      expect(children).toHaveLength(4);
      children[3]?.exit(1);
      expect(seen.ended()).toBe(1);
      expect(children).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the data stopped when the CLI is not there", () => {
    const seen = feedHost();
    startFactoryFeed(seen.host, (() => undefined) as never);
    expect(seen.ended()).toBe(1);
  });
});
