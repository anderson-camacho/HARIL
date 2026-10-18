import { existsSync, readFileSync } from "node:fs";
import type { HostInfo } from "./context.js";
import {
  type DelegationSettings,
  delegationSectionErrors,
  delegationSettingsOf,
} from "./delegation-section.js";
import { harilConfigPath, type ProviderEntry } from "./providers.js";

// The delegation settings of this run (docs/modos-y-delegacion.md 5): haril.json's `delegation` section, read again at
// each call like the providers, or section 5's defaults without a file or a section. A problem with the file is an error
// for the whole command, with each JSON path.

export type DelegationLoad =
  | { readonly ok: true; readonly path: string; readonly settings: DelegationSettings }
  | { readonly ok: false; readonly path: string; readonly errors: string[] };

export function loadDelegationSettings(host: HostInfo): DelegationLoad {
  const { path, explicit } = harilConfigPath(host);
  if (!existsSync(path)) {
    return explicit
      ? { ok: false, path, errors: ["the file named by HARIL_CONFIG does not exist"] }
      : { ok: true, path, settings: delegationSettingsOf(undefined) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return { ok: false, path, errors: ["the file is not valid JSON"] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, path, errors: ["/: must be a JSON object"] };
  }
  const section = (parsed as Record<string, unknown>).delegation;
  if (section === undefined) return { ok: true, path, settings: delegationSettingsOf(undefined) };
  const errors = delegationSectionErrors(section);
  return errors.length > 0
    ? { ok: false, path, errors }
    : { ok: true, path, settings: delegationSettingsOf(section) };
}

// The provider the CLIProxyAPI management API stands behind, and the server's origin: the provider whose baseUrl has the
// origin of managementBaseUrl, or, without one, the cliproxy provider and its own origin. Undefined when none matches:
// then no provider has a quota source ("sin dato").
export function quotaSourceOf(
  settings: DelegationSettings,
  providers: readonly ProviderEntry[],
): { readonly providerId: string; readonly baseUrl: string } | undefined {
  const origin = (url: string): string | undefined => {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  };
  const configured = settings.quota.managementBaseUrl;
  if (configured !== null) {
    const wanted = origin(configured);
    const owner = providers.find((entry) => origin(entry.baseUrl) === wanted);
    return owner === undefined || wanted === undefined
      ? undefined
      : { providerId: owner.id, baseUrl: configured };
  }
  const cliproxy = providers.find((entry) => entry.id === "cliproxy");
  const base = cliproxy === undefined ? undefined : origin(cliproxy.baseUrl);
  return cliproxy === undefined || base === undefined
    ? undefined
    : { providerId: cliproxy.id, baseUrl: base };
}
