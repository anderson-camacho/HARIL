import { tailFit } from "./docs-folder.js";
import { localized, type UiLocale } from "./locale.js";
import { CARD_CONTENT_WIDTH } from "./rail-metrics.js";
import type { DockCard, DockRowAction } from "./rail-view.js";
import { truncate, wrap } from "./text.js";
import type { Catalog, CatalogWarning, McpEntry, McpState, SkillEntry } from "./tools-catalog.js";

// The skills and MCP servers of the TOOLS tab: a list, and a summary of each. Built only from what tools-catalog.ts
// established, and says only what that module could know.

const ROW_WIDTH = CARD_CONTENT_WIDTH;
const MAX_TOOL_NAMES = 12;

// The rows that navigate or act. The ones ending in ":" are followed by the name of a skill or a server.
export const CATALOG_ACTIONS = {
  list: "catalog:list",
  back: "catalog:back",
  filter: "catalog:filter",
  skill: "catalog:skill:",
  mcp: "catalog:mcp:",
  useSkill: "catalog:use-skill:",
  mcpReconnect: "catalog:mcp-reconnect:",
  mcpManager: "catalog:mcp-manager",
  mcpToggle: "catalog:mcp-toggle:",
} as const;

export type CatalogRoute =
  | { readonly kind: "list"; readonly filter: string }
  | { readonly kind: "skill"; readonly name: string }
  | { readonly kind: "mcp"; readonly name: string };

export interface CatalogRows {
  readonly status: string;
  readonly cards: DockCard[];
}

type Say = (english: string, spanish: string) => string;

const STATE_WORDS: Record<McpState, readonly [string, string]> = {
  connected: ["connected", "conectado"],
  disabled: ["off", "desactivado"],
  not_checked: ["not checked", "sin comprobar"],
  invalid: ["invalid", "no válido"],
};

const sentence = (text: string): string[] => wrap(text, ROW_WIDTH);
const stateWord = (state: McpState, say: Say): string =>
  say(STATE_WORDS[state][0], STATE_WORDS[state][1]);

// Whether a name can be typed as one argument of a command.
const typeable = (name: string): boolean => /^[\w.-]+$/u.test(name);

// A skill or server name as an argument of an inserted command; only names that need no quoting get there.
export const canInsertName = typeable;

function warningRow(warning: CatalogWarning, say: Say): string[] {
  const file = tailFit(warning.file, ROW_WIDTH);
  switch (warning.kind) {
    case "damaged":
      return [
        ...sentence(
          say(
            "This file could not be read (not valid JSON):",
            "Este archivo no se pudo leer (JSON no válido):",
          ),
        ),
        file,
      ];
    case "misshapen":
      return [
        ...sentence(
          say(
            "This file could not be read (unexpected shape):",
            "Este archivo no se pudo leer (forma inesperada):",
          ),
        ),
        file,
      ];
    case "too_large":
      return [
        ...sentence(
          say(
            "This file could not be read (too large):",
            "Este archivo no se pudo leer (demasiado grande):",
          ),
        ),
        file,
      ];
    case "unreadable":
      return [
        ...sentence(say("This file could not be read:", "Este archivo no se pudo leer:")),
        file,
      ];
  }
}

// A row per name and one of description under it; a click on either opens the summary, and the name's row is the one
// the keyboard menu lists.
function listCard(
  title: string,
  items: readonly {
    name: string;
    head: string;
    detail: string | undefined;
    action: string;
    label: string;
  }[],
  empty: readonly string[],
): DockCard {
  if (items.length === 0)
    return { title, rows: [...empty], tones: empty.map(() => "muted" as const) };
  const rows: string[] = [];
  const tones: ("cyan" | "muted")[] = [];
  const rowActions: (DockRowAction | undefined)[] = [];
  for (const item of items) {
    rows.push(truncate(`▸ ${item.head}`, ROW_WIDTH));
    tones.push("cyan");
    rowActions.push({ action: item.action, label: item.label });
    if (item.detail !== undefined) {
      rows.push(truncate(`  ${item.detail}`, ROW_WIDTH));
      tones.push("muted");
      rowActions.push({ action: item.action });
    }
  }
  return { title, rows, tones, rowActions };
}

function serverHead(server: McpEntry, say: Say): string {
  const count = server.tools.length > 0 ? ` · ${server.tools.length}` : "";
  return `${server.name} · ${stateWord(server.state, say)}${count}`;
}

function listRows(catalog: Catalog, filter: string, say: Say): CatalogRows {
  const wanted = filter.trim().toLowerCase();
  const matches = (name: string, description: string | undefined): boolean =>
    wanted === "" || `${name} ${description ?? ""}`.toLowerCase().includes(wanted);
  const skills = catalog.skills.filter((skill) => matches(skill.name, skill.description));
  const servers = catalog.servers.filter((server) => matches(server.name, server.description));
  const count = (shown: number, all: number): string =>
    wanted === "" ? `${all}` : `${shown}/${all}`;
  const nothing = sentence(say("Nothing matches the filter.", "Nada coincide con el filtro."));

  const cards: DockCard[] = [];
  if (catalog.warnings.length > 0) {
    cards.push({
      title: say("Warning", "Aviso"),
      rows: catalog.warnings.flatMap((warning) => warningRow(warning, say)),
    });
  }
  cards.push(
    listCard(
      `MCP · ${count(servers.length, catalog.servers.length)}`,
      servers.map((server) => ({
        name: server.name,
        head: serverHead(server, say),
        detail: server.description,
        action: `${CATALOG_ACTIONS.mcp}${server.name}`,
        label: `MCP: ${server.name}`,
      })),
      wanted !== ""
        ? nothing
        : [
            ...sentence(
              say(
                "No MCP servers configured. They go in:",
                "Sin servidores MCP. Se configuran en:",
              ),
            ),
            tailFit(catalog.globalFile, ROW_WIDTH),
          ],
    ),
    listCard(
      `Skills · ${count(skills.length, catalog.skills.length)}`,
      skills.map((skill) => ({
        name: skill.name,
        head: skill.name,
        detail: skill.description,
        action: `${CATALOG_ACTIONS.skill}${skill.name}`,
        label: `Skill: ${skill.name}`,
      })),
      wanted !== ""
        ? nothing
        : sentence(
            say(
              `No skills loaded. Put a folder with a SKILL.md in ${catalog.agentDir}/skills (all projects) or .pi/skills (this project), then /reload.`,
              `Sin skills cargadas. Pon una carpeta con SKILL.md en ${catalog.agentDir}/skills (todos los proyectos) o en .pi/skills (este proyecto) y usa /reload.`,
            ),
          ),
    ),
    {
      title: say("Actions", "Acciones"),
      rows: [],
      buttons: [
        {
          action: CATALOG_ACTIONS.filter,
          label:
            wanted === ""
              ? say("Filter…", "Filtrar…")
              : `${say("Filter", "Filtro")}: ${filter.trim()}`,
        },
        { action: CATALOG_ACTIONS.back, label: say("Back", "Volver") },
      ],
    },
  );
  return { status: say("Skills and MCP", "Skills y MCP"), cards };
}

const backButton = (say: Say) => ({ action: CATALOG_ACTIONS.back, label: say("Back", "Volver") });

function notFound(name: string, say: Say): CatalogRows {
  return {
    status: name,
    cards: [
      {
        title: name,
        rows: sentence(say("It is no longer listed.", "Ya no aparece en la lista.")),
        buttons: [backButton(say)],
      },
    ],
  };
}

function skillRows(skill: SkillEntry, say: Say): CatalogRows {
  const invocation = `/skill:${skill.name}`;
  return {
    status: `Skill · ${skill.name}`,
    cards: [
      {
        title: `Skill · ${skill.name}`,
        rows: [
          ...sentence(skill.description ?? say("No description.", "Sin descripción.")),
          "",
          say("Source", "Origen"),
          skill.path === undefined
            ? say("not reported", "no informado")
            : tailFit(skill.path, ROW_WIDTH),
          ...(skill.source === undefined ? [] : [skill.source]),
          "",
          say("How to use it", "Cómo usarla"),
          ...sentence(invocation),
          ...sentence(
            say(
              "Add your request after it. Pi loads the skill's instructions for that message.",
              "Añade tu petición detrás. Pi carga las instrucciones de la skill para ese mensaje.",
            ),
          ),
          ...sentence(
            skill.modelInvocable
              ? say(
                  "The model may also load it by itself.",
                  "El modelo también puede cargarla solo.",
                )
              : say(
                  "Only by this command: the model does not load it.",
                  "Solo con este comando: el modelo no la carga.",
                ),
          ),
        ],
        buttons: [
          ...(canInsertName(skill.name)
            ? [
                {
                  action: `${CATALOG_ACTIONS.useSkill}${skill.name}`,
                  label: truncate(`${say("Insert", "Insertar")} ${invocation}`, ROW_WIDTH - 4),
                },
              ]
            : []),
          backButton(say),
        ],
      },
    ],
  };
}

function stateExplained(server: McpEntry, catalog: Catalog, say: Say): string[] {
  switch (server.state) {
    case "connected":
      return sentence(
        say(
          "Pi registered its tools in this session. A later drop is not visible from here.",
          "Pi registró sus herramientas en esta sesión. Una caída posterior no se ve desde aquí.",
        ),
      );
    case "disabled":
      return sentence(
        say("Pi keeps the entry without connecting.", "Pi guarda la entrada sin conectarla."),
      );
    case "invalid":
      return sentence(say("It has neither command nor url.", "No tiene command ni url."));
    case "not_checked":
      return sentence(
        !catalog.mcpCommand
          ? say(
              "Pi's MCP support is not active in this session.",
              "El soporte MCP de Pi no está activo en esta sesión.",
            )
          : say(
              "No tools seen: starting, failed or offering none. /mcp tells which.",
              "Sin herramientas a la vista: arrancando, con fallo o sin ofrecer ninguna. /mcp lo dice.",
            ),
      );
  }
}

function scopeWord(server: McpEntry, say: Say): string {
  switch (server.scope) {
    case "global":
      return say("Global file", "Archivo global");
    case "project":
      return say(
        "Project file (trusted projects only)",
        "Archivo del proyecto (solo si es de confianza)",
      );
    case "extension":
      return say("Registered by an extension", "Registrado por una extensión");
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function mcpRows(server: McpEntry, catalog: Catalog, say: Say): CatalogRows {
  const rows: string[] = [
    ...(server.description === undefined ? [] : [...sentence(server.description), ""]),
    `${say("State", "Estado")}: ${stateWord(server.state, say)}`,
    ...stateExplained(server, catalog, say),
    "",
    `${say("Tools", "Herramientas")}: ${server.tools.length}`,
    ...server.tools.slice(0, MAX_TOOL_NAMES).map((tool) => truncate(`  ${tool}`, ROW_WIDTH)),
    ...(server.tools.length > MAX_TOOL_NAMES
      ? [
          say(
            `  …and ${server.tools.length - MAX_TOOL_NAMES} more`,
            `  …y ${server.tools.length - MAX_TOOL_NAMES} más`,
          ),
        ]
      : []),
    "",
    ...(server.transport === undefined
      ? []
      : [`${say("Transport", "Transporte")}: ${server.transport}`]),
    ...(server.target === undefined ? [] : [tailFit(server.target, ROW_WIDTH)]),
    ...sentence(
      [
        plural(server.argCount, say("argument", "argumento"), say("arguments", "argumentos")),
        plural(server.envCount, say("env var", "variable"), say("env vars", "variables")),
        plural(server.headerCount, "header", "headers"),
      ].join(" · ") + say(" (values hidden)", " (valores ocultos)"),
    ),
    ...(server.exposure === undefined
      ? []
      : [`${say("Exposure", "Exposición")}: ${server.exposure}`]),
    "",
    ...sentence(scopeWord(server, say)),
    ...(server.file === undefined ? [] : [tailFit(server.file, ROW_WIDTH)]),
  ];

  const buttons: { action: string; label: string }[] = [];
  if (catalog.mcpCommand) {
    if (server.state !== "disabled" && server.state !== "invalid" && typeable(server.name)) {
      buttons.push({
        action: `${CATALOG_ACTIONS.mcpReconnect}${server.name}`,
        label: say("Insert /mcp reconnect", "Insertar /mcp reconnect"),
      });
    }
    buttons.push({
      action: CATALOG_ACTIONS.mcpManager,
      label: say("Insert /mcp (on/off now)", "Insertar /mcp (on/off ya)"),
    });
  }
  const toggleable = server.scope === "global" && !server.managed && server.state !== "invalid";
  if (toggleable) {
    buttons.push({
      action: `${CATALOG_ACTIONS.mcpToggle}${server.name}`,
      label:
        server.state === "disabled"
          ? say("Enable in mcp.json…", "Activar en mcp.json…")
          : say("Disable in mcp.json…", "Desactivar en mcp.json…"),
    });
    rows.push(
      "",
      ...sentence(
        say(
          "Saving to mcp.json applies at the next start or /reload; /mcp applies now.",
          "Guardar en mcp.json aplica al próximo inicio o con /reload; /mcp aplica ya.",
        ),
      ),
    );
  } else if (server.managed) {
    rows.push(
      "",
      ...sentence(
        say(
          "HARIL manages this entry: haril tools ensure rewrites it, so a saved off would not last. /mcp turns it off until then.",
          "HARIL gestiona esta entrada: haril tools ensure la reescribe y un apagado guardado no duraría. /mcp la apaga hasta entonces.",
        ),
      ),
    );
  }
  buttons.push(backButton(say));
  return {
    status: `MCP · ${server.name}`,
    cards: [{ title: truncate(`MCP · ${server.name}`, ROW_WIDTH), rows, buttons }],
  };
}

export function catalogView(catalog: Catalog, route: CatalogRoute, locale: UiLocale): CatalogRows {
  const say: Say = (english, spanish) => localized(locale, english, spanish);
  if (route.kind === "list") return listRows(catalog, route.filter, say);
  if (route.kind === "skill") {
    const skill = catalog.skills.find(({ name }) => name === route.name);
    return skill === undefined ? notFound(route.name, say) : skillRows(skill, say);
  }
  const server = catalog.servers.find(({ name }) => name === route.name);
  return server === undefined ? notFound(route.name, say) : mcpRows(server, catalog, say);
}

// The card of the tab's first view that leads to the list.
export function catalogEntryCard(catalog: Catalog, locale: UiLocale): DockCard {
  const say: Say = (english, spanish) => localized(locale, english, spanish);
  const connected = catalog.servers.filter(({ state }) => state === "connected").length;
  const warned = catalog.warnings.length > 0;
  return {
    title: `${catalog.skills.length} skills · ${catalog.servers.length} MCP · ${connected} ${say("connected", "conectados")}`,
    rows: [
      truncate(
        `▸ ${say("Open skills and MCP", "Abrir skills y MCP")}${warned ? " (!)" : ""}`,
        ROW_WIDTH,
      ),
    ],
    tones: ["cyan"],
    rowActions: [
      { action: CATALOG_ACTIONS.list, label: say("Open skills and MCP", "Abrir skills y MCP") },
    ],
  };
}
