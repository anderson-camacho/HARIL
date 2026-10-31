import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Pi reads this HARIL-managed theme from its private agent directory.
// Keep the palette aligned with apps/shell/themes/haril-matrix.json.
export const MATRIX_PI_THEME = {
  $schema: "https://pi.dev/schemas/theme.schema.json",
  name: "haril-matrix",
  appearance: "dark",
  vars: {
    phosphor: "#26ee68",
    neon: "#77ffa5",
    light: "#c6f4d2",
    soft: "#a1d6b1",
    mutedGreen: "#769781",
    dimGreen: "#4b7058",
    outline: "#205332",
    deep: "#06140a",
    panel: "#0b2412",
    selected: "#174126",
    errorRed: "#ff6576",
    amber: "#e7cf75",
  },
  colors: {
    accent: "phosphor",
    border: "outline",
    borderAccent: "neon",
    borderMuted: "dimGreen",
    success: "neon",
    error: "errorRed",
    warning: "amber",
    muted: "mutedGreen",
    dim: "dimGreen",
    text: "light",
    thinkingText: "soft",
    selectedBg: "selected",
    scrollbarTrack: "deep",
    scrollbarThumb: "outline",
    searchMatchBg: "selected",
    searchMatchText: "neon",
    userMessageBg: "deep",
    userMessageText: "light",
    customMessageBg: "panel",
    customMessageText: "soft",
    customMessageLabel: "phosphor",
    toolPendingBg: "deep",
    toolSuccessBg: "panel",
    toolErrorBg: "#311018",
    toolTitle: "light",
    toolOutput: "soft",
    mdHeading: "neon",
    mdLink: "phosphor",
    mdLinkUrl: "mutedGreen",
    mdCode: "neon",
    mdCodeBlock: "phosphor",
    mdCodeBlockBorder: "outline",
    mdQuote: "soft",
    mdQuoteBorder: "dimGreen",
    mdHr: "outline",
    mdListBullet: "phosphor",
    toolDiffAdded: "neon",
    toolDiffRemoved: "errorRed",
    toolDiffContext: "mutedGreen",
    syntaxComment: "dimGreen",
    syntaxKeyword: "neon",
    syntaxFunction: "phosphor",
    syntaxVariable: "light",
    syntaxString: "#b2efac",
    syntaxNumber: "neon",
    syntaxType: "soft",
    syntaxOperator: "mutedGreen",
    syntaxPunctuation: "mutedGreen",
    thinkingOff: "dimGreen",
    thinkingMinimal: "mutedGreen",
    thinkingLow: "soft",
    thinkingMedium: "phosphor",
    thinkingHigh: "neon",
    thinkingXhigh: "#c0ffcf",
    thinkingMax: "amber",
    bashMode: "phosphor",
  },
  export: {
    pageBg: "#000000",
    cardBg: "deep",
    infoBg: "selected",
  },
} as const;

// Writes a managed theme under agent/themes, repairing a stale or broken copy. Nothing else there is touched.
export function writeManagedPiTheme(agentDir: string, theme: { readonly name: string }): string {
  const themes = join(agentDir, "themes");
  mkdirSync(themes, { recursive: true });
  const path = join(themes, `${theme.name}.json`);
  const expected = `${JSON.stringify(theme, null, 2)}\n`;
  if (!existsSync(path) || readFileSync(path, "utf8") !== expected) {
    writeFileSync(path, expected, "utf8");
  }
  return path;
}

export function ensureMatrixPiTheme(agentDir: string): string {
  return writeManagedPiTheme(agentDir, MATRIX_PI_THEME);
}
