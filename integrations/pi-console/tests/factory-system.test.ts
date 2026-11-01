import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DELEGATION_FIELDS } from "../../../packages/contracts/src/delegation-config.js";
import { runFactoryAction } from "../src/factory-actions.js";
import { ASCII_FACTORY_GLYPHS, UNICODE_FACTORY_GLYPHS } from "../src/factory-kit.js";
import {
  type FactorySystemData,
  loadFactorySystem,
  settingLabel,
} from "../src/factory-settings.js";
import {
  type FactoryState,
  factoryKey,
  factoryModelArrived,
  factorySystemArrived,
  initialFactoryState,
} from "../src/factory-state.js";
import { renderFactoryScreen } from "../src/factory-view.js";
import { plainText, textWidth } from "../src/text.js";
import { model } from "./factory-fixture.js";

const ENTER = "\r";
const ESC = "\u001b";
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;
const screen = (state: FactoryState, width = 120, rows = 34, g = UNICODE_FACTORY_GLYPHS): string =>
  renderFactoryScreen(state, width, rows, g).lines.map(plainText).join("\n");

const settings = JSON.parse(
  readFileSync(new URL("./fixtures/delegation-settings.json", import.meta.url), "utf8"),
);

const DATA: FactorySystemData = {
  settings,
  skills: ["revisar", "commit"],
  mcp: [{ name: "engram", state: "connected" }],
  tools: [{ name: "Engram", state: "ok" }],
  memory: { state: "ok", detail: "engram: active, 0 pendientes" },
};

function opened(view: FactoryState["sistemaView"] = "mapa"): FactoryState {
  const state = factorySystemArrived(
    factoryModelArrived({ ...initialFactoryState(), tab: "sistema", sistemaView: view }, model()),
    DATA,
  );
  return state;
}

// The settings view with the cursor on a field.
function on(path: string, change: Partial<FactoryState> = {}): FactoryState {
  const state = { ...opened("ajustes"), ...change };
  const fields = state.system?.settings?.fields ?? [];
  return {
    ...state,
    selection: { ...state.selection, sistema: fields.findIndex((f) => f.path === path) },
  };
}

const PERCENT = "delegation.quota.switchAtPercent5h";
const SWITCH = "delegation.models.auditorDistinctFromExecutor";

describe("the architecture map", () => {
  it("draws each piece with its real health", () => {
    const text = screen(opened());
    for (const name of ["Consola", "Runtime", "CLIProxy", "Cuentas", "SQLite", "Engram"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("engram: active, 0 pendientes");
    expect(text).toContain("Sin runtime en marcha");
    expect(text).toContain("el servidor de gestión no responde");
    expect(text).toContain("esquema 19");
    expect(text).toContain("3 leídas");
  });

  it("warns of a role with one vendor", () => {
    expect(screen(opened())).toContain("el rol git solo llega a anthropic");
  });

  it("falls back to a list when narrow", () => {
    const text = screen(opened(), 50);
    expect(text).toContain("Runtime");
    expect(text).not.toContain("pasarela");
  });
});

describe("the inventory", () => {
  it("lists skills, MCP, integrations and templates with their state", () => {
    const text = screen(opened("inventario"));
    expect(text).toContain("revisar, commit");
    expect(text).toContain("engram: conectado");
    expect(text).toContain("Engram: al día");
    expect(text).toContain("Plantillas");
  });
});

describe("the settings screen", () => {
  it("has a Spanish label for every field HARIL's table holds", () => {
    for (const field of DELEGATION_FIELDS) {
      const label = settingLabel({ path: `delegation.${field.path}`, label: field.label });
      expect(label, field.path).not.toBe(field.label);
    }
  });

  it("shows a slider with its consequence, range, default and source", () => {
    const text = screen(on(PERCENT));
    expect(text).toContain("Cambiar de modelo desde (5 horas)");
    expect(text).toContain("●");
    expect(text).toContain("Aplica a la próxima elección de modelo.");
    expect(text).toContain("Rango 0 a 100");
    expect(text).toContain("Por defecto 80 %");
  });

  it("moves a slider with the arrows without saving, and Enter saves through the CLI", () => {
    const moved = factoryKey(on(PERCENT), RIGHT).state;
    expect(moved.tab).toBe("sistema");
    expect(moved.settingDraft).toEqual({ path: PERCENT, value: 85 });
    expect(screen(moved)).toContain("sin guardar");
    expect(screen(moved)).not.toContain("Guardado");
    expect(factoryKey(moved, LEFT).state.settingDraft?.value).toBe(80);
    const saved = factoryKey(moved, ENTER);
    expect(saved.effect).toMatchObject({ kind: "setting", path: PERCENT, value: "85" });
    expect(saved.state.settingDraft).toBeNull();
  });

  it("stops a slider at its ends", () => {
    let state = on(PERCENT);
    for (let press = 0; press < 30; press++) state = factoryKey(state, RIGHT).state;
    expect(state.settingDraft?.value).toBe(100);
  });

  it("asks for an exact value with Enter, and Esc leaves it alone", () => {
    const editing = factoryKey(on(PERCENT), ENTER).state;
    expect(editing.settingEdit).toEqual({ path: PERCENT, text: "80" });
    const typed = factoryKey(
      factoryKey(factoryKey(editing, "\u007f").state, "\u007f").state,
      "72",
    ).state;
    expect(typed.settingEdit?.text).toBe("72");
    expect(screen(typed)).toContain("72_");
    expect(factoryKey(typed, ENTER).effect).toMatchObject({ kind: "setting", value: "72" });
    expect(factoryKey(typed, ESC).state.settingEdit).toBeNull();
    expect(factoryKey(typed, ESC).effect).toBeUndefined();
  });

  it("flips a switch with Enter and saves at once", () => {
    const transition = factoryKey(on(SWITCH), ENTER);
    expect(transition.effect).toMatchObject({ kind: "setting", path: SWITCH, value: "false" });
  });

  it("says Guardado only after the write succeeded", async () => {
    const calls: (readonly string[])[] = [];
    const deps = (ok: boolean) => ({
      run: async (args: readonly string[]) => {
        calls.push(args);
        return { ok, code: ok ? 0 : 2, stdout: "", stderr: ok ? "" : "haril: must be a number" };
      },
      ensureRuntime: async () => undefined,
      refusal: () => undefined,
    });
    const action = { kind: "setting" as const, path: PERCENT, value: "85", label: "x" };
    expect(await runFactoryAction(action, deps(true))).toContain("✓ Guardado");
    expect(calls[0]).toEqual(["config", "set", PERCENT, "85", "--json"]);
    const failed = await runFactoryAction(action, deps(false));
    expect(failed).toBe("haril: must be a number");
    expect(screen(on(PERCENT))).not.toContain("Guardado");
    expect(screen(on(PERCENT, { savedPath: PERCENT }))).toContain("✓ Guardado");
  });

  it("is refused by the mode, without a command", async () => {
    const locked = on(PERCENT, { settingsLocked: true });
    expect(screen(locked)).toContain("solo lectura");
    for (const key of [ENTER, RIGHT]) {
      const transition = factoryKey(locked, key);
      expect(transition.effect).toBeUndefined();
      expect(transition.state.settingDraft).toBeNull();
      expect(transition.state.settingEdit).toBeNull();
    }
    expect(factoryKey(locked, ENTER).state.notice).toContain("solo lectura");
    let ran = false;
    const answer = await runFactoryAction(
      { kind: "setting", path: PERCENT, value: "85", label: "x" },
      {
        run: async () => {
          ran = true;
          return { ok: true, code: 0, stdout: "", stderr: "" };
        },
        ensureRuntime: async () => undefined,
        refusal: (command) => (command === "config" ? "no en este modo" : undefined),
      },
    );
    expect(ran).toBe(false);
    expect(answer).toBe("no en este modo");
  });

  it("never shows a secret's value, and shows a variable's name", () => {
    const field = {
      path: "delegation.quota.managementKey",
      group: "quota",
      label: "x",
      kind: { type: "url-or-null" as const },
      value: "sk-should-not-show",
      default: null,
      source: "file" as const,
      effect: "next model choice",
    };
    const state = factorySystemArrived(
      factoryModelArrived(
        { ...initialFactoryState(), tab: "sistema", sistemaView: "ajustes" },
        model(),
      ),
      { ...DATA, settings: { configPath: "x", fields: [field] } },
    );
    const text = screen(state);
    expect(text).not.toContain("sk-should-not-show");
    expect(text).toContain("(oculto)");
    expect(screen(on("delegation.quota.managementKeyEnv"))).toContain("CLIPROXYAPI_MANAGEMENT_KEY");
  });

  it("leaves the arrows to the tabs on a field that is not a slider, and on the other views", () => {
    expect(factoryKey(on(SWITCH), RIGHT).state.tab).toBe("avance");
    expect(factoryKey(opened("mapa"), RIGHT).state.tab).toBe("avance");
  });

  it("moves between views with [ and ]", () => {
    expect(factoryKey(opened("mapa"), "]").state.sistemaView).toBe("inventario");
    expect(factoryKey(opened("mapa"), "[").state.sistemaView).toBe("ajustes");
  });
});

describe("loadFactorySystem", () => {
  const catalog = {
    skills: [
      {
        name: "revisar",
        description: undefined,
        path: undefined,
        source: undefined,
        modelInvocable: true,
      },
    ],
    servers: [],
    warnings: [],
    mcpCommand: true,
    globalFile: "",
    projectFile: "",
    agentDir: "",
  };

  it("reads each part, and one that fails leaves only its own gap", async () => {
    const data = await loadFactorySystem({
      run: async (args) =>
        args[0] === "config"
          ? { ok: true, code: 0, stdout: JSON.stringify(settings), stderr: "" }
          : { ok: false, code: 2, stdout: "", stderr: "no" },
      catalog: () => catalog,
    });
    expect(data.settings?.fields.length).toBeGreaterThan(10);
    expect(data.skills).toEqual(["revisar"]);
    expect(data.tools).toEqual([]);
    expect(data.memory.state).toBe("unknown");
  });

  it("says the settings could not be read", async () => {
    const data = await loadFactorySystem({
      run: async () => ({ ok: false, code: 2, stdout: "not json", stderr: "" }),
      catalog: () => catalog,
    });
    expect(data.settings).toBeNull();
  });
});

describe("the tab", () => {
  it("stays inside its width at every size and view", () => {
    for (const view of ["mapa", "inventario", "ajustes"] as const) {
      for (const g of [UNICODE_FACTORY_GLYPHS, ASCII_FACTORY_GLYPHS]) {
        for (const width of [1, 7, 20, 40, 60, 79, 120, 200]) {
          for (const rows of [1, 4, 6, 9, 24, 60]) {
            const { lines } = renderFactoryScreen(opened(view), width, rows, g);
            expect(lines.length).toBeLessThanOrEqual(rows);
            for (const line of lines) expect(textWidth(plainText(line))).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });
});
