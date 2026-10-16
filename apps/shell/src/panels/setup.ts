import { NATIVE_THEME_NAMES } from "../theme.js";
import { NOT_AVAILABLE, type PanelContext, type PanelView } from "./types.js";

// The panels about configuration: providers (never their key values), settings and themes, and the three panels
// that are not available in this version. None of them reads the store or the network.

export function modelsView(context: PanelContext): PanelView {
  const { providers } = context.snapshot;
  const source =
    providers.source === "file"
      ? `providers from ${context.settings.configPath ?? "haril.json"}`
      : "providers from the built-in gateway (no haril.json)";
  return {
    header: [
      source,
      "Run haril models to query live catalogs (the shell makes no network calls).",
      ...(providers.error === undefined ? [] : [`config error: ${providers.error}`]),
    ],
    items: providers.rows.map((row) => ({
      text: `${row.id}  ${row.baseUrl}  ${
        row.keyEnv === undefined
          ? "no key needed"
          : `key ${row.keyEnv}: ${row.keySet ? "set" : "not set"}`
      }`,
    })),
    empty:
      providers.rows.length === 0 && providers.error === undefined
        ? "No providers configured."
        : undefined,
    keys: [],
  };
}

export function configView(context: PanelContext): PanelView {
  const { settings, snapshot } = context;
  const store =
    snapshot.storeError !== undefined
      ? `error: ${snapshot.storeError}`
      : snapshot.initialized
        ? "initialized"
        : "not initialized";
  return {
    header: [],
    items: [
      { text: `data dir      ${settings.dataDir ?? "not set"}` },
      { text: `store         ${store}` },
      { text: `runtime root  ${settings.runtimeRoot ?? "not set"}` },
      { text: `config file   ${settings.configPath ?? "not set"}` },
      { text: `theme         ${settings.themeName} (in use: ${settings.themeLabel})` },
      {
        text: `user themes   ${snapshot.themes.user.length} (in config/themes under the runtime root)`,
      },
    ],
    keys: [],
  };
}

export function themesView(context: PanelContext): PanelView {
  const { settings, snapshot } = context;
  const names = [
    ...NATIVE_THEME_NAMES.map((name) => ({ name, origin: "native" })),
    ...snapshot.themes.user
      .filter((name) => !NATIVE_THEME_NAMES.includes(name))
      .map((name) => ({ name, origin: "user" })),
  ];
  return {
    header: [`theme in use: ${settings.themeLabel} (ui.theme in haril.json)`],
    items: names.map(({ name, origin }) => ({
      text: `${name}  ${origin}${name === settings.themeLabel ? "  (current)" : ""}`,
    })),
    keys: [],
  };
}

export function unavailableView(): PanelView {
  return { header: [NOT_AVAILABLE], items: [], keys: [] };
}
