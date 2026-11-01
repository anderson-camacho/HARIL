import type { DelegationSettings, FactoryModel } from "@haril/contracts";
import { roleVendorWarnings } from "@haril/core";
import type { Store } from "@haril/core/ports";

// The pieces behind the console as the store knows them (feature haril-factory, F6). No call goes out to paint a map: the
// runtime is its lease, the gateway its last quota reading and the store that it answered.

type FactorySystem = FactoryModel["system"];

function gatewayOf(quota: FactoryModel["quota"]): FactorySystem["gateway"] {
  const unread = quota.unread[0]?.state ?? firstLost(quota);
  if (unread !== undefined) return { state: "down", detail: unread };
  const read = quota.accounts.filter((account) => account.readAt !== null).length;
  return read > 0
    ? { state: "ok", detail: `Responde: ${read} cuentas leídas.` }
    : { state: "unknown", detail: "Todavía no se ha leído: pulsa r en Modelos." };
}

// A provider that stopped answering keeps its accounts, each with the reason.
function firstLost(quota: FactoryModel["quota"]): string | undefined {
  for (const account of quota.accounts) {
    for (const group of account.groups) {
      const { state } = group.window5h;
      if (group.window5h.stale && state !== null) return state;
    }
  }
  return undefined;
}

export function buildFactorySystem(
  store: Pick<Store, "runtime" | "info">,
  now: number,
  quota: FactoryModel["quota"],
  settings: DelegationSettings,
): FactorySystem {
  const lease = store.runtime.leaseSummary();
  const alive = lease.status === "active" && lease.expiresAt > now;
  const connected = quota.accounts.flatMap((account) =>
    account.groups.flatMap((group) =>
      group.models.map((model) => `${account.provider}/${account.label}/${model}`),
    ),
  );
  return {
    runtime: alive
      ? { state: "ok", detail: "En marcha." }
      : { state: "down", detail: "Sin runtime en marcha: `haril start` lo arranca." },
    gateway: gatewayOf(quota),
    store: { state: "ok", detail: `esquema ${store.info().schemaVersion}` },
    accounts: quota.accounts.filter((account) => account.readAt !== null).length,
    roleWarnings: roleVendorWarnings(settings.roles, connected).map(({ role, vendor }) => ({
      role,
      vendor,
    })),
  };
}
