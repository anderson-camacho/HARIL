import { win32 } from "node:path";
import type { FsPort } from "./ports.js";
import { sha256Hex } from "./shasums.js";
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
  readonly name: "launcher" | "shader" | "profile";
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

function fragmentContents(launcher: string, shaderPath: string | null): string {
  const profile = {
    guid: TERMINAL_PROFILE_GUID,
    name: "HARIL",
    commandline: `"${launcher}"`,
    startingDirectory: "%USERPROFILE%",
    tabTitle: "HARIL",
    ...(shaderPath === null ? {} : { "experimental.pixelShaderPath": shaderPath }),
  };
  return `${JSON.stringify({ profiles: [profile] }, null, 2)}\n`;
}

export async function installTerminalProfile(
  deps: TerminalProfileDeps,
  shader: TerminalShaderName | null,
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

  try {
    const status = await writeIfChanged(
      deps.fs,
      fragmentPath,
      fragmentContents(launcher, shaderPath),
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
  const bytes = encoder.encode(text);
  if ((await fs.exists(path)) && sha256Hex(await fs.readBytes(path)) === sha256Hex(bytes)) {
    return "skipped";
  }
  await fs.writeFile(path, bytes);
  return "ok";
}
