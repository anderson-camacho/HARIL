import type { ShellSnapshot } from "../data.js";

// The panels of the shell (RF-152) in tab order. Numbers 1 to 9 select the first nine; Tab cycles through all eleven.
export const PANELS = [
  { id: "projects", label: "Projects" },
  { id: "tasks", label: "Tasks" },
  { id: "agents", label: "Agents" },
  { id: "tokens", label: "Tokens" },
  { id: "events", label: "Events" },
  { id: "models", label: "Models" },
  { id: "config", label: "Config" },
  { id: "themes", label: "Themes" },
  { id: "memory", label: "Memory" },
  { id: "services", label: "Services" },
  { id: "terminals", label: "Terminals" },
] as const;

export type PanelId = (typeof PANELS)[number]["id"];

export const NOT_AVAILABLE = "Not available in this version.";
const NO_STORE_MESSAGE =
  "No HARIL data yet. Create a project with: haril project init <path> --name <name>";

// What the Config and Themes panels show about the process that started the shell.
export interface ShellSettings {
  readonly dataDir: string | undefined;
  readonly runtimeRoot: string | undefined;
  readonly configPath: string | undefined;
  // The name asked for by ui.theme (or the default).
  readonly themeName: string;
  // The name of the theme in use after loading (it differs only when the requested theme could not be loaded).
  readonly themeLabel: string;
}

export interface PanelContext {
  readonly snapshot: ShellSnapshot;
  readonly settings: ShellSettings;
  // The chosen project id, or undefined for all projects.
  readonly scope: string | undefined;
}

interface PanelItem {
  readonly text: string;
  // What Enter acts on: a task id (Tasks) or a project id, with "" meaning all projects (Projects).
  readonly value?: string;
}

// Header lines are never selected; items are selected with the cursor; keys are the footer hints of the panel.
export interface PanelView {
  readonly header: readonly string[];
  readonly items: readonly PanelItem[];
  readonly empty?: string;
  readonly keys: readonly string[];
}

// The message for the data panels when the store is missing or could not be read; undefined when there is a store.
export function storeMessage(snapshot: ShellSnapshot): string | undefined {
  if (snapshot.storeError !== undefined)
    return `The store could not be read: ${snapshot.storeError}`;
  if (!snapshot.initialized) return NO_STORE_MESSAGE;
  return undefined;
}
