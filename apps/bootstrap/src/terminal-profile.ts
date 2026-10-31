import { win32 } from "node:path";
import type { FsPort } from "./ports.js";
import { sha256Hex } from "./shasums.js";
import { terminalBackgroundPng } from "./terminal-background.js";
import {
  TERMINAL_SHADER_NAMES,
  type TerminalShaderName,
  terminalShaderSource,
} from "./terminal-shader.js";
import { messageOf } from "./text.js";

// Optional Windows Terminal profile (`haril-bootstrap terminal-profile`). It is written as a JSON fragment under
// %LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\HARIL, so installing never edits the user's settings.json.
// Windows Terminal itself adds a reference entry to settings.json the first time it loads the fragment, and keeps it
// after the fragment is gone: the orphan still shows a "HARIL" profile that opens cmd.exe (verified on Windows
// Terminal 1.24). Removal therefore drops that one entry too. The profile runs <root>\bin\haril.cmd, and the
// optional pixel shader is written to <root>\terminal\. Windows only.

// Fixed so that reinstalling updates the same profile instead of adding a second one.
export const TERMINAL_PROFILE_GUID = "{5ecd8f72-4341-4503-86a6-238cea39b3f7}";
const FRAGMENT_APP = "HARIL";
const FRAGMENT_FILE = "haril.json";

const encoder = new TextEncoder();

export interface TerminalProfileDeps {
  readonly root: string;
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly fs: FsPort;
}

interface TerminalProfileStep {
  readonly name: "launcher" | "shader" | "background" | "profile";
  readonly status: "ok" | "skipped" | "failed";
  readonly detail: string;
}

export interface TerminalProfileResult {
  readonly ok: boolean;
  readonly fragmentPath: string | null;
  readonly shaderPath: string | null;
  readonly steps: readonly TerminalProfileStep[];
}

export interface TerminalProfileRemoval {
  readonly ok: boolean;
  readonly removed: readonly string[];
  // settings.json files that still name the profile and must be edited by hand.
  readonly manual: readonly string[];
  readonly detail: string;
}

function localAppData(deps: Pick<TerminalProfileDeps, "env" | "homeDir">): string {
  const value = deps.env.LOCALAPPDATA;
  return value === undefined || value === "" ? win32.join(deps.homeDir, "AppData", "Local") : value;
}

function fragmentDir(deps: Pick<TerminalProfileDeps, "env" | "homeDir">): string {
  return win32.join(localAppData(deps), "Microsoft", "Windows Terminal", "Fragments", FRAGMENT_APP);
}

// Stable, Preview and unpackaged installs of Windows Terminal.
function settingsFiles(deps: Pick<TerminalProfileDeps, "env" | "homeDir">): string[] {
  const local = localAppData(deps);
  return [
    ...[
      "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
      "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe",
    ].map((pkg) => win32.join(local, "Packages", pkg, "LocalState", "settings.json")),
    win32.join(local, "Microsoft", "Windows Terminal", "settings.json"),
  ];
}

function shaderFile(root: string, name: TerminalShaderName): string {
  return win32.join(root, "terminal", `haril-${name}.hlsl`);
}

// The Future palette as a Windows Terminal scheme, delivered in the fragment beside the profile: nothing of it reaches
// the user's settings.json or any other profile.
const SCHEME_NAME = "HARIL Future";
const FUTURE_SCHEME = {
  name: SCHEME_NAME,
  background: "#07172C",
  foreground: "#C4E9FF",
  cursorColor: "#5EC2FF",
  selectionBackground: "#16365C",
  black: "#07172C",
  red: "#FF6576",
  green: "#7DF8D5",
  yellow: "#F4D35E",
  blue: "#5EC2FF",
  purple: "#9DCDEC",
  cyan: "#7DF8D5",
  white: "#C4E9FF",
  brightBlack: "#56789C",
  brightRed: "#FF6576",
  brightGreen: "#A8E6CF",
  brightYellow: "#FF9F45",
  brightBlue: "#9DCDEC",
  brightPurple: "#C4E9FF",
  brightCyan: "#C8FFF0",
  brightWhite: "#FFFFFF",
};

// Font files name a family without its spaces. The first family found on this machine wins; none leaves the font alone.
const NERD_FONTS = [
  ["jetbrainsmononerdfont", "JetBrainsMono Nerd Font"],
  ["caskaydiacovenerdfont", "CaskaydiaCove Nerd Font"],
  ["caskaydiamononerdfont", "CaskaydiaMono Nerd Font"],
  ["firacodenerdfont", "FiraCode Nerd Font"],
  ["mesloLGSnerdfont".toLowerCase(), "MesloLGS Nerd Font"],
  ["hacknerdfont", "Hack Nerd Font"],
] as const;

async function installedNerdFont(
  deps: Pick<TerminalProfileDeps, "env" | "homeDir" | "fs">,
): Promise<string | undefined> {
  const folders = [
    win32.join(localAppData(deps), "Microsoft", "Windows", "Fonts"),
    win32.join(deps.env.SystemRoot ?? "C:\\Windows", "Fonts"),
  ];
  const files: string[] = [];
  for (const folder of folders) {
    try {
      for (const file of await deps.fs.readDir(folder)) files.push(file.name.toLowerCase());
    } catch {
      // A folder that cannot be read only means no font is chosen from it.
    }
  }
  return NERD_FONTS.find(([stem]) => files.some((file) => file.startsWith(stem)))?.[1];
}

// The picture behind HARIL's profile, and only that profile. Windows Terminal draws it behind cells that keep the default
// background, which is why the Future palette leaves those cells unpainted. "default" is the image this code draws
// (terminal-background.ts), written beside the shaders; a path is the user's own, used where it is.
export const BACKGROUND_STRETCH_MODES = ["none", "fill", "uniform", "uniformToFill"] as const;
const BACKGROUND_FILE = "haril-background.png";
const BACKGROUND_EXTENSIONS = /\.(png|jpe?g|gif)$/i;
export interface TerminalBackground {
  readonly image: "default" | "none" | string;
  readonly opacity: number;
  readonly stretch: (typeof BACKGROUND_STRETCH_MODES)[number];
}
export const DEFAULT_BACKGROUND: TerminalBackground = {
  image: "default",
  opacity: 0.35,
  stretch: "uniformToFill",
};

// Why a user's path cannot be the background, or undefined when it can.
export async function backgroundProblem(fs: FsPort, path: string): Promise<string | undefined> {
  if (!win32.isAbsolute(path)) return `${path} is not an absolute path`;
  if (!BACKGROUND_EXTENSIONS.test(path)) return `${path} is not a png, jpg or gif`;
  return (await fs.exists(path)) ? undefined : `${path} does not exist`;
}

function backgroundFile(root: string): string {
  return win32.join(root, "terminal", BACKGROUND_FILE);
}

function fragmentContents(
  launcher: string,
  shaderPath: string | null,
  font: string | undefined,
  background: { readonly path: string; readonly settings: TerminalBackground } | null,
): string {
  const profile = {
    guid: TERMINAL_PROFILE_GUID,
    name: "HARIL",
    commandline: `"${launcher}"`,
    startingDirectory: "%USERPROFILE%",
    tabTitle: "HARIL",
    colorScheme: SCHEME_NAME,
    cursorShape: "filledBox",
    ...(font === undefined ? {} : { font: { face: font } }),
    ...(background === null
      ? {}
      : {
          backgroundImage: background.path,
          backgroundImageOpacity: background.settings.opacity,
          backgroundImageStretchMode: background.settings.stretch,
        }),
    ...(shaderPath === null ? {} : { "experimental.pixelShaderPath": shaderPath }),
  };
  return `${JSON.stringify({ profiles: [profile], schemes: [FUTURE_SCHEME] }, null, 2)}\n`;
}

export async function installTerminalProfile(
  deps: TerminalProfileDeps,
  shader: TerminalShaderName | null,
  background: TerminalBackground = DEFAULT_BACKGROUND,
): Promise<TerminalProfileResult> {
  if (deps.platform !== "win32") {
    return {
      ok: false,
      fragmentPath: null,
      shaderPath: null,
      steps: [
        { name: "profile", status: "failed", detail: "Windows Terminal profiles are Windows only" },
      ],
    };
  }

  const launcher = win32.join(deps.root, "bin", "haril.cmd");
  const fragmentPath = win32.join(fragmentDir(deps), FRAGMENT_FILE);
  const shaderPath = shader === null ? null : shaderFile(deps.root, shader);
  const steps: TerminalProfileStep[] = [];
  const result = (): TerminalProfileResult => ({
    ok: steps.every((step) => step.status !== "failed"),
    fragmentPath,
    shaderPath,
    steps,
  });

  if (!(await deps.fs.exists(launcher))) {
    steps.push({
      name: "launcher",
      status: "failed",
      detail: `${launcher} is missing: run haril-bootstrap install first`,
    });
    return result();
  }
  steps.push({ name: "launcher", status: "ok", detail: launcher });

  try {
    if (shader === null) {
      // Switching to no shader also removes the files a previous run wrote.
      for (const name of TERMINAL_SHADER_NAMES) await deps.fs.remove(shaderFile(deps.root, name));
      steps.push({ name: "shader", status: "skipped", detail: "no shader" });
    } else {
      const path = shaderFile(deps.root, shader);
      const status = await writeIfChanged(deps.fs, path, terminalShaderSource(shader));
      steps.push({ name: "shader", status, detail: path });
    }
  } catch (error) {
    steps.push({ name: "shader", status: "failed", detail: messageOf(error) });
    return result();
  }

  let picture: { readonly path: string; readonly settings: TerminalBackground } | null = null;
  try {
    const generated = backgroundFile(deps.root);
    if (background.image === "default") {
      const status = await writeBytesIfChanged(deps.fs, generated, terminalBackgroundPng());
      steps.push({ name: "background", status, detail: generated });
      picture = { path: generated, settings: background };
    } else {
      if (await deps.fs.exists(generated)) await deps.fs.remove(generated);
      if (background.image === "none") {
        steps.push({ name: "background", status: "skipped", detail: "no background image" });
      } else {
        steps.push({ name: "background", status: "ok", detail: background.image });
        picture = { path: background.image, settings: background };
      }
    }
  } catch (error) {
    steps.push({ name: "background", status: "failed", detail: messageOf(error) });
    return result();
  }

  try {
    const status = await writeIfChanged(
      deps.fs,
      fragmentPath,
      fragmentContents(launcher, shaderPath, await installedNerdFont(deps), picture),
    );
    steps.push({ name: "profile", status, detail: fragmentPath });
  } catch (error) {
    steps.push({ name: "profile", status: "failed", detail: messageOf(error) });
  }
  return result();
}

// Removes the fragment, the shader files and the reference entry Windows Terminal added for the profile, nothing else.
export async function removeTerminalProfile(
  deps: TerminalProfileDeps,
): Promise<TerminalProfileRemoval> {
  if (deps.platform !== "win32") {
    return {
      ok: false,
      removed: [],
      manual: [],
      detail: "Windows Terminal profiles are Windows only",
    };
  }
  const dir = fragmentDir(deps);
  const candidates = [
    win32.join(dir, FRAGMENT_FILE),
    ...TERMINAL_SHADER_NAMES.map((name) => shaderFile(deps.root, name)),
    backgroundFile(deps.root),
  ];
  const removed: string[] = [];
  const manual: string[] = [];
  try {
    for (const path of candidates) {
      if (await deps.fs.exists(path)) {
        await deps.fs.remove(path);
        removed.push(path);
      }
    }
    for (const parent of [dir, win32.join(deps.root, "terminal")]) {
      if ((await deps.fs.exists(parent)) && (await deps.fs.readDir(parent)).length === 0) {
        await deps.fs.remove(parent);
      }
    }
    for (const path of settingsFiles(deps)) {
      const outcome = await dropSettingsReference(deps.fs, path);
      if (outcome === "removed") removed.push(`${path} (HARIL entry)`);
      else if (outcome === "manual") manual.push(path);
    }
  } catch (error) {
    return { ok: false, removed, manual, detail: messageOf(error) };
  }
  return {
    ok: true,
    removed,
    manual,
    detail:
      removed.length === 0
        ? "nothing to remove"
        : `removed ${removed.length} ${removed.length === 1 ? "entry" : "entries"}`,
  };
}

// Drops the profile entry whose guid and source are HARIL's. The file is rewritten only when it parses as plain JSON
// (Windows Terminal accepts comments, JSON.parse does not) and the profile is not the default one; otherwise it is left
// untouched and reported for a manual edit. The original text is kept beside it as settings.json.haril-backup.
async function dropSettingsReference(
  fs: FsPort,
  path: string,
): Promise<"removed" | "absent" | "manual"> {
  if (!(await fs.exists(path))) return "absent";
  const text = await fs.readText(path);
  if (!text.includes(TERMINAL_PROFILE_GUID)) return "absent";
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return "manual";
  }
  if (!isRecord(settings) || settings.defaultProfile === TERMINAL_PROFILE_GUID) return "manual";
  const profiles = settings.profiles;
  const holder = isRecord(profiles) ? profiles : settings;
  const key = isRecord(profiles) ? "list" : "profiles";
  const list = holder[key];
  if (!Array.isArray(list)) return "manual";
  const kept = list.filter(
    (entry) =>
      !(isRecord(entry) && entry.guid === TERMINAL_PROFILE_GUID && entry.source === FRAGMENT_APP),
  );
  if (kept.length === list.length) return "manual";
  holder[key] = kept;
  await fs.writeFile(`${path}.haril-backup`, text);
  const temporary = `${path}.haril-tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 4)}\n`);
  await fs.rename(temporary, path);
  return "removed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeIfChanged(fs: FsPort, path: string, text: string): Promise<"ok" | "skipped"> {
  return writeBytesIfChanged(fs, path, encoder.encode(text));
}

async function writeBytesIfChanged(
  fs: FsPort,
  path: string,
  bytes: Uint8Array,
): Promise<"ok" | "skipped"> {
  if ((await fs.exists(path)) && sha256Hex(await fs.readBytes(path)) === sha256Hex(bytes)) {
    return "skipped";
  }
  await fs.writeFile(path, bytes);
  return "ok";
}
