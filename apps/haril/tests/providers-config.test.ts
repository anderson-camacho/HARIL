import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSecretRef, validateHarilConfig } from "@haril/contracts";
import { FakeSecretStore } from "@haril/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostInfo } from "../src/context.js";
import { loadProviderConfig } from "../src/providers.js";

// haril.json (M3-T7): defaults, the HARIL_CONFIG override, and the validation rules. No network here.
const FAKE_ENV_VALUE = "fake-env-value";
const FAKE_STORE_VALUE = "fake-store-value";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function hostWith(env: Record<string, string | undefined>): HostInfo {
  return {
    nodeVersion: "v24.21.0",
    platform: "linux",
    arch: "x64",
    homeDir: root,
    env: { HARIL_HOME: join(root, "data"), ...env },
  };
}

function writeConfig(text: string): string {
  const path = join(root, "haril.json");
  writeFileSync(path, text);
  return path;
}

describe("provider defaults (no haril.json)", () => {
  it("uses only the cliproxy default, with no key read", () => {
    const loaded = loadProviderConfig(hostWith({}));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.source).toBe("defaults");
    expect(loaded.providers.map((p) => [p.id, p.baseUrl, p.keyEnv])).toEqual([
      ["cliproxy", "http://127.0.0.1:8317/v1", "HARIL_CLIPROXYAPI_KEY"],
    ]);
  });

  it("lets HARIL_GATEWAY_URL override only the cliproxy URL of the defaults", () => {
    const loaded = loadProviderConfig(hostWith({ HARIL_GATEWAY_URL: "http://127.0.0.1:9999/v1" }));
    expect(loaded.ok && loaded.providers.map((p) => p.baseUrl)).toEqual([
      "http://127.0.0.1:9999/v1",
    ]);
  });

  it("reads the cliproxy key from its environment variable, sealed", () => {
    const loaded = loadProviderConfig(hostWith({ HARIL_CLIPROXYAPI_KEY: "k-123" }));
    expect(loaded.ok && loaded.providers.map((p) => p.credential?.reveal())).toEqual(["k-123"]);
    expect(JSON.stringify(loaded)).not.toContain("k-123");
  });

  it("reads the key by reference through the SecretStore it is given, never from the environment directly", () => {
    const host = hostWith({ HARIL_CLIPROXYAPI_KEY: FAKE_ENV_VALUE });
    const fromStore = loadProviderConfig(
      host,
      new FakeSecretStore({ [envSecretRef("HARIL_CLIPROXYAPI_KEY")]: FAKE_STORE_VALUE }),
    );
    expect(fromStore.ok && fromStore.providers[0]?.credential?.reveal()).toBe(FAKE_STORE_VALUE);
    const empty = loadProviderConfig(host, new FakeSecretStore());
    expect(empty.ok && empty.providers[0]?.credential).toBeUndefined();
  });
});

describe("haril.json", () => {
  it("is read from HARIL_CONFIG and its keyEnv names the variable that holds the key", () => {
    const path = writeConfig(
      JSON.stringify({
        providers: [
          { id: "lan", baseUrl: "http://192.168.1.20:8000/v1", keyEnv: "HARIL_LAN_KEY" },
          { id: "local", baseUrl: "http://127.0.0.1:1234/v1" },
        ],
      }),
    );
    const loaded = loadProviderConfig(
      hostWith({ HARIL_CONFIG: path, HARIL_LAN_KEY: "lan-secret" }),
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.source).toBe("file");
    expect(loaded.providers.map((p) => [p.id, p.credential?.reveal()])).toEqual([
      ["lan", "lan-secret"],
      ["local", undefined],
    ]);
  });

  it("leaves a keyEnv unset as an unset key, not an error", () => {
    const path = writeConfig(
      JSON.stringify({
        providers: [{ id: "lan", baseUrl: "http://127.0.0.1:8000/v1", keyEnv: "HARIL_LAN_KEY" }],
      }),
    );
    const loaded = loadProviderConfig(hostWith({ HARIL_CONFIG: path }));
    expect(loaded.ok && loaded.providers[0]?.credential).toBeUndefined();
  });

  it("refuses a literal apiKey field and names keyEnv as the way to give a key", () => {
    const path = writeConfig(
      JSON.stringify({
        providers: [{ id: "lan", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "sk-live-x" }],
      }),
    );
    const loaded = loadProviderConfig(hostWith({ HARIL_CONFIG: path }));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.errors.join("\n")).toContain("keys are never stored in haril.json; use keyEnv");
    expect(loaded.errors.join("\n")).not.toContain("sk-live-x");
  });

  it("refuses a non-http URL, a bad id and an empty provider list", () => {
    expect(
      validateHarilConfig({ providers: [{ id: "lan", baseUrl: "file:///etc/passwd" }] }).ok,
    ).toBe(false);
    expect(
      validateHarilConfig({ providers: [{ id: "Bad Id", baseUrl: "http://127.0.0.1:1/v1" }] }).ok,
    ).toBe(false);
    expect(validateHarilConfig({ providers: [] }).ok).toBe(false);
  });

  it("refuses a repeated provider id", () => {
    const result = validateHarilConfig({
      providers: [
        { id: "lan", baseUrl: "http://127.0.0.1:1/v1" },
        { id: "lan", baseUrl: "http://127.0.0.1:2/v1" },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a keyEnv that is not an environment variable name", () => {
    const result = validateHarilConfig({
      providers: [{ id: "lan", baseUrl: "http://127.0.0.1:1/v1", keyEnv: "sk-live-literal" }],
    });
    expect(result.ok).toBe(false);
  });

  it("reports an unreadable file as not ok, with the path", () => {
    const path = writeConfig("{ not json");
    const loaded = loadProviderConfig(hostWith({ HARIL_CONFIG: path }));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.path).toBe(path);
    expect(loaded.errors.join("\n")).toContain("not valid JSON");
  });

  it("ships config/haril.example.json with an opt-in OpenRouter entry that is not a default", () => {
    const example = JSON.parse(
      readFileSync(new URL("../../../config/haril.example.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(validateHarilConfig(example).ok).toBe(true);
    const providers = (example as { providers: { id: string; baseUrl: string; keyEnv?: string }[] })
      .providers;
    expect(providers).toContainEqual({ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    expect(providers.find((p) => p.id === "openrouter")?.keyEnv).toBeUndefined();
  });
});

// The ui object (TUI-D14): the shell stores ui.theme here. A file without providers means the built-in defaults.
describe("haril.json ui object (TUI-D14)", () => {
  it("accepts both configured locales without changing provider selection", () => {
    for (const locale of ["es", "en"]) {
      const path = writeConfig(JSON.stringify({ ui: { locale } }));
      const loaded = loadProviderConfig(hostWith({ HARIL_CONFIG: path }));
      expect(loaded.ok && loaded.source).toBe("defaults");
    }
  });

  it("rejects an unsupported locale with its config path", () => {
    for (const locale of ["fr", "EN", "", null, 1]) {
      const path = writeConfig(JSON.stringify({ ui: { locale } }));
      const loaded = loadProviderConfig(hostWith({ HARIL_CONFIG: path }));
      expect(loaded.ok).toBe(false);
      expect(!loaded.ok && loaded.errors.join("\n")).toContain("/ui/locale");
    }
  });

  it("accepts ui.theme next to providers", () => {
    const path = writeConfig(
      JSON.stringify({
        ui: { theme: "haril-light" },
        providers: [{ id: "lan", baseUrl: "http://127.0.0.1:8000/v1" }],
      }),
    );
    const loaded = loadProviderConfig(hostWith({ HARIL_CONFIG: path }));
    expect(loaded.ok && loaded.source).toBe("file");
    expect(loaded.ok && loaded.providers.map((p) => p.id)).toEqual(["lan"]);
  });

  it("a file with only ui gives the same built-in defaults as no file", () => {
    const withoutFile = loadProviderConfig(hostWith({}));
    const path = writeConfig(JSON.stringify({ ui: { theme: "haril-dark" } }));
    const loaded = loadProviderConfig(hostWith({ HARIL_CONFIG: path }));
    expect(loaded).toEqual({ ...withoutFile, path });
    expect(loaded.ok && loaded.source).toBe("defaults");
  });

  it("an empty object gives the built-in defaults too", () => {
    const path = writeConfig("{}");
    const loaded = loadProviderConfig(hostWith({ HARIL_CONFIG: path }));
    expect(loaded.ok && loaded.providers.map((p) => p.id)).toEqual(["cliproxy"]);
  });

  it("still refuses an unknown top-level key and a literal apiKey", () => {
    const unknown = loadProviderConfig(
      hostWith({
        HARIL_CONFIG: writeConfig(
          JSON.stringify({
            providers: [{ id: "lan", baseUrl: "http://127.0.0.1:8000/v1" }],
            bogus: 1,
          }),
        ),
      }),
    );
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.errors.join("\n")).toContain("/bogus");
    const apiKey = loadProviderConfig(
      hostWith({ HARIL_CONFIG: writeConfig(JSON.stringify({ apiKey: "sk-x", ui: {} })) }),
    );
    expect(apiKey.ok).toBe(false);
    expect(!apiKey.ok && apiKey.errors.join("\n")).toContain("keys are never stored in haril.json");
  });

  it("refuses an invalid ui.theme, an unknown ui key and a ui that is not an object", () => {
    for (const ui of [{ theme: "../evil" }, { theme: "" }, { theme: 3 }, { colour: "x" }, "dark"]) {
      const loaded = loadProviderConfig(
        hostWith({ HARIL_CONFIG: writeConfig(JSON.stringify({ ui })) }),
      );
      expect(loaded.ok, JSON.stringify(ui)).toBe(false);
    }
    const loaded = loadProviderConfig(
      hostWith({ HARIL_CONFIG: writeConfig(JSON.stringify({ ui: { theme: "a b" } })) }),
    );
    expect(!loaded.ok && loaded.errors.join("\n")).toContain("/ui/theme");
  });
});
