import { describe, expect, it, vi } from "vitest";
import type { UiLocale } from "../src/locale.js";
import { parseEnsure } from "../src/tools-model.js";
import {
  createToolsPanel,
  startupNotices,
  type ToolsHost,
  toolsCheckEnabled,
} from "../src/tools-panel.js";
import type { BusyKind } from "../src/tools-view.js";
import {
  engram,
  ensureJson,
  GO_GENTLE,
  gentle,
  install,
  memoryJson,
  PLAN_STDERR,
  statusJson,
  updateJson,
} from "./tools-fixtures.js";

// The TOOLS tab's controller: the check at start-up, the four actions and the notices they leave. Every command goes
// through a fake `run`, so no CLI runs; the console-level behaviour (clicks, the Alt+K menu, the real CLI pipe) is in
// tools-mem-console.test.ts.

// Waits for the assertion; the check starts on a timer and runs through promises, so a loaded run needs a ceiling.
const waitFor = <T>(assertion: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(assertion, { timeout: 15_000, interval: 10 });
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Answer {
  readonly ok?: boolean;
  readonly code?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}
type Responder = Answer | (() => Promise<Answer> | Answer);

interface Rig {
  readonly panel: ReturnType<typeof createToolsPanel>;
  readonly runs: { args: string[]; timeoutMs: number }[];
  readonly notes: [string, string | undefined][];
  readonly confirms: { title: string; message: string }[];
  // What the panel said it was doing each time it asked to be drawn again.
  readonly drawn: (BusyKind | undefined)[];
  readonly state: {
    memoryOpen: boolean;
    reloads: number;
    ui: boolean;
    confirm: boolean;
    locale: UiLocale;
    env: Record<string, string | undefined>;
  };
  answer(command: string, responder: Responder): void;
}

function rig(options: { delayMs?: number } = {}): Rig {
  const runs: Rig["runs"] = [];
  const notes: Rig["notes"] = [];
  const confirms: Rig["confirms"] = [];
  const drawn: Rig["drawn"] = [];
  const state: Rig["state"] = {
    memoryOpen: false,
    reloads: 0,
    ui: true,
    confirm: true,
    locale: "es",
    env: {},
  };
  const answers = new Map<string, Responder>();
  const holder: { panel?: ReturnType<typeof createToolsPanel> } = {};
  const host: ToolsHost = {
    async run(args, { timeoutMs }) {
      runs.push({ args: [...args], timeoutMs });
      const responder = answers.get(args.join(" "));
      const answer = typeof responder === "function" ? await responder() : responder;
      const code = answer?.code ?? 0;
      return {
        ok: answer?.ok ?? code === 0,
        code,
        stdout: answer?.stdout ?? "",
        stderr: answer?.stderr ?? "",
      };
    },
    env: () => state.env,
    locale: () => state.locale,
    ui: () =>
      state.ui
        ? {
            notify: (message, level) => {
              notes.push([message, level]);
            },
            confirm: async (title, message) => {
              confirms.push({ title, message });
              return state.confirm;
            },
          }
        : undefined,
    memoryOpen: () => state.memoryOpen,
    repaint: () => {
      drawn.push(holder.panel?.busy());
    },
    reload: () => {
      state.reloads++;
    },
  };
  const panel = createToolsPanel(host, { checkDelayMs: options.delayMs ?? 0 });
  holder.panel = panel;
  return {
    panel,
    runs,
    notes,
    confirms,
    drawn,
    state,
    answer: (command, responder) => {
      answers.set(command, responder);
    },
  };
}

const ENSURE = "tools ensure --json";

describe("HARIL_TOOLS_CHECK", () => {
  it.each([
    ["off", false],
    ["OFF", false],
    [" off ", false],
    ["0", false],
    ["false", false],
    ["False", false],
    ["on", true],
    ["1", true],
    ["yes", true],
    ["", true],
    [undefined, true],
  ] as const)("%j runs the check: %s", (value, runs) => {
    expect(toolsCheckEnabled({ HARIL_TOOLS_CHECK: value })).toBe(runs);
  });
});

describe("the check at start-up", () => {
  it("runs `haril tools ensure --json` in the background, after scheduling returns", async () => {
    const r = rig();
    r.answer(ENSURE, { stdout: ensureJson({ action: "none" }) });
    r.panel.scheduleCheck();
    // Nothing has run yet: the call only scheduled it, so the first frame and every shortcut are not held up.
    expect(r.runs).toEqual([]);
    await waitFor(() => expect(r.runs).toHaveLength(1));
    expect(r.runs[0]).toEqual({ args: ["tools", "ensure", "--json"], timeoutMs: 300_000 });
  });

  it("does not wait for a check that never ends", () => {
    const r = rig();
    r.answer(ENSURE, () => new Promise<Answer>(() => undefined));
    const before = Date.now();
    r.panel.scheduleCheck();
    expect(Date.now() - before).toBeLessThan(200);
    expect(r.panel.busy()).toBeUndefined();
  });

  it("runs once per process, however many sessions ask", async () => {
    const r = rig();
    r.answer(ENSURE, { stdout: ensureJson({ action: "none" }) });
    r.panel.scheduleCheck();
    r.panel.scheduleCheck();
    await waitFor(() => expect(r.runs).toHaveLength(1));
    await waitFor(() => expect(r.panel.busy()).toBeUndefined());
    r.panel.scheduleCheck();
    await pause(60);
    expect(r.runs).toHaveLength(1);
  });

  it("starts again for a later session when the first one closed before the check began", async () => {
    const r = rig({ delayMs: 40 });
    r.answer(ENSURE, { stdout: ensureJson({ action: "none" }) });
    r.panel.scheduleCheck();
    r.panel.cancelCheck();
    await pause(120);
    expect(r.runs).toEqual([]);
    r.panel.scheduleCheck();
    await waitFor(() => expect(r.runs).toHaveLength(1));
  });

  it.each(["off", "0", "false"])("is skipped entirely with HARIL_TOOLS_CHECK=%s", async (value) => {
    const r = rig();
    r.state.env = { HARIL_TOOLS_CHECK: value };
    r.panel.scheduleCheck();
    await pause(60);
    expect(r.runs).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.panel.busy()).toBeUndefined();
  });

  it("shows itself as the tab's busy state while it runs, then stops", async () => {
    const r = rig();
    let release: (() => void) | undefined;
    r.answer(
      ENSURE,
      () =>
        new Promise<Answer>((resolve) => {
          release = () => resolve({ stdout: ensureJson({ action: "none" }) });
        }),
    );
    r.panel.scheduleCheck();
    await waitFor(() => expect(r.panel.busy()).toBe("check"));
    expect(r.panel.source().busy).toBe("check");
    expect(r.drawn.at(-1)).toBe("check");
    release?.();
    await waitFor(() => expect(r.panel.busy()).toBeUndefined());
    expect(r.panel.source().busy).toBeUndefined();
  });

  it("says nothing when everything is current", async () => {
    const r = rig();
    r.answer(ENSURE, {
      stdout: ensureJson({ action: "none", message: "Engram 3.6.0 is installed and current" }),
    });
    r.panel.scheduleCheck();
    await waitFor(() => expect(r.runs).toHaveLength(1));
    await waitFor(() => expect(r.panel.busy()).toBeUndefined());
    await pause(30);
    expect(r.notes).toEqual([]);
  });

  describe("the one notice when something happened or needs attention", () => {
    const noticeFor = async (stdout: string, locale: UiLocale = "es") => {
      const r = rig();
      r.state.locale = locale;
      r.answer(ENSURE, { stdout });
      r.panel.scheduleCheck();
      await waitFor(() => expect(r.notes.length).toBeGreaterThan(0));
      await pause(30);
      return r.notes;
    };

    it("tells a fresh install and to restart the runtime", async () => {
      expect(await noticeFor(ensureJson({ action: "installed", to: "3.6.0" }))).toEqual([
        ["Engram 3.6.0 instalado. Reinicia el runtime para que lo use.", "info"],
      ]);
    });

    it("tells an update, with both versions", async () => {
      expect(
        await noticeFor(ensureJson({ action: "updated", from: "3.3.2", to: "3.6.0" })),
      ).toEqual([
        ["Engram 3.3.2 → 3.6.0 actualizado. Reinicia el runtime para que lo use.", "info"],
      ]);
    });

    it("warns that the install failed, with the reason", async () => {
      expect(
        await noticeFor(
          ensureJson(
            { action: "failed", message: "could not download checksums.txt: network error" },
            [engram({ state: "missing", active: null, installs: [] }), gentle()],
          ),
        ),
      ).toEqual([
        ["No se pudo instalar Engram: could not download checksums.txt: network error", "warning"],
      ]);
    });

    it("offers gentle-ai when it is outdated, with both versions and where to update it", async () => {
      const old = install(GO_GENTLE, "4.0.0", ["go-bin"]);
      expect(
        await noticeFor(
          ensureJson({ action: "none" }, [
            engram(),
            gentle({ state: "outdated", active: old, installs: [old], latest: "4.3.1" }),
          ]),
        ),
      ).toEqual([["gentle-ai 4.0.0 → 4.3.1 disponible: Alt+L → TOOLS → Actualizar.", "info"]]);
    });

    it("says gentle-ai is missing, and where to install it", async () => {
      expect(
        await noticeFor(
          ensureJson({ action: "none" }, [
            engram(),
            gentle({ state: "missing", active: null, installs: [] }),
          ]),
        ),
      ).toEqual([["gentle-ai no está instalado: Alt+L → TOOLS → Instalar gentle-ai.", "info"]]);
    });

    it("notices a newer upstream Engram that HARIL does not use yet", async () => {
      expect(
        await noticeFor(
          ensureJson({ action: "none" }, [
            engram({ newerUpstream: true, latest: "3.9.0" }),
            gentle(),
          ]),
        ),
      ).toEqual([["Engram 3.9.0 publicado; HARIL usa la 3.6.0 hasta calificarla.", "info"]]);
    });

    it("joins everything that applies into one notice, a warning when any part is one", async () => {
      const old = install(GO_GENTLE, "4.0.0", ["go-bin"]);
      const notes = await noticeFor(
        ensureJson({ action: "installed", to: "3.6.0" }, [
          engram(),
          gentle({ state: "outdated", active: old, installs: [old], latest: "4.3.1" }),
        ]),
      );
      expect(notes).toEqual([
        [
          "Engram 3.6.0 instalado. Reinicia el runtime para que lo use.\ngentle-ai 4.0.0 → 4.3.1 disponible: Alt+L → TOOLS → Actualizar.",
          "info",
        ],
      ]);
      const failed = await noticeFor(
        ensureJson({ action: "failed", message: "boom" }, [
          engram({ state: "missing", active: null, installs: [] }),
          gentle({ state: "missing", active: null, installs: [] }),
        ]),
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.[1]).toBe("warning");
      expect(failed[0]?.[0]).toContain("No se pudo instalar Engram: boom\n");
    });

    it.each(["busy", "skipped"] as const)(
      "says nothing for an Engram that is %s",
      async (action) => {
        const r = rig();
        r.answer(ENSURE, { stdout: ensureJson({ action, message: "nothing to say" }) });
        r.panel.scheduleCheck();
        await waitFor(() => expect(r.runs).toHaveLength(1));
        await waitFor(() => expect(r.panel.busy()).toBeUndefined());
        await pause(30);
        expect(r.notes).toEqual([]);
      },
    );

    it("speaks English when the console does", async () => {
      const old = install(GO_GENTLE, "4.0.0", ["go-bin"]);
      expect(
        await noticeFor(
          ensureJson({ action: "installed", to: "3.6.0" }, [
            engram(),
            gentle({ state: "outdated", active: old, installs: [old], latest: "4.3.1" }),
          ]),
          "en",
        ),
      ).toEqual([
        [
          "Engram 3.6.0 installed. Restart the runtime so it uses it.\ngentle-ai 4.0.0 → 4.3.1 available: Alt+L → TOOLS → Update.",
          "info",
        ],
      ]);
    });
  });

  describe("never notifying twice for the same state", () => {
    const view = (text: string) => {
      const parsed = parseEnsure(text);
      if (parsed === undefined) throw new Error("fixture is not an ensure document");
      return parsed;
    };

    it("drops what was already said, and says nothing when nothing is new", () => {
      const seen = new Set<string>();
      const old = install(GO_GENTLE, "4.0.0", ["go-bin"]);
      const document = view(
        ensureJson({ action: "installed", to: "3.6.0" }, [
          engram(),
          gentle({ state: "outdated", active: old, installs: [old], latest: "4.3.1" }),
        ]),
      );
      expect(startupNotices(document, "es", seen)).toHaveLength(2);
      expect(startupNotices(document, "es", seen)).toEqual([]);
    });

    it("says it again when the state is a different one", () => {
      const seen = new Set<string>();
      const first = view(
        ensureJson({ action: "none" }, [
          engram(),
          gentle({
            state: "outdated",
            active: install(GO_GENTLE, "4.0.0", ["go-bin"]),
            latest: "4.2.0",
          }),
        ]),
      );
      const second = view(
        ensureJson({ action: "none" }, [
          engram(),
          gentle({
            state: "outdated",
            active: install(GO_GENTLE, "4.0.0", ["go-bin"]),
            latest: "4.3.1",
          }),
        ]),
      );
      expect(startupNotices(first, "es", seen)).toHaveLength(1);
      expect(startupNotices(second, "es", seen)).toHaveLength(1);
    });
  });

  describe("when the check gives no answer", () => {
    it.each([
      [
        "a CLI that cannot run",
        { ok: false, code: null, stdout: "", stderr: "spawn failed" },
        "spawn failed",
      ],
      [
        "a timeout",
        { ok: false, code: null, stdout: "", stderr: "Command timed out" },
        "Command timed out",
      ],
      ["output that is not JSON", { stdout: "not json" }, "respuesta no válida"],
      [
        "output that is another document",
        { stdout: JSON.stringify({ hello: 1 }) },
        "respuesta no válida",
      ],
      ["nothing at all", {}, "respuesta no válida"],
    ] as const)("swallows %s into the tab, with no notice", async (_name, answer, reason) => {
      const r = rig();
      r.state.memoryOpen = true;
      r.answer(ENSURE, answer);
      r.panel.scheduleCheck();
      await waitFor(() => expect(r.state.reloads).toBe(1));
      expect(r.notes).toEqual([]);
      expect(r.panel.source().checkError).toBe(reason);
      expect(r.panel.busy()).toBeUndefined();
    });

    it("swallows a run that throws", async () => {
      const r = rig();
      r.answer(ENSURE, () => {
        throw new Error("exploded");
      });
      r.panel.scheduleCheck();
      await waitFor(() => expect(r.panel.source().checkError).toBe("exploded"));
      expect(r.notes).toEqual([]);
    });

    it("forgets the error once a later check or action answers", async () => {
      const r = rig();
      r.answer(ENSURE, { stdout: "not json" });
      r.panel.scheduleCheck();
      await waitFor(() => expect(r.panel.source().checkError).toBeDefined());
      r.answer(ENSURE, { stdout: ensureJson({ action: "none" }) });
      await r.panel.act("tools:ensure");
      expect(r.panel.source().checkError).toBeUndefined();
    });
  });

  describe("refreshing the tab when it ends", () => {
    it("loads the tab again when TOOLS is the one on screen", async () => {
      const r = rig();
      r.state.memoryOpen = true;
      r.answer(ENSURE, { stdout: ensureJson({ action: "installed", to: "3.6.0" }) });
      r.panel.scheduleCheck();
      await waitFor(() => expect(r.state.reloads).toBe(1));
    });

    it("leaves another tab alone", async () => {
      const r = rig();
      r.state.memoryOpen = false;
      r.answer(ENSURE, { stdout: ensureJson({ action: "installed", to: "3.6.0" }) });
      r.panel.scheduleCheck();
      await waitFor(() => expect(r.notes).toHaveLength(1));
      await pause(30);
      expect(r.state.reloads).toBe(0);
    });

    it("does not fail when the session closed in the meantime", async () => {
      const r = rig();
      r.state.ui = false;
      r.answer(ENSURE, { stdout: ensureJson({ action: "installed", to: "3.6.0" }) });
      r.panel.scheduleCheck();
      await waitFor(() => expect(r.runs).toHaveLength(1));
      await waitFor(() => expect(r.panel.busy()).toBeUndefined());
      expect(r.notes).toEqual([]);
    });
  });
});

describe("the actions of the TOOLS tab", () => {
  it("checks and installs Engram, shows it is busy, says the outcome and loads the tab again", async () => {
    const r = rig();
    r.state.memoryOpen = true;
    let busyDuring: BusyKind | undefined;
    r.answer(ENSURE, () => {
      busyDuring = r.panel.busy();
      return { stdout: ensureJson({ action: "installed", to: "3.6.0" }) };
    });
    await r.panel.act("tools:ensure");
    expect(r.runs).toEqual([{ args: ["tools", "ensure", "--json"], timeoutMs: 300_000 }]);
    expect(busyDuring).toBe("ensure");
    expect(r.drawn[0]).toBe("ensure");
    expect(r.panel.busy()).toBeUndefined();
    expect(r.notes).toEqual([
      ["Engram 3.6.0 instalado. Reinicia el runtime para que lo use.", "info"],
    ]);
    expect(r.state.reloads).toBe(1);
  });

  it("says Engram is current when there was nothing to do", async () => {
    const r = rig();
    r.answer(ENSURE, { stdout: ensureJson({ action: "none" }) });
    await r.panel.act("tools:ensure");
    expect(r.notes).toEqual([["Engram al día (3.6.0).", "info"]]);
  });

  it("forces a reinstall with --force", async () => {
    const r = rig();
    let busyDuring: BusyKind | undefined;
    r.answer("tools ensure --force --json", () => {
      busyDuring = r.panel.busy();
      return { stdout: ensureJson({ action: "updated", to: "3.6.0" }) };
    });
    await r.panel.act("tools:force");
    expect(r.runs[0]?.args).toEqual(["tools", "ensure", "--force", "--json"]);
    expect(busyDuring).toBe("force");
    expect(r.notes).toEqual([
      ["Engram 3.6.0 configurado. Reinicia el runtime para que lo use.", "info"],
    ]);
  });

  it("reports a failed install as an error, reading the JSON of a command that exited with 1", async () => {
    const r = rig();
    r.answer(ENSURE, {
      code: 1,
      stdout: ensureJson({ action: "failed", message: "checksum mismatch" }),
    });
    await r.panel.act("tools:ensure");
    expect(r.notes).toEqual([["No se pudo instalar Engram: checksum mismatch", "error"]]);
  });

  it("reports an ensure that is already running elsewhere, and one it does not manage", async () => {
    const r = rig();
    r.answer(ENSURE, {
      stdout: ensureJson({ action: "busy", message: "another haril tools ensure is running" }),
    });
    await r.panel.act("tools:ensure");
    r.answer(ENSURE, {
      stdout: ensureJson({ action: "skipped", message: "memory.binary points elsewhere" }),
    });
    await r.panel.act("tools:ensure");
    expect(r.notes).toEqual([
      ["Otro «haril tools ensure» está en marcha; no se cambió nada.", "warning"],
      ["Engram no se gestiona aquí: memory.binary apunta fuera de la copia de HARIL.", "info"],
    ]);
  });

  it("says why when the command gave no document", async () => {
    const r = rig();
    r.answer(ENSURE, { ok: false, code: 2, stderr: "haril: unknown option\n" });
    await r.panel.act("tools:ensure");
    r.answer(ENSURE, { stdout: "nope" });
    await r.panel.act("tools:ensure");
    expect(r.notes).toEqual([
      ["No se pudo comprobar Engram: haril: unknown option", "error"],
      ["No se pudo comprobar Engram: respuesta no válida", "error"],
    ]);
    expect(r.panel.busy()).toBeUndefined();
  });

  it("looks the latest versions up again and says what it found", async () => {
    const r = rig();
    r.state.memoryOpen = true;
    const old = install(GO_GENTLE, "4.0.0", ["go-bin"]);
    let busyDuring: BusyKind | undefined;
    r.answer("tools status --refresh --json", () => {
      busyDuring = r.panel.busy();
      return {
        stdout: statusJson([
          engram(),
          gentle({ state: "outdated", active: old, installs: [old], latest: "4.3.1" }),
        ]),
      };
    });
    await r.panel.act("tools:refresh");
    expect(r.runs).toEqual([
      { args: ["tools", "status", "--refresh", "--json"], timeoutMs: 60_000 },
    ]);
    expect(busyDuring).toBe("refresh");
    expect(r.notes).toEqual([
      [
        "Versiones consultadas: Engram 3.6.0, gentle-ai 4.3.1.\ngentle-ai 4.0.0 → 4.3.1 disponible: Alt+L → TOOLS → Actualizar.",
        "info",
      ],
    ]);
    expect(r.state.reloads).toBe(1);
  });

  it("says when the refresh could not reach the network", async () => {
    const r = rig();
    r.answer("tools status --refresh --json", {
      stdout: statusJson([
        engram({ latest: null, latestCheckedAt: null }),
        gentle({ latest: null, latestCheckedAt: null, state: "unknown" }),
      ]),
    });
    await r.panel.act("tools:refresh");
    expect(r.notes).toEqual([
      ["Versiones consultadas: Engram sin dato, gentle-ai sin dato.", "info"],
    ]);
  });

  it("ignores an action it does not know", async () => {
    const r = rig();
    await r.panel.act("tools:format-disk");
    await r.panel.act("");
    expect(r.runs).toEqual([]);
    expect(r.notes).toEqual([]);
  });

  it("does one thing at a time: a second action while one runs says so and runs nothing", async () => {
    const r = rig();
    let release: (() => void) | undefined;
    r.answer(
      ENSURE,
      () =>
        new Promise<Answer>((resolve) => {
          release = () => resolve({ stdout: ensureJson({ action: "none" }) });
        }),
    );
    const first = r.panel.act("tools:ensure");
    await waitFor(() => expect(release).toBeDefined());
    await r.panel.act("tools:refresh");
    expect(r.runs).toHaveLength(1);
    expect(r.notes).toEqual([
      ["Hay otra operación en curso: Comprobando e instalando Engram.", "warning"],
    ]);
    release?.();
    await first;
    expect(r.panel.busy()).toBeUndefined();
  });

  it("never throws when the command throws or the session is gone", async () => {
    const r = rig();
    r.answer(ENSURE, () => {
      throw new Error("exploded");
    });
    await expect(r.panel.act("tools:ensure")).resolves.toBeUndefined();
    expect(r.notes).toEqual([["No se pudo comprobar Engram: exploded", "error"]]);
    expect(r.panel.busy()).toBeUndefined();
    r.state.ui = false;
    await expect(r.panel.act("tools:ensure")).resolves.toBeUndefined();
  });

  it("speaks English when the console does", async () => {
    const r = rig();
    r.state.locale = "en";
    r.answer(ENSURE, { stdout: ensureJson({ action: "failed", message: "checksum mismatch" }) });
    await r.panel.act("tools:ensure");
    expect(r.notes).toEqual([["Could not install Engram: checksum mismatch", "error"]]);
  });
});

describe("updating gentle-ai", () => {
  const PLAN = "tools update gentle-ai --json";
  const YES = "tools update gentle-ai --yes --json";

  it("shows the exact plan, asks, and only on yes runs the update with --yes", async () => {
    const r = rig();
    r.state.memoryOpen = true;
    const busy: (BusyKind | undefined)[] = [];
    r.answer(PLAN, () => {
      busy.push(r.panel.busy());
      return { ok: false, code: 2, stderr: PLAN_STDERR };
    });
    r.answer(YES, () => {
      busy.push(r.panel.busy());
      return {
        stdout: updateJson({ action: "updated", from: "4.0.0", to: "4.3.1", path: GO_GENTLE }),
      };
    });
    await r.panel.act("tools:update");
    expect(r.runs).toEqual([
      { args: ["tools", "update", "gentle-ai", "--json"], timeoutMs: 60_000 },
      { args: ["tools", "update", "gentle-ai", "--yes", "--json"], timeoutMs: 720_000 },
    ]);
    expect(busy).toEqual(["plan", "update"]);
    expect(r.confirms).toHaveLength(1);
    expect(r.confirms[0]?.title).toBe("Actualizar gentle-ai");
    const message = r.confirms[0]?.message ?? "";
    expect(message).toContain("gentle-ai: 4.0.0 -> 4.3.1");
    expect(message).toContain(
      "command     go install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@v4.3.1",
    );
    expect(message).toContain(`installs to ${GO_GENTLE}`);
    expect(message).not.toContain("confirmation required");
    expect(message.endsWith("¿Continuar?")).toBe(true);
    expect(r.notes).toEqual([["gentle-ai 4.0.0 → 4.3.1 actualizado.", "info"]]);
    expect(r.state.reloads).toBe(1);
    expect(r.panel.busy()).toBeUndefined();
  });

  it("does nothing when the confirmation is declined: no --yes run, no notice, no reload", async () => {
    const r = rig();
    r.state.memoryOpen = true;
    r.state.confirm = false;
    r.answer(PLAN, { ok: false, code: 2, stderr: PLAN_STDERR });
    await r.panel.act("tools:update");
    expect(r.runs.map((run) => run.args.join(" "))).toEqual([PLAN]);
    expect(r.confirms).toHaveLength(1);
    expect(r.notes).toEqual([]);
    expect(r.state.reloads).toBe(0);
    expect(r.panel.busy()).toBeUndefined();
  });

  it("passes the warnings of the update on, as a warning", async () => {
    const r = rig();
    r.answer(PLAN, { ok: false, code: 2, stderr: PLAN_STDERR });
    r.answer(YES, {
      stdout: updateJson({
        action: "installed",
        to: "4.3.1",
        path: GO_GENTLE,
        warnings: ["the active gentle-ai at C:\\old\\gentle-ai.exe (4.0.0) was not updated"],
      }),
    });
    await r.panel.act("tools:update");
    expect(r.notes).toEqual([
      [
        `gentle-ai 4.3.1 instalado en ${GO_GENTLE}.\nAviso: the active gentle-ai at C:\\old\\gentle-ai.exe (4.0.0) was not updated`,
        "warning",
      ],
    ]);
  });

  it("reports a failed update as an error, with what go said on one line", async () => {
    const r = rig();
    r.answer(PLAN, { ok: false, code: 2, stderr: PLAN_STDERR });
    r.answer(YES, {
      code: 1,
      stdout: updateJson({
        action: "failed",
        message: "go install failed (exit 1)\nmodule lookup failed\nunexpected EOF",
      }),
    });
    await r.panel.act("tools:update");
    expect(r.notes).toEqual([
      [
        "No se pudo actualizar gentle-ai: go install failed (exit 1) · module lookup failed · unexpected EOF",
        "error",
      ],
    ]);
  });

  it("says gentle-ai is current, without asking, when the plan finds nothing to do", async () => {
    const r = rig();
    r.answer(PLAN, { stdout: updateJson({ action: "none", to: "4.3.1" }) });
    await r.panel.act("tools:update");
    expect(r.confirms).toEqual([]);
    expect(r.runs).toHaveLength(1);
    expect(r.notes).toEqual([["gentle-ai ya está al día (4.3.1).", "info"]]);
  });

  it("reports why the plan could not be made (no Go, the latest version unknown) without asking", async () => {
    const r = rig();
    r.answer(PLAN, {
      code: 1,
      stdout: updateJson({
        action: "failed",
        message: "Go was not found on PATH. gentle-ai is built from source with Go: install it",
      }),
    });
    await r.panel.act("tools:update");
    expect(r.confirms).toEqual([]);
    expect(r.runs).toHaveLength(1);
    expect(r.notes[0]?.[1]).toBe("error");
    expect(r.notes[0]?.[0]).toContain("No se pudo actualizar gentle-ai: Go was not found on PATH.");
  });

  it("never runs --yes when what the plan printed is not a plan", async () => {
    const r = rig();
    r.answer(PLAN, { ok: false, code: 2, stderr: "haril: unknown option --json\n" });
    await r.panel.act("tools:update");
    expect(r.confirms).toEqual([]);
    expect(r.runs).toHaveLength(1);
    expect(r.notes).toEqual([
      ["No se pudo preparar la actualización de gentle-ai: haril: unknown option --json", "error"],
    ]);
  });

  it("asks in English when the console is in English", async () => {
    const r = rig();
    r.state.locale = "en";
    r.state.confirm = false;
    r.answer(PLAN, { ok: false, code: 2, stderr: PLAN_STDERR });
    await r.panel.act("tools:update");
    expect(r.confirms[0]?.title).toBe("Update gentle-ai");
    expect(r.confirms[0]?.message.endsWith("Proceed?")).toBe(true);
  });
});

describe("the data the tab is drawn from", () => {
  it("loads both commands, keeps them, and draws the same data again with the busy state", async () => {
    const r = rig();
    r.answer("tools status --json", { stdout: statusJson([engram(), gentle()]) });
    r.answer("memory status --json", { stdout: memoryJson() });
    expect(r.panel.view()).toBeUndefined();
    const loaded = await r.panel.load();
    expect(loaded.lines).toContain("Engram · ok");
    expect(loaded.actions).toHaveLength(4);
    expect(r.runs.map((run) => [run.args.join(" "), run.timeoutMs])).toEqual([
      ["tools status --json", 8_000],
      ["memory status --json", 8_000],
    ]);
    // Drawn again with no new command, the way the console does when only the busy state changes.
    let release: (() => void) | undefined;
    r.answer(
      ENSURE,
      () =>
        new Promise<Answer>((resolve) => {
          release = () => resolve({ stdout: ensureJson({ action: "none" }) });
        }),
    );
    const pending = r.panel.act("tools:ensure");
    await waitFor(() => expect(release).toBeDefined());
    const busy = r.panel.view();
    expect(busy?.actions).toBeUndefined();
    expect(
      busy?.lines.some((line) => line.trim().startsWith("… Comprobando e instalando Engram")),
    ).toBe(true);
    expect(
      r.runs.filter((run) => run.args[0] === "tools" && run.args[1] === "status"),
    ).toHaveLength(1);
    release?.();
    await pending;
  });

  it("builds the tab with the busy state it has when the data arrives, not when it was asked for", async () => {
    const r = rig();
    let arrive: (() => void) | undefined;
    r.answer(
      "tools status --json",
      () =>
        new Promise<Answer>((resolve) => {
          arrive = () => resolve({ stdout: statusJson([engram(), gentle()]) });
        }),
    );
    r.answer("memory status --json", { stdout: memoryJson() });
    r.answer(ENSURE, () => new Promise<Answer>(() => undefined));
    const loading = r.panel.load();
    void r.panel.act("tools:ensure");
    await waitFor(() => expect(arrive).toBeDefined());
    await waitFor(() => expect(r.panel.busy()).toBe("ensure"));
    arrive?.();
    expect((await loading).actions).toBeUndefined();
  });
});
