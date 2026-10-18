import { describe, expect, it } from "vitest";
import {
  actionRefusal,
  checkToolCall,
  commandRefusal,
  initialModeState,
  modeInstruction,
  modeLabel,
  nextMode,
  orderModeOf,
  parseMode,
  switchMode,
} from "../src/modes.js";

// The four console modes (F4, docs/modos-y-delegacion.md 7.1-7.5): ACTION works as Pi does; CONSULT and PLAN are
// read-only, deny by default and allow only read, grep, find, ls and haril_save_research; DELEGATION is read-only
// too, with no research tool. Leaving a read-only mode gives back the tools that were active before it.

const PI_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const REGISTERED = [...PI_TOOLS, "haril_save_research", "mcp__docs__search", "other_ext_tool"];
const DEFAULT_ACTIVE = ["read", "bash", "edit", "write"];

describe("mode names", () => {
  it("parses the names, the Spanish names and short aliases", () => {
    expect(parseMode("action")).toBe("action");
    expect(parseMode("Acción")).toBe("action");
    expect(parseMode("accion")).toBe("action");
    expect(parseMode("a")).toBe("action");
    expect(parseMode("consult")).toBe("consult");
    expect(parseMode("CONSULTA")).toBe("consult");
    expect(parseMode("c")).toBe("consult");
    expect(parseMode("plan")).toBe("plan");
    expect(parseMode("p")).toBe("plan");
    expect(parseMode("delegation")).toBe("delegation");
    expect(parseMode("delegación")).toBe("delegation");
    expect(parseMode("d")).toBe("delegation");
    expect(parseMode("write")).toBeUndefined();
    expect(parseMode("")).toBeUndefined();
  });

  it("labels each mode in English and maps it to the orders log vocabulary", () => {
    expect(
      ["action", "consult", "plan", "delegation"].map((mode) => modeLabel(mode as never)),
    ).toEqual(["ACTION", "CONSULT", "PLAN", "DELEGATION"]);
    expect(orderModeOf("action")).toBe("accion");
    expect(orderModeOf("consult")).toBe("consulta");
    expect(orderModeOf("plan")).toBe("plan");
    expect(orderModeOf("delegation")).toBe("delegacion");
  });

  it("cycles through the four modes", () => {
    expect(nextMode("action")).toBe("consult");
    expect(nextMode("consult")).toBe("plan");
    expect(nextMode("plan")).toBe("delegation");
    expect(nextMode("delegation")).toBe("action");
  });
});

describe("the CONSULT guard", () => {
  it("blocks every write and shell tool", () => {
    for (const tool of ["write", "edit", "bash", "powershell"]) {
      const verdict = checkToolCall("consult", tool);
      expect(verdict?.block, tool).toBe(true);
      expect(verdict?.reason).toMatch(/CONSULT/);
    }
  });

  it("blocks every foreign tool: other extensions, MCP, unknown names", () => {
    for (const tool of ["mcp__docs__search", "other_ext_tool", "haril_delegate", "Read", "read "]) {
      expect(checkToolCall("consult", tool)?.block, tool).toBe(true);
    }
  });

  it("allows only the read-only tools and the research tool", () => {
    for (const tool of ["read", "grep", "find", "ls", "haril_save_research"]) {
      expect(checkToolCall("consult", tool), tool).toBeUndefined();
    }
  });

  it("applies the same deny-by-default rule in PLAN, and DELEGATION has no research tool", () => {
    expect(checkToolCall("plan", "write")?.block).toBe(true);
    expect(checkToolCall("plan", "haril_save_research")).toBeUndefined();
    expect(checkToolCall("delegation", "edit")?.block).toBe(true);
    expect(checkToolCall("delegation", "haril_save_research")?.block).toBe(true);
    expect(checkToolCall("delegation", "read")).toBeUndefined();
  });

  it("leaves ACTION alone", () => {
    for (const tool of REGISTERED) expect(checkToolCall("action", tool)).toBeUndefined();
  });
});

describe("commands and actions in CONSULT", () => {
  it("refuses every command that changes HARIL state", () => {
    for (const name of ["init", "goal", "approve", "deny", "delegate", "continue"]) {
      expect(commandRefusal("consult", name), name).toMatch(/CONSULT/);
    }
  });

  it("keeps the read-only commands and the mode switch", () => {
    for (const name of ["tasks", "task", "events", "plans", "plan", "haril", "mode"]) {
      expect(commandRefusal("consult", name), name).toBeUndefined();
    }
  });

  it("refuses the mutating console actions, never the stops", () => {
    for (const action of [
      "register-project",
      "approvals",
      "goal",
      "run-queue",
      "start-runtime",
      "toggle-tools",
    ]) {
      expect(actionRefusal("consult", action), action).toMatch(/CONSULT/);
    }
    for (const action of ["stop-runtime", "tasks", "events", "details", "refresh", "model"]) {
      expect(actionRefusal("consult", action), action).toBeUndefined();
    }
  });

  it("does not refuse commands outside CONSULT", () => {
    for (const mode of ["action", "plan", "delegation"] as const) {
      expect(commandRefusal(mode, "goal")).toBeUndefined();
      expect(actionRefusal(mode, "toggle-tools")).toBeUndefined();
    }
  });
});

describe("switching modes", () => {
  it("narrows the tools to the read-only set on the way into CONSULT", () => {
    const step = switchMode(initialModeState(), "consult", DEFAULT_ACTIVE, REGISTERED);
    expect(step.state.mode).toBe("consult");
    expect(step.tools).toEqual(["read", "grep", "find", "ls", "haril_save_research"]);
    expect(step.state.toolsBefore).toEqual(DEFAULT_ACTIVE);
  });

  it("restores the tools that were active before, after a detour through PLAN", () => {
    const active = ["read", "bash", "edit", "write", "mcp__docs__search"];
    const consult = switchMode(initialModeState(), "consult", active, REGISTERED);
    const plan = switchMode(consult.state, "plan", consult.tools ?? [], REGISTERED);
    expect(plan.tools).toEqual(["read", "grep", "find", "ls", "haril_save_research"]);
    expect(plan.state.toolsBefore).toEqual(active);
    const back = switchMode(plan.state, "action", plan.tools ?? [], REGISTERED);
    expect(back.state).toEqual({ mode: "action", toolsBefore: undefined });
    expect(back.tools).toEqual(active);
  });

  it("never hands the research tool to ACTION", () => {
    const consult = switchMode(
      initialModeState(),
      "consult",
      ["read", "bash", "haril_save_research"],
      REGISTERED,
    );
    const back = switchMode(consult.state, "action", consult.tools ?? [], REGISTERED);
    expect(back.tools).toEqual(["read", "bash"]);
  });

  it("keeps only registered tools, and changes nothing for the same mode", () => {
    const step = switchMode(initialModeState(), "consult", DEFAULT_ACTIVE, ["read", "grep"]);
    expect(step.tools).toEqual(["read", "grep"]);
    const same = switchMode(step.state, "consult", step.tools ?? [], REGISTERED);
    expect(same.tools).toBeUndefined();
    expect(same.state).toBe(step.state);
    const action = switchMode(initialModeState(), "action", DEFAULT_ACTIVE, REGISTERED);
    expect(action.tools).toBeUndefined();
  });

  it("gives DELEGATION the read-only tools without research", () => {
    const step = switchMode(initialModeState(), "delegation", DEFAULT_ACTIVE, REGISTERED);
    expect(step.tools).toEqual(["read", "grep", "find", "ls"]);
  });
});

describe("mode instructions", () => {
  it("declares each read-only mode to the model, and nothing in ACTION", () => {
    expect(modeInstruction("action")).toBeUndefined();
    expect(modeInstruction("consult")).toMatch(/CONSULT mode.*read-only/s);
    expect(modeInstruction("consult")).toMatch(/haril_save_research/);
    expect(modeInstruction("plan")).toMatch(/PLAN mode/);
    expect(modeInstruction("plan")).toMatch(/\/goal/);
    expect(modeInstruction("delegation")).toMatch(/DELEGATION mode/);
  });
});
