import { describe, expect, it } from "vitest";
import { NOT_LAUNCHED } from "../src/cli.js";
import { type DockDetails, type DockSource, loadDockDetails } from "../src/dock-details.js";
import { CARD_CONTENT_WIDTH } from "../src/rail-metrics.js";
import { textWidth } from "../src/text.js";
import {
  COPY,
  engram,
  GO_ENGRAM,
  GO_GENTLE,
  gentle,
  install,
  memoryJson,
  statusJson,
} from "./tools-fixtures.js";

// The TOOLS tab: what `haril tools status --json` and `haril memory status --json` say, as the 40-column right panel
// shows it. The two commands are the only source; these tests give the view the JSON they print.

// A card gives a row CARD_CONTENT_WIDTH columns; the plain lines of the left dock indent a row by two more.
const FITS = CARD_CONTENT_WIDTH + 2;
const answer = (stdout: string) => async () => ({ ok: true, stdout, stderr: "" });
const failure = (stderr: string) => async () => ({ ok: false, stdout: "", stderr });

function source(tools: string, memory: string, extra: DockSource = {}): DockSource {
  return { tools: answer(tools), memory: answer(memory), ...extra };
}

async function mem(src: DockSource): Promise<DockDetails> {
  return loadDockDetails("memory", ".", src);
}

function expectRowsToFit(details: DockDetails): void {
  for (const line of details.lines) expect([line, textWidth(line) <= FITS]).toEqual([line, true]);
  for (const card of details.cards ?? []) {
    for (const row of card.rows) {
      expect([row, textWidth(row) <= CARD_CONTENT_WIDTH]).toEqual([row, true]);
    }
    for (const button of card.buttons ?? []) {
      expect([button.label, textWidth(button.label) <= CARD_CONTENT_WIDTH - 4]).toEqual([
        button.label,
        true,
      ]);
    }
  }
}

function rowOf(details: DockDetails, action: string): string | undefined {
  const found = details.actions?.find((item) => item.action === action);
  return found === undefined ? undefined : details.lines[found.line];
}

const text = (details: DockDetails): string => details.lines.join("\n");

describe("the TOOLS view with everything in order", () => {
  it("says in words that Engram, the memory process and gentle-ai are fine", async () => {
    const details = await mem(source(statusJson([engram(), gentle()]), memoryJson()));
    expect(details.id).toBe("memory");
    expect(details.status).toBe("Tools");
    expect(details.lines).toContain("Engram · ok");
    expect(details.lines).toContain("  3.6.0 · copia de HARIL");
    expect(details.lines).toContain("  D:\\HARIL\\engram\\3.6.0\\engram.exe");
    expect(details.lines).toContain("  Probada por HARIL: 3.6.0");
    expect(details.lines).toContain("  Última publicada: 3.6.0");
    expect(details.lines).toContain("Proceso de memoria");
    expect(details.lines).toContain("  Proveedor: engram · persistente");
    expect(details.lines).toContain("  Runtime: en marcha");
    expect(details.lines).toContain("  Salud: active");
    expect(details.lines).toContain("  Degradada: no");
    expect(details.lines).toContain("  Cola: 0 por entregar");
    expect(details.lines).toContain("gentle-ai · ok");
    expect(details.lines).toContain("  4.3.1 · PATH + go/bin");
    expect(details.lines).toContain("  Última publicada: 4.3.1");
    expectRowsToFit(details);
  });

  it("offers the four actions, each on its own row, and the pane can find them by line", async () => {
    const details = await mem(source(statusJson([engram(), gentle()]), memoryJson()));
    expect(details.actions?.map((item) => item.action)).toEqual([
      "tools:ensure",
      "tools:force",
      "tools:refresh",
      "tools:update",
    ]);
    expect(rowOf(details, "tools:ensure")).toBe("▸ Comprobar e instalar Engram");
    expect(rowOf(details, "tools:force")).toBe("▸ Reinstalar Engram (forzar)");
    expect(rowOf(details, "tools:refresh")).toBe("▸ Comprobar versiones ahora");
    expect(rowOf(details, "tools:update")).toBe("▸ Actualizar gentle-ai…");
    for (const item of details.actions ?? []) {
      expect(details.lines[item.line]?.startsWith("▸ ")).toBe(true);
    }
  });

  it("speaks English when the console does", async () => {
    const details = await mem(
      source(statusJson([engram(), gentle()]), memoryJson(), { locale: "en" }),
    );
    expect(details.status).toBe("Tools");
    expect(details.lines).toContain("  3.6.0 · HARIL copy");
    expect(details.lines).toContain("  Qualified by HARIL: 3.6.0");
    expect(details.lines).toContain("  Latest published: 3.6.0");
    expect(details.lines).toContain("Memory process");
    expect(details.lines).toContain("  Provider: engram · persistent");
    expect(details.lines).toContain("  Runtime: running");
    expect(details.lines).toContain("  Health: active");
    expect(details.lines).toContain("  Degraded: no");
    expect(details.lines).toContain("  Queue: 0 to deliver");
    expect(rowOf(details, "tools:ensure")).toBe("▸ Check and install Engram");
    expect(rowOf(details, "tools:force")).toBe("▸ Force reinstall Engram");
    expect(rowOf(details, "tools:refresh")).toBe("▸ Check versions now");
    expect(rowOf(details, "tools:update")).toBe("▸ Update gentle-ai…");
    expectRowsToFit(details);
  });
});

describe("Engram in the TOOLS view", () => {
  it("says it is missing and lists the user's other copy as not used by HARIL", async () => {
    const other = install(GO_ENGRAM, "3.3.2", ["go-bin"], false);
    const details = await mem(
      source(
        statusJson([
          engram({ state: "missing", active: null, installs: [other], latest: null }),
          gentle(),
        ]),
        memoryJson(),
      ),
    );
    expect(details.lines).toContain("Engram · falta");
    expect(details.lines).toContain("  No hay copia que HARIL ejecute.");
    expect(details.lines).toContain("  Otras copias, que HARIL no usa:");
    expect(details.lines).toContain("    3.3.2 · go/bin");
    expect(details.lines).toContain("    C:\\Users\\ana\\go\\bin\\engram.exe");
    expect(details.lines).toContain("  Última publicada: sin consultar");
    expectRowsToFit(details);
  });

  it("says it is outdated, and says when its version could not be read", async () => {
    const old = install(COPY, "3.5.0", ["haril"]);
    const outdated = await mem(
      source(
        statusJson([engram({ state: "outdated", active: old, installs: [old] }), gentle()]),
        memoryJson(),
      ),
    );
    expect(outdated.lines).toContain("Engram · desactualizado");
    expect(outdated.lines).toContain("  3.5.0 · copia de HARIL");

    const blind = install(COPY, null, ["haril"]);
    const unknown = await mem(
      source(
        statusJson([engram({ state: "unknown", active: blind, installs: [blind] }), gentle()]),
        memoryJson(),
      ),
    );
    expect(unknown.lines).toContain("Engram · desconocido");
    expect(unknown.lines).toContain("  versión ? · copia de HARIL");
  });

  it("notices a newer upstream Engram without offering it", async () => {
    const details = await mem(
      source(
        statusJson([engram({ newerUpstream: true, latest: "3.9.0" }), gentle()]),
        memoryJson(),
      ),
    );
    expect(details.lines).toContain("Engram · ok");
    expect(details.lines).toContain("  Última publicada: 3.9.0");
    const body = text(details).replace(/\s+/g, " ");
    expect(body).toContain("Hay una más nueva (3.9.0)");
    expect(body).toContain("HARIL la usará cuando la pruebe");
    expectRowsToFit(details);
  });

  it("flags a memory.binary override as the source of the active copy", async () => {
    const custom = install("D:\\mi\\engram.exe", "3.6.0", ["config"]);
    const details = await mem(
      source(statusJson([engram({ active: custom, installs: [custom] }), gentle()]), memoryJson()),
    );
    expect(details.lines).toContain("  3.6.0 · memory.binary");
  });

  it("shows the last failed install and when HARIL tries again while the cooldown runs", async () => {
    const missing = engram({ state: "missing", active: null, installs: [] });
    const details = await mem(
      source(
        statusJson([missing, gentle()], {
          engramInstallFailure: {
            failedAt: "2026-10-30T09:00:00.000Z",
            message: "could not download checksums.txt: network error: fetch failed",
            retryAt: "2026-10-30T15:00:00.000Z",
          },
        }),
        memoryJson(),
      ),
    );
    expect(details.lines).toContain("  Falló la última instalación:");
    const body = text(details).replace(/\s+/g, " ");
    expect(body).toContain("could not download checksums.txt: network error: fetch failed");
    expect(body).toMatch(/Reintenta sola desde .+\./);
    expectRowsToFit(details);
  });

  it("says a new attempt is allowed now once the cooldown is over, and in English", async () => {
    const missing = engram({ state: "missing", active: null, installs: [] });
    const details = await mem(
      source(
        statusJson([missing, gentle()], {
          engramInstallFailure: {
            failedAt: "2026-10-29T01:00:00.000Z",
            message: "checksum mismatch",
            retryAt: null,
          },
        }),
        memoryJson(),
        { locale: "en" },
      ),
    );
    expect(details.lines).toContain("  The last install failed:");
    expect(details.lines).toContain("  checksum mismatch");
    expect(details.lines).toContain("  A new attempt is allowed now.");
  });

  it("does not show an old failure for an Engram that is fine now", async () => {
    const details = await mem(
      source(
        statusJson([engram(), gentle()], {
          engramInstallFailure: {
            failedAt: "2026-10-30T09:00:00.000Z",
            message: "stale",
            retryAt: null,
          },
        }),
        memoryJson(),
      ),
    );
    expect(text(details)).not.toContain("stale");
    expect(text(details)).not.toContain("Falló la última instalación");
  });

  it("keeps a long path and a long failure inside the panel", async () => {
    const long = install(`D:\\${"carpeta-muy-larga\\".repeat(6)}engram.exe`, "3.6.0", ["haril"]);
    const missing = engram({ state: "missing", active: null, installs: [long] });
    const details = await mem(
      source(
        statusJson([missing, gentle()], {
          engramInstallFailure: {
            failedAt: "2026-10-30T09:00:00.000Z",
            message: `network error: ${"x".repeat(150)}`,
            retryAt: "2026-10-30T15:00:00.000Z",
          },
        }),
        memoryJson(),
      ),
    );
    expectRowsToFit(details);
  });
});

describe("gentle-ai in the TOOLS view", () => {
  it("says it is outdated, with both versions, where it is and how to update it", async () => {
    const old = install(GO_GENTLE, "4.0.0", ["go-bin"]);
    const details = await mem(
      source(
        statusJson([
          engram(),
          gentle({ state: "outdated", active: old, installs: [old], latest: "4.3.1" }),
        ]),
        memoryJson(),
      ),
    );
    expect(details.lines).toContain("gentle-ai · desactualizado");
    expect(details.lines).toContain("  4.0.0 · go/bin");
    expect(details.lines).toContain("  C:\\Users\\ana\\go\\bin\\gentle-ai.exe");
    expect(details.lines).toContain("  Última publicada: 4.3.1");
    const body = text(details).replace(/\s+/g, " ");
    expect(body).toContain("Hay una versión más nueva: usa «Actualizar gentle-ai».");
    expect(body).toContain("Solo está en go/bin, que no está en el PATH.");
    expect(rowOf(details, "tools:update")).toBe("▸ Actualizar gentle-ai…");
    expectRowsToFit(details);
  });

  it("says it is missing, and the update row offers to install it", async () => {
    const details = await mem(
      source(
        statusJson([engram(), gentle({ state: "missing", active: null, installs: [] })]),
        memoryJson(),
      ),
    );
    expect(details.lines).toContain("gentle-ai · falta");
    expect(text(details).replace(/\s+/g, " ")).toContain(
      "No se encontró. «Instalar gentle-ai» lo compila con Go.",
    );
    expect(rowOf(details, "tools:update")).toBe("▸ Instalar gentle-ai…");
  });

  it("says the latest version was never checked, and what to do about it", async () => {
    const old = install(GO_GENTLE, "4.0.0", ["path"]);
    const details = await mem(
      source(
        statusJson([
          engram(),
          gentle({
            state: "unknown",
            active: old,
            installs: [old],
            latest: null,
            latestCheckedAt: null,
          }),
        ]),
        memoryJson(),
      ),
    );
    expect(details.lines).toContain("gentle-ai · desconocido");
    expect(details.lines).toContain("  Última publicada: sin consultar");
    expect(text(details).replace(/\s+/g, " ")).toContain("usa «Comprobar versiones ahora»");
  });

  it("lists the other copies it found, as the ones that do not run", async () => {
    const active = install("C:\\bin\\gentle-ai.exe", "4.3.1", ["path"]);
    const other = install(GO_GENTLE, "4.0.0", ["go-bin"], false);
    const details = await mem(
      source(statusJson([engram(), gentle({ active, installs: [active, other] })]), memoryJson()),
    );
    expect(details.lines).toContain("  Otras copias, que no se ejecutan:");
    expect(details.lines).toContain("    4.0.0 · go/bin");
  });

  it("repeats the CLI's own words when something could not be read", async () => {
    const details = await mem(
      source(
        statusJson([
          engram(),
          gentle({ notes: ["could not check the latest version: network error: fetch failed"] }),
        ]),
        memoryJson(),
      ),
    );
    expect(text(details).replace(/\s+/g, " ")).toContain(
      "could not check the latest version: network error: fetch failed",
    );
  });
});

describe("the memory process in the TOOLS view", () => {
  it("makes a null provider obvious and says how to turn Engram on", async () => {
    const missing = engram({ state: "missing", active: null, installs: [] });
    const details = await mem(
      source(
        statusJson([missing, gentle()]),
        memoryJson({
          provider: "null",
          persistent: false,
          health: "not_checked",
          runtime: "not_running",
        }),
      ),
    );
    expect(details.lines).toContain("Proceso de memoria · NO GUARDA");
    expect(details.lines).toContain("  Proveedor: null (no guarda nada)");
    const body = text(details).replace(/\s+/g, " ");
    expect(body).toContain("Para activar Engram:");
    expect(body).toContain("haril tools ensure");
    expect(body).toContain("reinicia el runtime");
    expectRowsToFit(details);

    const english = await mem(
      source(
        statusJson([missing, gentle()]),
        memoryJson({
          provider: "null",
          persistent: false,
          health: "not_checked",
          runtime: "not_running",
        }),
        { locale: "en" },
      ),
    );
    expect(english.lines).toContain("Memory process · NOT SAVING");
    expect(english.lines).toContain("  Provider: null (keeps nothing)");
    expect(text(english).replace(/\s+/g, " ")).toContain("To turn Engram on:");
    expect(text(english).replace(/\s+/g, " ")).toContain("then restart the runtime");
  });

  it("asks only for a restart when Engram is ready and the provider is still null", async () => {
    const nullMemory = memoryJson({
      provider: "null",
      persistent: false,
      health: "not_checked",
      runtime: "not_running",
    });
    const es = await mem(source(statusJson([engram(), gentle()]), nullMemory));
    expect(es.lines).toContain("Proceso de memoria · NO GUARDA");
    const body = text(es).replace(/\s+/g, " ");
    expect(body).toContain("Engram está listo: reinicia el runtime para que lo use");
    expect(body).toContain("memory.provider = engram");
    expect(body).toContain("«Comprobar e instalar Engram» lo añade si falta");
    expect(body).not.toContain("Para activar Engram");
    expectRowsToFit(es);
    const en = await mem(source(statusJson([engram(), gentle()]), nullMemory, { locale: "en" }));
    expect(text(en).replace(/\s+/g, " ")).toContain("Engram is ready: restart the runtime");
    expect(text(en).replace(/\s+/g, " ")).toContain(
      '"Check and install Engram" adds it when missing',
    );
    expectRowsToFit(en);
  });

  it("keeps the install advice while the tools could not be read", async () => {
    const details = await mem({
      tools: failure("boom"),
      memory: answer(memoryJson({ provider: "null", persistent: false })),
    });
    expect(text(details)).toContain("Para activar Engram:");
  });

  it("shows a stopped runtime, an unchecked health, a degraded provider and the queue", async () => {
    const details = await mem(
      source(
        statusJson([engram(), gentle()]),
        memoryJson({
          runtime: "not_running",
          health: "not_checked",
          degraded: true,
          lastError: { code: "engram_unreachable", at: 1 },
          outbox: { pending: 2, sending: 1, needsReview: 0, dead: 0, delivered: 0, depth: 3 },
        }),
      ),
    );
    expect(details.lines).toContain("  Runtime: parado");
    expect(details.lines).toContain("  Salud: sin comprobar");
    // The row wraps inside its card: it is the same words, in two rows.
    expect(text(details).replace(/\s+/g, " ")).toContain("Degradada: sí (engram_unreachable)");
    expect(details.lines).toContain("  Cola: 3 por entregar");
    expectRowsToFit(details);
  });

  it("says when the store was never initialized", async () => {
    const details = await mem(
      source(
        statusJson([engram(), gentle()]),
        memoryJson({ initialized: false, provider: "null", persistent: false }),
      ),
    );
    expect(details.lines).toContain("  Almacén sin inicializar.");
  });
});

describe("a part that could not be loaded", () => {
  it("shows why the tools are not available and still shows the memory process", async () => {
    const details = await mem({
      tools: failure("haril: tools needs a subcommand"),
      memory: answer(memoryJson()),
    });
    expect(details.lines).toContain("Engram y gentle-ai · no disponible");
    expect(details.lines).toContain("  haril: tools needs a subcommand");
    expect(details.lines).toContain("  Proveedor: engram · persistente");
    expect(details.lines).not.toContain("Engram · ok");
    expect(details.actions).toBeDefined();
  });

  it("shows why the memory process is not available and still shows the tools", async () => {
    const details = await mem({
      tools: answer(statusJson([engram(), gentle()])),
      memory: failure("haril: store could not be read"),
    });
    expect(details.lines).toContain("Proceso de memoria · no disponible");
    expect(details.lines).toContain("  haril: store could not be read");
    expect(details.lines).toContain("Engram · ok");
    expect(details.actions).toHaveLength(4);
  });

  it("treats an answer that is not the expected JSON as not available", async () => {
    const details = await mem({
      tools: answer("not json at all"),
      memory: answer(JSON.stringify({ unrelated: true })),
    });
    expect(details.lines).toContain("Engram y gentle-ai · no disponible");
    expect(details.lines).toContain("Proceso de memoria · no disponible");
    expect(text(details)).toContain("Respuesta no válida de haril.");
  });

  it("treats a seam that throws like a failed part", async () => {
    const details = await mem({
      tools: async () => {
        throw new Error("spawn exploded");
      },
      memory: answer(memoryJson()),
    });
    expect(details.lines).toContain("  spawn exploded");
    expect(details.lines).toContain("  Proveedor: engram · persistente");
  });

  it("offers no action when this Pi was not opened by haril", async () => {
    const details = await mem({ tools: failure(NOT_LAUNCHED), memory: failure(NOT_LAUNCHED) });
    expect(details.actions).toBeUndefined();
    expect(text(details)).not.toContain("▸");
    expect(text(details)).toContain("this Pi was not opened by haril");
    expectRowsToFit(details);
  });

  it("loads both commands in parallel: a slow one does not wait for the other to start", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const slow = (name: string, stdout: string) => () =>
      new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
        started.push(name);
        release.push(() => resolve({ ok: true, stdout, stderr: "" }));
      });
    const pending = mem({
      tools: slow("tools", statusJson([engram(), gentle()])),
      memory: slow("memory", memoryJson()),
    });
    await Promise.resolve();
    expect(started.sort()).toEqual(["memory", "tools"]);
    for (const resolve of release) resolve();
    expect((await pending).lines).toContain("Engram · ok");
  });
});

describe("the TOOLS view while something runs", () => {
  const ready = (extra: DockSource = {}) =>
    source(statusJson([engram(), gentle()]), memoryJson(), extra);

  it.each([
    ["check", "… Comprobando Engram y gentle-ai"],
    ["ensure", "… Comprobando e instalando Engram"],
    ["force", "… Reinstalando Engram"],
    ["refresh", "… Consultando las últimas versiones"],
    ["plan", "… Preparando la actualización"],
    ["update", "… Compilando gentle-ai con Go"],
  ] as const)("shows %s as a busy row instead of the actions", async (busy, row) => {
    const details = await mem(ready({ busy }));
    // A busy row wider than the card goes on in a second row: it reads the same once the rows are joined.
    expect(text(details).replace(/\s+/g, " ")).toContain(row);
    expect(details.lines.some((line) => line.trim().startsWith("… "))).toBe(true);
    expect(details.actions).toBeUndefined();
    expect(text(details)).not.toContain("▸");
    expect(details.lines).toContain("Engram · ok");
    expectRowsToFit(details);
  });

  it("wraps a busy row that is wider than the panel", async () => {
    const details = await mem(ready({ busy: "update", locale: "en" }));
    expectRowsToFit(details);
    expect(text(details).replace(/\s+/g, " ")).toContain("… Building gentle-ai with Go");
  });

  it("says the check at start-up failed, in the tab", async () => {
    const details = await mem(ready({ checkError: "timed out" }));
    expect(details.lines).toContain("Comprobación al arrancar");
    expect(text(details)).toContain("falló: timed out");
    expect(details.actions).toHaveLength(4);
  });
});

describe("the densest state fits the panel, in both languages and whatever is running", () => {
  // Everything at once: a missing Engram with five other copies and a long failure, an outdated gentle-ai with its own
  // copies and a long note, a null provider that is degraded, and a check at start-up that failed.
  const others = [1, 2, 3, 4, 5].map((n) =>
    install(`C:\\otra-carpeta-larga-${n}\\bin\\engram.exe`, `3.${n}.0`, ["go-bin", "path"], false),
  );
  const oldGentle = install(GO_GENTLE, "4.0.0", ["go-bin"]);
  const dense = statusJson(
    [
      engram({
        state: "missing",
        active: null,
        installs: others,
        newerUpstream: true,
        latest: "3.9.0",
      }),
      gentle({
        state: "outdated",
        active: oldGentle,
        installs: [oldGentle, ...others],
        latest: "4.3.1",
        notes: [`could not check the latest version: ${"x".repeat(120)}`],
      }),
    ],
    {
      engramInstallFailure: {
        failedAt: "2026-10-30T09:00:00.000Z",
        message: "y".repeat(300),
        retryAt: "2026-10-30T15:00:00.000Z",
      },
    },
  );
  const worst = memoryJson({
    provider: "null",
    persistent: false,
    degraded: true,
    lastError: { code: "e".repeat(60), at: 1 },
    outbox: { depth: 123_456 },
  });

  it.each(["es", "en"] as const)("%s", async (locale) => {
    for (const busy of [
      undefined,
      "check",
      "ensure",
      "force",
      "refresh",
      "plan",
      "update",
    ] as const) {
      const details = await mem(
        source(dense, worst, { locale, busy, checkError: "z".repeat(200) }),
      );
      expectRowsToFit(details);
      expect(details.lines.length).toBeLessThanOrEqual(140);
    }
  });
});

describe("text that does not belong to HARIL", () => {
  it("never lets an escape sequence or a control character reach the panel", async () => {
    const hostile = install("D:\\\u001b[31mx\u0007\\engram.exe", "3.6.0", ["haril"]);
    const details = await mem(
      source(
        statusJson([engram({ active: hostile, installs: [hostile] }), gentle()], {
          engramInstallFailure: {
            failedAt: "2026-10-30T09:00:00.000Z",
            message: "bad \u001b]0;title\u0007 news",
            retryAt: null,
          },
        }),
        memoryJson({ provider: "evil\u001b[2J" }),
      ),
    );
    // The only control character left in the view is the line break between its lines.
    const controls = [...text(details)].filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return (code < 0x20 && char !== "\n") || (code >= 0x7f && code <= 0x9f);
    });
    expect(controls).toEqual([]);
    expectRowsToFit(details);
  });

  it("falls back to unknown for a state it does not know", async () => {
    const details = await mem(
      source(statusJson([engram({ state: "exploded" }), gentle()]), memoryJson()),
    );
    expect(details.lines).toContain("Engram · desconocido");
  });
});

// `haril memory status` tells what the runtime recorded, and the runtime records a provider only once it has run: before
// that it says null whatever haril.json sets. The tool report carries what haril.json sets (memoryConfig), and the card
// shows both, so a configured Engram is not called «NO GUARDA».
describe("the configured provider in the memory process card", () => {
  const stale = memoryJson({
    provider: "null",
    persistent: false,
    health: "not_checked",
    runtime: "not_running",
  });
  const withConfig = (memoryConfig: Record<string, unknown>) =>
    statusJson([engram(), gentle()], { memoryConfig });

  it("does not call a configured Engram «NO GUARDA» before the runtime has run", async () => {
    const details = await mem(source(withConfig({ provider: "engram" }), stale));
    const title = details.lines.indexOf("Proceso de memoria · parado");
    expect(title).toBeGreaterThanOrEqual(0);
    // The configured provider is the card's first row, and the runtime's last state replaces «Proveedor: null».
    expect(details.lines.slice(title + 1, title + 3)).toEqual([
      "  Configurado: engram",
      "  Último estado del runtime: null",
    ]);
    const body = text(details).replace(/\s+/g, " ");
    expect(body).not.toContain("NO GUARDA");
    expect(body).not.toContain("no guarda nada");
    expect(body).not.toContain("Para activar Engram");
    expect(body).not.toContain("memory.provider = engram");
    expect(body).toContain("Engram arranca con el runtime.");
    // Every other line of the card stays.
    expect(details.lines).toContain("  Runtime: parado");
    expect(details.lines).toContain("  Salud: sin comprobar");
    expect(details.lines).toContain("  Degradada: no");
    expect(details.lines).toContain("  Cola: 0 por entregar");
    expectRowsToFit(details);
  });

  it("says the same in English", async () => {
    const details = await mem(source(withConfig({ provider: "engram" }), stale, { locale: "en" }));
    const title = details.lines.indexOf("Memory process · stopped");
    expect(title).toBeGreaterThanOrEqual(0);
    expect(details.lines.slice(title + 1, title + 3)).toEqual([
      "  Configured: engram",
      "  Last runtime state: null",
    ]);
    const body = text(details).replace(/\s+/g, " ");
    expect(body).not.toContain("NOT SAVING");
    expect(body).toContain("Engram starts with the runtime.");
    expectRowsToFit(details);
  });

  it("asks for a restart, with a plain title, when the runtime is running and still recorded null", async () => {
    const running = memoryJson({ provider: "null", persistent: false, runtime: "running" });
    const details = await mem(source(withConfig({ provider: "engram" }), running));
    expect(details.lines).toContain("Proceso de memoria");
    expect(details.lines).not.toContain("Proceso de memoria · parado");
    expect(details.lines).toContain("  Configurado: engram");
    expect(details.lines).toContain("  Último estado del runtime: null");
    expect(text(details).replace(/\s+/g, " ")).toContain(
      "Reinicia el runtime para que use Engram.",
    );
    expect(text(details)).not.toContain("NO GUARDA");
    expectRowsToFit(details);
  });

  it.each([
    ["null", "  Configurado: null"],
    [null, "  Configurado: sin sección"],
  ])(
    "keeps «NO GUARDA» and the advice when the file sets %j, and says what it sets",
    async (provider, row) => {
      const details = await mem(source(withConfig({ provider }), stale));
      const title = details.lines.indexOf("Proceso de memoria · NO GUARDA");
      expect(title).toBeGreaterThanOrEqual(0);
      expect(details.lines[title + 1]).toBe(row);
      expect(details.lines).toContain("  Proveedor: null (no guarda nada)");
      expect(text(details).replace(/\s+/g, " ")).toContain(
        "Engram está listo: reinicia el runtime",
      );
      expect(text(details)).not.toContain("Último estado del runtime");
      expectRowsToFit(details);
    },
  );

  it("says what the file sets in English too", async () => {
    const none = await mem(source(withConfig({ provider: null }), stale, { locale: "en" }));
    expect(none.lines).toContain("  Configured: no section");
    expect(none.lines).toContain("Memory process · NOT SAVING");
    const off = await mem(source(withConfig({ provider: "null" }), stale, { locale: "en" }));
    expect(off.lines).toContain("  Configured: null");
  });

  it("shows the configured provider above the runtime's own when both are Engram", async () => {
    const details = await mem(source(withConfig({ provider: "engram" }), memoryJson()));
    const title = details.lines.indexOf("Proceso de memoria");
    expect(title).toBeGreaterThanOrEqual(0);
    expect(details.lines.slice(title + 1, title + 3)).toEqual([
      "  Configurado: engram",
      "  Proveedor: engram · persistente",
    ]);
    expect(text(details)).not.toContain("Último estado del runtime");
  });

  it("changes nothing when the report does not say (an older haril, or the tools could not be read)", async () => {
    const older = await mem(source(statusJson([engram(), gentle()]), stale));
    expect(older.lines).toContain("Proceso de memoria · NO GUARDA");
    expect(text(older)).not.toContain("Configurado");
    const failed = await mem({ tools: failure("boom"), memory: answer(stale) });
    expect(failed.lines).toContain("Proceso de memoria · NO GUARDA");
    expect(text(failed)).not.toContain("Configurado");
  });

  it("ignores a memoryConfig that is not one", async () => {
    for (const memoryConfig of [{ provider: "chroma" }, { provider: 7 }, "engram", [], null, {}]) {
      const details = await mem(source(statusJson([engram(), gentle()], { memoryConfig }), stale));
      expect(text(details), JSON.stringify(memoryConfig)).not.toContain("Configurado");
      expect(details.lines).toContain("Proceso de memoria · NO GUARDA");
    }
  });
});
