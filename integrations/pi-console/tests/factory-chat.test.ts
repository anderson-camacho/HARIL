import { describe, expect, it } from "vitest";
import { ASCII_FACTORY_GLYPHS, UNICODE_FACTORY_GLYPHS as G } from "../src/factory-kit.js";
import { NO_REMINDERS, quotaOfRead, reminderPass } from "../src/factory-reminders.js";
import {
  type FactoryState,
  factoryKey,
  factoryModelArrived,
  initialFactoryState,
} from "../src/factory-state.js";
import type { FactoryHumanRequest, FactoryModel } from "../src/factory-types.js";
import { renderFactoryScreen } from "../src/factory-view.js";
import { plainText, textWidth } from "../src/text.js";
import { model as factoryModel, NOW } from "./factory-fixture.js";

function screen(state: FactoryState, width = 100, rows = 30, g = G): string {
  return renderFactoryScreen(state, width, rows, g)
    .lines.map((line) => plainText(line))
    .join("\n");
}

function press(state: FactoryState, ...keys: string[]): FactoryState {
  return keys.reduce((current, key) => factoryKey(current, key).state, state);
}

function opened(model: Partial<FactoryModel> = {}, readOnly = false): FactoryState {
  const state = factoryModelArrived(
    { ...initialFactoryState(), readOnly },
    { ...factoryModel(), ...model },
  );
  return press(state, "4");
}

const REQUEST: FactoryHumanRequest = {
  kind: "human",
  id: "req-1",
  workflowId: "wf-stop",
  projectSlug: "demo",
  title: "web/git: Permiso para ejecutar git push origin web",
  explanation: {
    code: "human_request",
    what: "Permiso para ejecutar git push origin web",
    why: "publicar la página",
    systemAction: "Responde en la fábrica",
    needsHuman: true,
    until: null,
  },
  at: NOW,
  request: {
    reason: "git_publish",
    who: "web/git",
    delegatedBy: "web",
    task: "Publicar",
    doing: "Quiere ejecutar git push origin web",
    needs: "Permiso para ejecutar git push origin web",
    why: "publicar la página",
    ifRefused: "No se publica nada",
    blocks: ["web"],
    action: "git push origin web",
  },
};

describe("the chat with an agent", () => {
  it("opens with Enter or c, and follows chat-thread", () => {
    const state = opened();
    const code = state.model?.agents[0]?.code ?? "";
    for (const key of ["\r", "c"]) {
      const shown = screen(press(state, key));
      expect(shown).toContain("Agentes · chat");
      expect(shown).toContain("●");
      expect(shown).toContain("Mensaje a ");
      expect(shown).toContain("Enviar →");
      expect(shown).toContain(code);
    }
  });

  it("puts the agent's words left, yours right with its delivery state, and events inline", () => {
    const state = opened();
    const agent = state.model?.agents[0];
    const model: FactoryModel = {
      ...(state.model as FactoryModel),
      agents: (state.model as FactoryModel).agents.map((row) =>
        row === agent
          ? {
              ...row,
              said: [{ at: NOW - 3000, text: "Hice el cambio" }],
              activity: "editando auth.ts",
            }
          : row,
      ),
      events: [
        ...(state.model as FactoryModel).events,
        {
          at: NOW - 2000,
          type: "handoff",
          text: "pasa de opus a sonnet",
          workflowId: agent?.workflowId ?? "",
          agent: agent?.code ?? "",
        },
      ],
      messages: [
        {
          id: "m1",
          workflowId: agent?.workflowId ?? "",
          agent: agent?.code ?? "",
          text: "Usa el otro archivo",
          urgent: false,
          from: "ander",
          at: NOW - 1000,
          state: "waiting",
        },
      ],
    };
    const shown = press(factoryModelArrived(state, model), "c");
    const lines = screen(shown).split("\n");
    const left = lines.find((line) => line.includes("Hice el cambio")) as string;
    const right = lines.find((line) => line.includes("Usa el otro archivo")) as string;
    expect(left.indexOf("Hice")).toBeLessThan(30);
    expect(right.indexOf("Usa")).toBeGreaterThan(30);
    expect(screen(shown)).toContain("en espera del fin de turno");
    expect(screen(shown)).toContain("pasa de opus a sonnet");
    expect(screen(shown)).toContain("editando auth.ts...");
  });

  it("sends through the composer, and Tab makes it interrupt", () => {
    let state = press(opened(), "c", "h", "o", "l", "a");
    expect(screen(state)).toContain("hola_");
    state = press(state, "\t");
    expect(screen(state)).toContain("Interrumpirá");
    const sent = factoryKey(state, "\r");
    expect(sent.effect).toMatchObject({ kind: "message", text: "hola", urgent: true });
    expect(sent.state.chatDraft).toBe("");
  });

  it("is refused in a read-only mode", () => {
    const state = press(opened({}, true), "c", "h", "i");
    const sent = factoryKey(state, "\r");
    expect(sent.effect).toBeUndefined();
    expect(sent.state.notice).toContain("solo lectura");
    expect(screen(press(opened({}, true), "c"))).toContain("Este modo es de solo lectura");
  });

  it("keeps every width and height inside the screen", () => {
    const state = press(opened(), "c", "x");
    for (const g of [G, ASCII_FACTORY_GLYPHS]) {
      for (const width of [1, 7, 20, 40, 60, 79, 120, 200]) {
        for (const rows of [1, 2, 5, 8, 12, 30, 60]) {
          const { lines } = renderFactoryScreen(state, width, rows, g);
          expect(lines.length).toBeLessThanOrEqual(rows);
          for (const line of lines) {
            expect(textWidth(plainText(line))).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });
});

describe("a request in Te necesitan", () => {
  const onInbox = () =>
    press(
      factoryModelArrived(initialFactoryState(), {
        ...factoryModel(),
        humanRequests: [REQUEST, { ...REQUEST, id: "req-2" }],
      }),
      "2",
      "]",
      "]",
      "]",
      "]",
    );

  it("shows who asks, why and whom it blocks, and groups the same kind", () => {
    const shown = screen(onInbox());
    expect(shown).toContain("Permiso para ejecutar git push");
    expect(shown).toContain("2 de este tipo");
    expect(shown).toContain("bloquea a web");
  });

  it("answers approve, deny and in writing", () => {
    const approve = factoryKey(factoryKey(onInbox(), "a").state, "s");
    expect(approve.effect).toMatchObject({ kind: "answer", requestId: "req-1", answer: "approve" });
    const deny = factoryKey(factoryKey(onInbox(), "d").state, "s");
    expect(deny.effect).toMatchObject({ kind: "answer", answer: "deny" });
    const write = press(onInbox(), "w", "n", "o");
    expect(screen(write)).toContain("Tu respuesta: no_");
    expect(factoryKey(write, "\r").effect).toMatchObject({
      kind: "answer",
      answer: "write",
      text: "no",
    });
  });

  it("opens the whole record", () => {
    const shown = screen(press(onInbox(), "\r"), 100, 40);
    for (const text of [
      "Quién",
      "Lo delegó",
      "Hace",
      "Necesita",
      "Por qué",
      "Si niegas",
      "Bloquea a",
      "Ejecutará",
    ]) {
      expect(shown).toContain(text);
    }
  });

  it("counts on the board", () => {
    const state = press(
      factoryModelArrived(initialFactoryState(), { ...factoryModel(), humanRequests: [REQUEST] }),
      "3",
    );
    expect(screen(state)).toContain("Te necesitan 1");
  });
});

describe("the new views", () => {
  it("draws the map under Tablero, and a tree when it does not fit", () => {
    const state = press(factoryModelArrived(initialFactoryState(), factoryModel()), "3", "]");
    expect(state.tableroView).toBe("mapa");
    expect(screen(state, 120, 40)).toContain("╔");
    const small = screen(state, 40, 12);
    expect(small).not.toContain("╔");
    for (const g of [G, ASCII_FACTORY_GLYPHS]) {
      for (const width of [1, 20, 69, 70, 120, 200]) {
        for (const rows of [1, 5, 16, 18, 60]) {
          for (const line of renderFactoryScreen(state, width, rows, g).lines) {
            expect(textWidth(plainText(line))).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });

  it("draws the gates under Avance from stored facts", () => {
    const state = press(
      factoryModelArrived(initialFactoryState(), factoryModel()),
      "]",
      "]",
      "]",
      "]",
    );
    expect(state.avanceScope).toBe("compuertas");
    const shown = screen(state, 120, 40);
    for (const text of ["Plan", "Trabajo", "Pruebas", "Aceptación", "Publicar", "compuertas"]) {
      expect(shown).toContain(text);
    }
  });

  it("draws the git role's screen from what ran, and claims nothing when nothing did", () => {
    const base = factoryModelArrived(initialFactoryState(), factoryModel());
    const none = press({ ...base, sistemaView: "publicacion" }, "7");
    expect(screen(none, 100, 30)).toContain("no ha ejecutado nada");
    const ran = factoryModelArrived(none, {
      ...factoryModel(),
      gitActions: [
        {
          at: NOW,
          workflowId: "wf-stop",
          agent: "e1",
          level: "publish",
          command: "git push origin web",
          exitCode: 0,
          output: "* [new branch] web -> web\n",
        },
      ],
    });
    const shown = screen(ran, 100, 30);
    expect(shown).toContain("> git push origin web");
    expect(shown).toContain("✓ Publicado");
    expect(shown).toContain("[new branch]");
  });
});

describe("reminders", () => {
  const row = { id: "r1", title: "Permiso", group: "git_publish" };

  it("come after 1, 5 and 15 minutes, then every 15", () => {
    const start = 1_000_000;
    let state = reminderPass(NO_REMINDERS, [row], start, false).state;
    const at = (minutes: number) => start + minutes * 60_000;
    let pass = reminderPass(state, [row], at(0.5), false);
    expect(pass.lines).toEqual([]);
    state = pass.state;
    pass = reminderPass(state, [row], at(1), false);
    expect(pass.lines).toHaveLength(1);
    state = pass.state;
    pass = reminderPass(state, [row], at(5), false);
    expect(pass.lines).toEqual([]);
    state = pass.state;
    pass = reminderPass(state, [row], at(6), false);
    expect(pass.lines).toHaveLength(1);
    state = pass.state;
    pass = reminderPass(state, [row], at(21), false);
    expect(pass.lines).toHaveLength(1);
    state = pass.state;
    expect(reminderPass(state, [row], at(36), false).lines).toHaveLength(1);
  });

  it("stay silent while the factory is open, and join requests of one kind", () => {
    const start = 1_000_000;
    const later = start + 120_000;
    const two = [row, { ...row, id: "r2" }];
    const state = reminderPass(NO_REMINDERS, two, start, false).state;
    expect(reminderPass(state, two, later, true).lines).toEqual([]);
    const lines = reminderPass(state, two, later, false).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 peticiones");
  });

  it("read the quota answer, or nothing", () => {
    expect(quotaOfRead('{"quota":{"usedPct":85,"switchAt":80}}')).toEqual({
      usedPct: 85,
      switchAt: 80,
    });
    expect(quotaOfRead('{"quota":null}')).toBeNull();
    expect(quotaOfRead("nope")).toBeNull();
  });
});
