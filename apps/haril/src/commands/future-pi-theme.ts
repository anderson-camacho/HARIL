import { MATRIX_PI_THEME, writeManagedPiTheme } from "./matrix-pi-theme.js";

// Pi reads this HARIL-managed theme from its private agent directory: blue surfaces with thin orange lines.
// Keep the palette aligned with apps/shell/themes/haril-future.json.
export const FUTURE_PI_THEME = {
  $schema: "https://pi.dev/schemas/theme.schema.json",
  name: "haril-future",
  appearance: "dark",
  vars: {
    electric: "#5ec2ff",
    turquoise: "#7df8d5",
    light: "#c4e9ff",
    soft: "#9dcdec",
    mutedBlue: "#7fa3c7",
    dimBlue: "#56789c",
    line: "#b86e2e",
    lineAccent: "#ff9f45",
    deep: "#07172c",
    panel: "#0c2240",
    selected: "#16365c",
    errorRed: "#ff6576",
    amber: "#f4d35e",
  },
  colors: {
    accent: "electric",
    border: "line",
    borderAccent: "lineAccent",
    borderMuted: "line",
    success: "turquoise",
    error: "errorRed",
    warning: "amber",
    muted: "mutedBlue",
    dim: "dimBlue",
    text: "light",
    thinkingText: "soft",
    selectedBg: "selected",
    scrollbarTrack: "deep",
    scrollbarThumb: "dimBlue",
    searchMatchBg: "selected",
    searchMatchText: "turquoise",
    userMessageBg: "deep",
    userMessageText: "light",
    customMessageBg: "panel",
    customMessageText: "soft",
    customMessageLabel: "electric",
    toolPendingBg: "deep",
    toolSuccessBg: "panel",
    toolErrorBg: "#3a1a2a",
    toolTitle: "light",
    toolOutput: "soft",
    mdHeading: "turquoise",
    mdLink: "electric",
    mdLinkUrl: "mutedBlue",
    mdCode: "turquoise",
    mdCodeBlock: "electric",
    mdCodeBlockBorder: "line",
    mdQuote: "soft",
    mdQuoteBorder: "line",
    mdHr: "line",
    mdListBullet: "electric",
    toolDiffAdded: "turquoise",
    toolDiffRemoved: "errorRed",
    toolDiffContext: "mutedBlue",
    syntaxComment: "dimBlue",
    syntaxKeyword: "turquoise",
    syntaxFunction: "electric",
    syntaxVariable: "light",
    syntaxString: "#a8e6cf",
    syntaxNumber: "turquoise",
    syntaxType: "soft",
    syntaxOperator: "mutedBlue",
    syntaxPunctuation: "mutedBlue",
    thinkingOff: "dimBlue",
    thinkingMinimal: "mutedBlue",
    thinkingLow: "soft",
    thinkingMedium: "electric",
    thinkingHigh: "turquoise",
    thinkingXhigh: "#c8fff0",
    thinkingMax: "amber",
    bashMode: "electric",
  },
  export: {
    pageBg: "deep",
    cardBg: "panel",
    infoBg: "selected",
  },
} as const;

// `ui.theme` is unset until someone chooses, so "unset" is the managed default and every stored value is a choice.
// A choice other than Future keeps the Pi theme it has always had: Matrix.
export function managedPiThemeName(configured: unknown): "haril-future" | "haril-matrix" {
  return configured === undefined || configured === "future" || configured === "haril-future"
    ? "haril-future"
    : "haril-matrix";
}

export function ensureManagedPiTheme(
  agentDir: string,
  configured: unknown,
): { readonly name: string; readonly path: string } {
  const name = managedPiThemeName(configured);
  const theme = name === "haril-future" ? FUTURE_PI_THEME : MATRIX_PI_THEME;
  return { name, path: writeManagedPiTheme(agentDir, theme) };
}
