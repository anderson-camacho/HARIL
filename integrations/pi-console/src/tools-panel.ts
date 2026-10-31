import type { CliResult } from "./cli.js";
import {
  type DockDetails,
  type DockSource,
  loadMemData,
  memDetails,
  toolsCatalogDetails,
} from "./dock-details.js";
import { localized, type UiLocale } from "./locale.js";
import type { ExtensionEntry } from "./status-info.js";
import { plainText } from "./text.js";
import { type Catalog, setMcpEnabled } from "./tools-catalog.js";
import {
  CATALOG_ACTIONS,
  type CatalogRoute,
  canInsertName,
  catalogEntryCard,
  catalogView,
} from "./tools-catalog-view.js";
import {
  type EnsureView,
  parseEnsure,
  parseToolsStatus,
  parseUpdate,
  type ToolsStatusView,
  type UpdateView,
} from "./tools-model.js";
import { type BusyKind, busyLabel, type MemData, TOOLS_ACTIONS } from "./tools-view.js";

// What the console does for the TOOLS tab besides drawing it: the check that runs when it opens, the four actions the
// tab offers, and the one notice each of them leaves. Everything goes through the HARIL CLI (`host.run`), in the
// background: the console never waits for it, and no failure here reaches the user as anything but a line in the tab
// or a notice.

const CHECK_TIMEOUT_MS = 300_000;
const ENSURE_TIMEOUT_MS = 300_000;
const REFRESH_TIMEOUT_MS = 60_000;
const PLAN_TIMEOUT_MS = 60_000;
// go install builds from source; the CLI itself stops it after 10 minutes.
const UPDATE_TIMEOUT_MS = 720_000;
const LOAD_TIMEOUT_MS = 8_000;
// The check starts after the first frame has been drawn, not with it.
const DEFAULT_CHECK_DELAY_MS = 500;
const MAX_REASON = 200;
const MAX_MESSAGE = 300;

type Level = "info" | "warning" | "error";

export interface ToolsHost {
  // Runs `haril <args>`; never rejects in practice, and a rejection is treated as a failed command.
  run(args: readonly string[], options: { readonly timeoutMs: number }): Promise<CliResult>;
  env(): Readonly<Record<string, string | undefined>>;
  locale(): UiLocale;
  extensions?(): readonly ExtensionEntry[];
  // The skills and MCP servers as they are now; read again every time they are drawn.
  catalog?(): Catalog;
  // The session's notices and questions; undefined when there is no session to talk to.
  ui():
    | {
        notify(message: string, level?: Level): void;
        confirm(title: string, message: string): Promise<boolean>;
        setEditorText?(text: string): void;
        input?(title: string, placeholder?: string): Promise<string | undefined>;
      }
    | undefined;
  // The TOOLS tab is the one on screen.
  memoryOpen(): boolean;
  // Draws the tab again from the data it holds: only its busy state changed.
  repaint(): void;
  // Loads the tab again from the CLI.
  reload(): void;
}

export interface ToolsPanelOptions {
  readonly checkDelayMs?: number;
}

export interface ToolsPanel {
  // The tab, loaded from `haril tools status --json` and `haril memory status --json`.
  load(): Promise<DockDetails>;
  // The tab drawn again from what the last load found, with the current busy state; undefined before any load.
  view(): DockDetails | undefined;
  // Runs the action of a row of the tab.
  act(action: string): Promise<void>;
  // What the console is doing for the tab now.
  busy(): BusyKind | undefined;
  // The seams `loadDockDetails` reads, so the tab and the console agree on state.
  source(): DockSource;
  // Starts the check once per process, after a moment; does nothing when HARIL_TOOLS_CHECK turns it off.
  scheduleCheck(): void;
  // Stops a check that has not begun (the session closed before it did).
  cancelCheck(): void;
}

// HARIL_TOOLS_CHECK=off (or 0, or false) skips the check that runs when the console opens.
export function toolsCheckEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.HARIL_TOOLS_CHECK?.trim().toLowerCase();
  return !(value === "off" || value === "0" || value === "false");
}

interface Notice {
  readonly text: string;
  readonly level: Level;
}

interface Part extends Notice {
  // The state the part tells about: the same key is never told twice in a process.
  readonly key: string;
}

type Say = (english: string, spanish: string) => string;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// What Engram's ensure did, when it did something worth telling. `none`, `busy` and `skipped` are told only to a person
// who asked (manualOnly), never at start-up.
function engramPart(view: EnsureView, say: Say, level: Level, asked: boolean): Part | undefined {
  const restart = say("Restart the runtime so it uses it.", "Reinicia el runtime para que lo use.");
  const to = view.to ?? "";
  switch (view.action) {
    case "installed":
      return {
        key: `engram:installed:${to}`,
        text: say(`Engram ${to} installed. ${restart}`, `Engram ${to} instalado. ${restart}`),
        level: "info",
      };
    case "updated":
      return {
        key: `engram:updated:${view.from ?? ""}:${to}`,
        text:
          view.from === undefined
            ? say(`Engram ${to} set up. ${restart}`, `Engram ${to} configurado. ${restart}`)
            : say(
                `Engram ${view.from} → ${to} updated. ${restart}`,
                `Engram ${view.from} → ${to} actualizado. ${restart}`,
              ),
        level: "info",
      };
    case "failed": {
      const why = clip(view.message ?? say("no detail", "sin detalle"), MAX_REASON);
      return {
        key: `engram:failed:${why}`,
        text: say(`Could not install Engram: ${why}`, `No se pudo instalar Engram: ${why}`),
        level,
      };
    }
    case "none": {
      if (!asked) return undefined;
      const version = view.status?.engram?.active?.version ?? view.to;
      return {
        key: "engram:none",
        text:
          version === undefined || version === null
            ? say("Engram is up to date.", "Engram al día.")
            : say(`Engram is up to date (${version}).`, `Engram al día (${version}).`),
        level: "info",
      };
    }
    case "busy":
      return asked
        ? {
            key: "engram:busy",
            text: say(
              "Another haril tools ensure is running; nothing was changed.",
              "Otro «haril tools ensure» está en marcha; no se cambió nada.",
            ),
            level: "warning",
          }
        : undefined;
    case "skipped":
      return asked
        ? {
            key: "engram:skipped",
            text: say(
              "Engram is not managed here: memory.binary points outside HARIL's copy.",
              "Engram no se gestiona aquí: memory.binary apunta fuera de la copia de HARIL.",
            ),
            level: "info",
          }
        : undefined;
  }
}

// What still needs a person after the check: a newer Engram upstream, and gentle-ai outdated or missing.
function attentionParts(status: ToolsStatusView | undefined, say: Say): Part[] {
  const parts: Part[] = [];
  const engram = status?.engram;
  if (engram?.newerUpstream === true && engram.latest !== null && engram.qualified !== null) {
    parts.push({
      key: `engram:newer:${engram.latest}`,
      text: say(
        `Engram ${engram.latest} is published; HARIL uses ${engram.qualified} until it qualifies it.`,
        `Engram ${engram.latest} publicado; HARIL usa la ${engram.qualified} hasta calificarla.`,
      ),
      level: "info",
    });
  }
  const gentle = status?.gentleAi;
  if (gentle?.state === "outdated" && gentle.active?.version && gentle.latest !== null) {
    const installed = gentle.active.version;
    parts.push({
      key: `gentle-ai:outdated:${installed}>${gentle.latest}`,
      text: say(
        `gentle-ai ${installed} → ${gentle.latest} available: Alt+L → TOOLS → Update.`,
        `gentle-ai ${installed} → ${gentle.latest} disponible: Alt+L → TOOLS → Actualizar.`,
      ),
      level: "info",
    });
  } else if (gentle?.state === "missing") {
    parts.push({
      key: "gentle-ai:missing",
      text: say(
        "gentle-ai is not installed: Alt+L → TOOLS → Install gentle-ai.",
        "gentle-ai no está instalado: Alt+L → TOOLS → Instalar gentle-ai.",
      ),
      level: "info",
    });
  }
  return parts;
}

// The notices for the check that ran when the console opened: what happened to Engram and what needs attention, less
// what this process already told (`seen` remembers it).
export function startupNotices(view: EnsureView, locale: UiLocale, seen: Set<string>): Part[] {
  const say: Say = (english, spanish) => localized(locale, english, spanish);
  const found = [engramPart(view, say, "warning", false), ...attentionParts(view.status, say)];
  const fresh: Part[] = [];
  for (const part of found) {
    if (part === undefined || seen.has(part.key)) continue;
    seen.add(part.key);
    fresh.push(part);
  }
  return fresh;
}

// The first line the command wrote to stderr, else the reason it has no document.
function reasonOf(result: CliResult, say: Say): string {
  const line = result.stderr
    .split(/\r?\n/)
    .map((part) => plainText(part).trim())
    .find((part) => part !== "");
  return clip(line ?? say("invalid answer", "respuesta no válida"), MAX_REASON);
}

// The plan `haril tools update gentle-ai` prints on stderr when it has no terminal to ask on: its lines, less the
// closing "haril: confirmation required". Undefined when what was printed is not a plan.
function planOf(stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => plainText(line).trimEnd())
    .filter((line) => line.trim() !== "" && !line.startsWith("haril:"));
  return lines.some((line) => /^\s*command\s+go install /.test(line))
    ? lines.join("\n")
    : undefined;
}

function updateNotice(view: UpdateView, say: Say): Notice {
  const warnings = view.warnings.map((warning) => say(`Warning: ${warning}`, `Aviso: ${warning}`));
  const to = view.to ?? "";
  let text: string;
  let level: Level = "info";
  switch (view.action) {
    case "installed":
      text =
        view.path === undefined
          ? say(`gentle-ai ${to} installed.`, `gentle-ai ${to} instalado.`)
          : say(
              `gentle-ai ${to} installed at ${view.path}.`,
              `gentle-ai ${to} instalado en ${view.path}.`,
            );
      break;
    case "updated":
      text = say(
        `gentle-ai ${view.from ?? "?"} → ${to} updated.`,
        `gentle-ai ${view.from ?? "?"} → ${to} actualizado.`,
      );
      break;
    case "none":
      text = say(`gentle-ai is up to date (${to}).`, `gentle-ai ya está al día (${to}).`);
      break;
    case "aborted":
      text = say(
        "Update cancelled; nothing was changed.",
        "Actualización cancelada; no se cambió nada.",
      );
      break;
    case "failed": {
      const why = clip(
        (view.message ?? say("no detail", "sin detalle")).split("\n").join(" · "),
        MAX_MESSAGE,
      );
      text = say(`Could not update gentle-ai: ${why}`, `No se pudo actualizar gentle-ai: ${why}`);
      level = "error";
      break;
    }
  }
  if (warnings.length > 0 && level === "info") level = "warning";
  return { text: [text, ...warnings].join("\n"), level };
}

// The result of looking the latest versions up again: what was found, and what still needs a person.
function refreshNotice(status: ToolsStatusView, say: Say): Notice {
  const none = say("no data", "sin dato");
  const headline = say(
    `Versions checked: Engram ${status.engram?.latest ?? none}, gentle-ai ${status.gentleAi?.latest ?? none}.`,
    `Versiones consultadas: Engram ${status.engram?.latest ?? none}, gentle-ai ${status.gentleAi?.latest ?? none}.`,
  );
  return {
    text: [headline, ...attentionParts(status, say).map((part) => part.text)].join("\n"),
    level: "info",
  };
}

export function createToolsPanel(host: ToolsHost, options: ToolsPanelOptions = {}): ToolsPanel {
  let busy: BusyKind | undefined;
  let checkError: string | undefined;
  let lastData: MemData | undefined;
  // Which view of the tab is on screen: undefined is the first one. The list's filter survives a visit to a summary.
  let route: CatalogRoute | undefined;
  let listFilter = "";
  let checkStarted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const seen = new Set<string>();
  const say: Say = (english, spanish) => localized(host.locale(), english, spanish);

  async function exec(args: readonly string[], timeoutMs: number): Promise<CliResult> {
    try {
      return await host.run(args, { timeoutMs });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, code: null, stdout: "", stderr: reason };
    }
  }

  const tell = (notice: Notice): void => {
    host.ui()?.notify(notice.text, notice.level);
  };

  const setBusy = (kind: BusyKind): void => {
    busy = kind;
    host.repaint();
  };

  // Back to idle: the tab loads again to show what changed, or only draws its actions back when nothing did.
  const settle = (changed: boolean): void => {
    busy = undefined;
    if (changed && host.memoryOpen()) host.reload();
    else host.repaint();
  };

  const memOptions = () => ({
    locale: host.locale(),
    busy,
    checkError,
    extensions: host.extensions?.(),
    catalogCard:
      host.catalog === undefined || busy !== undefined
        ? undefined
        : catalogEntryCard(host.catalog(), host.locale()),
  });

  // The view of the route on screen; undefined on the first view, or when the session has no catalog to read.
  const catalogDetails = (): DockDetails | undefined =>
    route === undefined || host.catalog === undefined
      ? undefined
      : toolsCatalogDetails(catalogView(host.catalog(), route, host.locale()));

  const dockSource: DockSource = {
    tools: () => exec(["tools", "status", "--json"], LOAD_TIMEOUT_MS),
    memory: () => exec(["memory", "status", "--json"], LOAD_TIMEOUT_MS),
    get extensions() {
      return host.extensions?.();
    },
    get locale() {
      return host.locale();
    },
    get busy() {
      return busy;
    },
    get checkError() {
      return checkError;
    },
  };

  async function runCheck(): Promise<void> {
    checkStarted = true;
    setBusy("check");
    try {
      const result = await exec(["tools", "ensure", "--json"], CHECK_TIMEOUT_MS);
      const view = parseEnsure(result.stdout);
      if (view === undefined) {
        // Into the tab, not into the user's face: the check is a courtesy, and the tab shows how it went.
        checkError = reasonOf(result, say);
        return;
      }
      checkError = undefined;
      const parts = startupNotices(view, host.locale(), seen);
      if (parts.length > 0) {
        tell({
          text: parts.map((part) => part.text).join("\n"),
          level: parts.some((part) => part.level === "warning") ? "warning" : "info",
        });
      }
    } finally {
      settle(true);
    }
  }

  async function ensure(force: boolean): Promise<void> {
    setBusy(force ? "force" : "ensure");
    let notice: Notice;
    try {
      const result = await exec(
        force ? ["tools", "ensure", "--force", "--json"] : ["tools", "ensure", "--json"],
        ENSURE_TIMEOUT_MS,
      );
      const view = parseEnsure(result.stdout);
      if (view === undefined) {
        notice = {
          text: `${say("Could not check Engram", "No se pudo comprobar Engram")}: ${reasonOf(result, say)}`,
          level: "error",
        };
      } else {
        checkError = undefined;
        notice = engramPart(view, say, "error", true) ?? {
          text: say("Engram checked.", "Engram comprobado."),
          level: "info",
        };
      }
    } finally {
      busy = undefined;
    }
    tell(notice);
    settle(true);
  }

  async function refresh(): Promise<void> {
    setBusy("refresh");
    let notice: Notice;
    try {
      const result = await exec(["tools", "status", "--refresh", "--json"], REFRESH_TIMEOUT_MS);
      const status = parseToolsStatus(result.stdout);
      if (status === undefined) {
        notice = {
          text: `${say("Could not look the versions up", "No se pudieron consultar las versiones")}: ${reasonOf(result, say)}`,
          level: "error",
        };
      } else {
        checkError = undefined;
        notice = refreshNotice(status, say);
      }
    } finally {
      busy = undefined;
    }
    tell(notice);
    settle(true);
  }

  async function update(): Promise<void> {
    setBusy("plan");
    let notice: Notice | undefined;
    try {
      // Without --yes and without a terminal the CLI changes nothing: it prints the plan and stops (exit 2).
      const plan = await exec(["tools", "update", "gentle-ai", "--json"], PLAN_TIMEOUT_MS);
      const settled = parseUpdate(plan.stdout);
      const text = planOf(plan.stderr);
      if (settled !== undefined) {
        // Already current, or the plan could not be made (no Go, the latest version unknown): nothing to ask.
        notice = updateNotice(settled, say);
      } else if (text === undefined) {
        notice = {
          text: `${say("Could not prepare the gentle-ai update", "No se pudo preparar la actualización de gentle-ai")}: ${reasonOf(plan, say)}`,
          level: "error",
        };
      } else {
        const ui = host.ui();
        const proceed =
          ui !== undefined &&
          (await ui.confirm(
            say("Update gentle-ai", "Actualizar gentle-ai"),
            `${text}\n\n${say("Proceed?", "¿Continuar?")}`,
          ));
        if (proceed) {
          setBusy("update");
          const run = await exec(
            ["tools", "update", "gentle-ai", "--yes", "--json"],
            UPDATE_TIMEOUT_MS,
          );
          const finished = parseUpdate(run.stdout);
          notice =
            finished === undefined
              ? {
                  text: `${say("Could not update gentle-ai", "No se pudo actualizar gentle-ai")}: ${reasonOf(run, say)}`,
                  level: "error",
                }
              : updateNotice(finished, say);
        }
      }
    } finally {
      busy = undefined;
    }
    if (notice !== undefined) tell(notice);
    settle(notice !== undefined);
  }

  const go = (next: CatalogRoute | undefined): void => {
    route = next;
    host.repaint();
  };

  // Puts a real command in the editor, for the user to run: the extension API cannot run another extension's command.
  function insert(text: string): void {
    const ui = host.ui();
    if (ui?.setEditorText === undefined) return;
    ui.setEditorText(text);
    tell({
      text: say(
        `In the editor: ${text.trim()}. Enter runs it.`,
        `En el editor: ${text.trim()}. Enter lo ejecuta.`,
      ),
      level: "info",
    });
  }

  async function chooseFilter(): Promise<void> {
    const typed = await host
      .ui()
      ?.input?.(say("Filter skills and MCP", "Filtrar skills y MCP"), listFilter);
    if (typed === undefined) return;
    listFilter = typed.trim();
    go({ kind: "list", filter: listFilter });
  }

  async function toggleServer(name: string): Promise<void> {
    const server = host.catalog?.().servers.find((item) => item.name === name);
    if (
      server === undefined ||
      server.scope !== "global" ||
      server.managed ||
      server.file === undefined
    )
      return;
    const enable = server.state === "disabled";
    const ui = host.ui();
    const word = enable ? say("Enable", "Activar") : say("Disable", "Desactivar");
    const proceed =
      ui !== undefined &&
      (await ui.confirm(
        `${word} ${name}`,
        say(
          `Saves it in ${server.file}. It applies at the next start or /reload; /mcp applies it now. Proceed?`,
          `Se guarda en ${server.file}. Aplica al próximo inicio o con /reload; /mcp lo aplica ya. ¿Continuar?`,
        ),
      ));
    if (!proceed) return;
    const result = setMcpEnabled(server.file, name, enable);
    tell(
      result.ok
        ? {
            text: say(
              `${name} saved as ${enable ? "enabled" : "disabled"}. It applies at the next start or /reload.`,
              `${name} guardado como ${enable ? "activado" : "desactivado"}. Aplica al próximo inicio o con /reload.`,
            ),
            level: "info",
          }
        : {
            text: say(
              `Nothing was changed: mcp.json could not be updated (${result.reason}).`,
              `No se cambió nada: no se pudo actualizar mcp.json (${result.reason}).`,
            ),
            level: "error",
          },
    );
    host.repaint();
  }

  // The rows of the list and the summaries. Moving between views runs no command, so it works while the tab is busy.
  async function catalogAct(action: string): Promise<void> {
    const named = (prefix: string): string | undefined =>
      action.startsWith(prefix) ? action.slice(prefix.length) : undefined;
    if (action === CATALOG_ACTIONS.list) return go({ kind: "list", filter: listFilter });
    if (action === CATALOG_ACTIONS.back) {
      return go(
        route?.kind === "list" || route === undefined
          ? undefined
          : { kind: "list", filter: listFilter },
      );
    }
    if (action === CATALOG_ACTIONS.filter) return chooseFilter();
    if (action === CATALOG_ACTIONS.mcpManager) return insert("/mcp");
    const use = named(CATALOG_ACTIONS.useSkill);
    if (use !== undefined) return canInsertName(use) ? insert(`/skill:${use} `) : undefined;
    const reconnect = named(CATALOG_ACTIONS.mcpReconnect);
    if (reconnect !== undefined) {
      return canInsertName(reconnect) ? insert(`/mcp reconnect ${reconnect}`) : undefined;
    }
    const toggle = named(CATALOG_ACTIONS.mcpToggle);
    if (toggle !== undefined) return toggleServer(toggle);
    const skill = named(CATALOG_ACTIONS.skill);
    if (skill !== undefined) return go({ kind: "skill", name: skill });
    const server = named(CATALOG_ACTIONS.mcp);
    if (server !== undefined) return go({ kind: "mcp", name: server });
  }

  const handlers: Record<string, () => Promise<void>> = {
    [TOOLS_ACTIONS.ensure]: () => ensure(false),
    [TOOLS_ACTIONS.force]: () => ensure(true),
    [TOOLS_ACTIONS.refresh]: refresh,
    [TOOLS_ACTIONS.update]: update,
  };

  return {
    async load() {
      const data = await loadMemData("", dockSource);
      lastData = data;
      return catalogDetails() ?? memDetails(data, memOptions());
    },
    view() {
      if (lastData === undefined) return undefined;
      return catalogDetails() ?? memDetails(lastData, memOptions());
    },
    async act(action) {
      if (action.startsWith("catalog:")) {
        try {
          await catalogAct(action);
        } catch (error) {
          tell({ text: error instanceof Error ? error.message : String(error), level: "error" });
        }
        return;
      }
      const handler = Object.hasOwn(handlers, action) ? handlers[action] : undefined;
      if (handler === undefined) return;
      if (busy !== undefined) {
        tell({
          text: say(
            `Another operation is running: ${busyLabel(busy, say)}.`,
            `Hay otra operación en curso: ${busyLabel(busy, say)}.`,
          ),
          level: "warning",
        });
        return;
      }
      try {
        await handler();
      } catch (error) {
        // Whatever escaped the handler is a notice, never an exception in the console.
        busy = undefined;
        tell({
          text: error instanceof Error ? error.message : String(error),
          level: "error",
        });
        host.repaint();
      }
    },
    busy: () => busy,
    source: () => dockSource,
    scheduleCheck() {
      if (checkStarted || timer !== undefined || !toolsCheckEnabled(host.env())) return;
      timer = setTimeout(() => {
        timer = undefined;
        void runCheck();
      }, options.checkDelayMs ?? DEFAULT_CHECK_DELAY_MS);
      timer.unref();
    },
    cancelCheck() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
