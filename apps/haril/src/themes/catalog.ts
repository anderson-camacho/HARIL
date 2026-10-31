// The terminal profiles HARIL offers. This is data only: nothing here touches Windows Terminal, $PROFILE or fonts.
// The GUIDs are fixed for good: later slices identify the installed Windows Terminal profiles by them.

const SYMBOLS_FONT = "Symbols Nerd Font";

interface ThemeColor {
  readonly name: string;
  readonly hex: string;
}

interface ThemeFonts {
  readonly primary: string;
  readonly fallbacks: readonly string[];
  // Icons only: never the primary face or a text fallback.
  readonly symbols: string;
}

export interface ThemeProfile {
  readonly id: string;
  // The Oh My Posh themes the profile is based on.
  readonly basedOn: readonly string[];
  // The background always comes first.
  readonly palette: readonly ThemeColor[];
  readonly fonts: ThemeFonts;
  readonly windowsTerminalGuid: string;
}

export const THEME_PROFILES: readonly ThemeProfile[] = [
  {
    id: "aliens-cyberpunk",
    basedOn: ["aliens", "craver"],
    palette: [
      { name: "background", hex: "#100C21" },
      { name: "pink", hex: "#FF5AD9" },
      { name: "cyan", hex: "#42E3FA" },
      { name: "violet", hex: "#AD55DC" },
      { name: "green", hex: "#3EDCA2" },
    ],
    fonts: { primary: "RobotoMono Nerd Font", fallbacks: [], symbols: SYMBOLS_FONT },
    windowsTerminalGuid: "7c1e4a52-9d3b-4f68-a1c7-2e8b5d60f341",
  },
  {
    id: "agnoster-matrix",
    basedOn: ["agnoster", "agnoster.minimal"],
    palette: [
      { name: "background", hex: "#030D08" },
      { name: "matrix", hex: "#00FF66" },
      { name: "bright", hex: "#77FFA5" },
      { name: "secondary", hex: "#26EE68" },
    ],
    fonts: { primary: "SpaceMono Nerd Font", fallbacks: [], symbols: SYMBOLS_FONT },
    windowsTerminalGuid: "d24f86b3-5a17-4c09-8e3d-b19c7a42e615",
  },
  {
    id: "agnosterplus-future",
    basedOn: ["agnosterplus", "craver"],
    palette: [
      { name: "background", hex: "#07172C" },
      { name: "electric-blue", hex: "#5EC2FF" },
      { name: "turquoise", hex: "#7DF8D5" },
      { name: "text", hex: "#C4E9FF" },
    ],
    fonts: {
      primary: "RobotoMono Nerd Font",
      fallbacks: ["Terminess Nerd Font"],
      symbols: SYMBOLS_FONT,
    },
    windowsTerminalGuid: "3a96c0e8-1f74-4b2d-96a5-c8d3e7014b92",
  },
];

export function findThemeProfile(id: string): ThemeProfile | undefined {
  return THEME_PROFILES.find((profile) => profile.id === id);
}
