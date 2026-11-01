import { describe, expect, it } from "vitest";
import { runFactoryAction } from "../src/factory-actions.js";

function deps(overrides: { ok?: boolean; stderr?: string; note?: string; refused?: string } = {}) {
  const calls: (readonly string[])[] = [];
  let runtimes = 0;
  return {
    calls,
    runtimes: () => runtimes,
    deps: {
      run: async (args: readonly string[]) => {
        calls.push(args);
        return {
          ok: overrides.ok ?? true,
          code: overrides.ok === false ? 2 : 0,
          stdout: "",
          stderr: overrides.stderr ?? "",
        };
      },
      ensureRuntime: async () => {
        runtimes += 1;
        return overrides.note;
      },
      refusal: () => overrides.refused,
    },
  };
}

const CONTINUE = {
  kind: "continue",
  workflowId: "wf-1",
  projectSlug: "demo",
  label: "continuar",
} as const;

describe("runFactoryAction", () => {
  it("continues a workflow through haril workflow continue and makes sure a runtime runs", async () => {
    const seen = deps({ note: "runtime started" });
    expect(await runFactoryAction(CONTINUE, seen.deps)).toBe(
      "El flujo wf-1 continúa. runtime started",
    );
    expect(seen.calls).toEqual([["workflow", "continue", "wf-1", "--project", "demo"]]);
    expect(seen.runtimes()).toBe(1);
  });

  it("approves and denies through haril approve and deny; a denial needs no runtime", async () => {
    const approving = deps();
    expect(
      await runFactoryAction({ kind: "approve", approvalId: "a1", label: "x" }, approving.deps),
    ).toBe("Plan aprobado.");
    expect(approving.calls).toEqual([["approve", "a1"]]);
    expect(approving.runtimes()).toBe(1);
    const denying = deps();
    expect(
      await runFactoryAction({ kind: "deny", approvalId: "a1", label: "x" }, denying.deps),
    ).toBe("Plan negado.");
    expect(denying.calls).toEqual([["deny", "a1"]]);
    expect(denying.runtimes()).toBe(0);
  });

  it("shows what the command said when it failed, and starts nothing", async () => {
    const seen = deps({ ok: false, stderr: "\nharil: no workflow\nmore" });
    expect(await runFactoryAction(CONTINUE, seen.deps)).toBe("haril: no workflow");
    expect(seen.runtimes()).toBe(0);
  });

  it("runs nothing when the mode refuses it", async () => {
    const seen = deps({ refused: "CONSULT mode is read-only" });
    expect(await runFactoryAction(CONTINUE, seen.deps)).toBe("CONSULT mode is read-only");
    expect(seen.calls).toEqual([]);
  });
});
