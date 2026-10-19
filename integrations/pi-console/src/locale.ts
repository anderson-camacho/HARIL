export type UiLocale = "es" | "en";

export const DEFAULT_UI_LOCALE: UiLocale = "es";

export function readConsoleLocale(config: unknown): UiLocale {
  if (typeof config !== "object" || config === null || !("path" in config) || !("value" in config))
    return DEFAULT_UI_LOCALE;
  if (config.path !== "ui.locale") return DEFAULT_UI_LOCALE;
  return config.value === "es" || config.value === "en" ? config.value : DEFAULT_UI_LOCALE;
}

export function localized(locale: UiLocale, english: string, spanish: string): string {
  return locale === "es" ? spanish : english;
}
