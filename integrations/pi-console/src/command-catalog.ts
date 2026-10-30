import { DASHBOARD_AREAS } from "./dashboard.js";

export interface CommandDescription {
  readonly name: string;
  readonly description: string;
}

const CONSOLE_COMMANDS: readonly CommandDescription[] = [
  { name: "language", description: "Idioma de la interfaz" },
  { name: "haril-plugin", description: "Abrir o cambiar el espacio del dock izquierdo" },
  { name: "haril-plugins", description: "Mostrar, ocultar y ordenar espacios del dock" },
  { name: "haril-extensions", description: "Gestionar paquetes Pi declarados en HARIL" },
  { name: "haril-dock", description: "Mostrar u ocultar columnas" },
  { name: "haril-focus", description: "Abrir detalles de la sección actual" },
  { name: "haril-panel", description: "Abrir el menú de teclado del panel derecho" },
  { name: "haril-commands", description: "Consultar los comandos registrados ahora" },
  ...DASHBOARD_AREAS.map((area) => ({ name: area, description: `Abrir área ${area}` })),
];

/** This is the list Pi exposes to an extension, not an invented inventory of Pi's built-in commands. */
export function commandCatalog(
  registered: readonly string[],
  harilCommands: readonly CommandDescription[],
): string[] {
  const cleanNames = [
    ...new Set(registered.filter((name) => /^[a-z][a-z0-9_-]{0,63}$/i.test(name))),
  ];
  const available = new Set(cleanNames);
  const descriptions = [...harilCommands, ...CONSOLE_COMMANDS];
  const known = new Set(descriptions.map(({ name }) => name));
  const our = descriptions.filter(({ name }) => available.has(name));
  const other = cleanNames.filter((name) => !known.has(name)).sort((a, b) => a.localeCompare(b));

  const lines = [
    "Comandos reportados por las extensiones de esta sesión de Pi.",
    "Estos comandos se escriben con / dentro del chat.",
    "",
    `HARIL (${our.length} disponibles)`,
    ...our.map(({ name, description }) => `/${name} · ${description}`),
    "",
    `OTRAS EXTENSIONES · COMANDOS (${other.length})`,
    ...(other.length ? other.map((name) => `/${name}`) : ["No se reportan comandos adicionales."]),
    "",
    "ATAJOS HARIL",
    "Alt+L · seleccionar plugin; luego 1–3, flechas y Enter",
    "Alt+I · mostrar u ocultar el panel derecho",
    "Alt+K · menú del panel derecho (flechas y Enter) o /haril-panel",
    "Alt+H · elegir área; Alt+O · orquestación",
    "Alt+M · cambiar modo; Alt+X · detener todo",
    "",
    "Pi tiene además comandos nativos que esta API no enumera.",
    "Usa /hotkeys para comprobar los atajos reales de tu sesión.",
    "Desde PowerShell usa: haril help (comandos de la CLI).",
  ];
  return lines;
}
