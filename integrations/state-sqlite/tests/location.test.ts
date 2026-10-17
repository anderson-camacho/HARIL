import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type StoreError } from "../src/index.js";
import { checkDataLocation } from "../src/location.js";
import { fixedClock, makeTempDir, removeTempDir, sequentialIds, testRules } from "./support.js";

// INV-13 and ST-01: a data root on OneDrive, on a UNC share or in a WSL file system is refused before anything
// is created on disk. The OneDrive variables are injected, so the tests do not depend on the host.
let dir = "";

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => {
  removeTempDir(dir);
});

function openAt(dataDir: string, env?: Readonly<Record<string, string | undefined>>) {
  return openStore({
    dataDir,
    clock: fixedClock(),
    ids: sequentialIds(),
    rules: testRules,
    env,
  });
}

function caught(action: () => unknown): StoreError {
  try {
    action();
  } catch (error) {
    return error as StoreError;
  }
  throw new Error("expected the operation to throw");
}

describe("checkDataLocation [INV-13]", () => {
  const none: Record<string, string | undefined> = {};

  it.each([
    ["a UNC share", "\\\\server\\share\\haril\\data"],
    ["an extended UNC path", "\\\\?\\UNC\\server\\share\\haril"],
    ["a WSL file system (\\\\wsl$)", "\\\\wsl$\\Ubuntu\\home\\haril\\data"],
    ["a WSL file system (\\\\wsl.localhost)", "\\\\wsl.localhost\\Ubuntu\\home\\haril"],
    ["a WSL path written with forward slashes", "//wsl$/Ubuntu/home/haril"],
  ])("[INV-13] refuses %s", (_label, path) => {
    const gate = checkDataLocation(path, none);
    expect(gate.name).toBe("location");
    expect(gate.status).toBe("error");
    expect(gate.detail).toMatch(/Remedy:/);
  });

  it.each([
    ["OneDrive", { OneDrive: "C:\\Users\\ana\\OneDrive" }],
    ["OneDriveCommercial", { OneDriveCommercial: "C:\\Users\\ana\\OneDrive - Contoso" }],
    ["OneDriveConsumer", { OneDriveConsumer: "C:\\Users\\ana\\OneDrive" }],
  ])("[INV-13] refuses a root inside the %s folder, whatever the letter case", (_label, env) => {
    const root = Object.values(env)[0] ?? "";
    const gate = checkDataLocation(`${root.toLowerCase()}\\HARIL\\data`, env);
    expect(gate.status).toBe("error");
    expect(gate.detail).toMatch(/OneDrive/);
  });

  it("[INV-13] accepts a local root and a folder whose name only starts like OneDrive", () => {
    const env = { OneDrive: "C:\\Users\\ana\\OneDrive" };
    expect(checkDataLocation("C:\\Users\\ana\\AppData\\Local\\HARIL\\data", env).status).toBe("ok");
    expect(checkDataLocation("C:\\Users\\ana\\OneDriveBackup\\data", env).status).toBe("ok");
    expect(checkDataLocation("C:\\Users\\ana\\OneDrive2\\data", env).status).toBe("ok");
  });

  it("[INV-13] accepts the extended local form and a POSIX root", () => {
    expect(checkDataLocation("\\\\?\\C:\\haril\\data", none).status).toBe("ok");
    expect(checkDataLocation("/home/ana/.local/share/haril/data", none).status).toBe("ok");
  });
});

describe("openStore location gate [INV-13]", () => {
  it("[INV-13] refuses a data root under OneDrive before any file is created", () => {
    const oneDrive = join(dir, "OneDrive");
    const target = join(oneDrive, "haril", "data");
    const error = caught(() => openAt(target, { OneDrive: oneDrive }));
    expect(error.code).toBe("store.gate_failed");
    expect(error.details).toMatchObject({ gate: "location" });
    expect(error.message).toMatch(/Remedy:/);
    expect(existsSync(oneDrive)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("[INV-13] refuses a UNC data root with a location error and no local directory", () => {
    const error = caught(() => openAt("\\\\server\\share\\haril\\data", {}));
    expect(error.code).toBe("store.gate_failed");
    expect(error.details).toMatchObject({ gate: "location" });
    expect(error.message).toMatch(/UNC/);
  });

  it("[INV-13] refuses a \\\\wsl$ data root with a location error", () => {
    const error = caught(() => openAt("\\\\wsl$\\Ubuntu\\home\\haril\\data", {}));
    expect(error.code).toBe("store.gate_failed");
    expect(error.details).toMatchObject({ gate: "location" });
    expect(error.message).toMatch(/WSL/);
  });

  it("[INV-13] opens a local data root and reports the location gate as ok", () => {
    const target = join(dir, "data");
    const store = openAt(target, { OneDrive: join(dir, "OneDrive") });
    expect(existsSync(join(target, "haril.db"))).toBe(true);
    expect(store.info().gates.find((gate) => gate.name === "location")?.status).toBe("ok");
    store.close();
  });
});
