import type { StoreInspection } from "@haril/state-sqlite";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import {
  type CliIo,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_WARN,
  type HostInfo,
} from "../context.js";
import { storeAccess } from "../host.js";
import {
  KEY_REJECTED,
  listProviderModels,
  loadProviderConfig,
  PROBE_TIMEOUT_MS,
  type ProviderListing,
} from "../providers.js";
import { readRuntime, runtimeRootFor } from "../runtime.js";
import { VERSION } from "../version.js";
import { dataDirFor } from "./common.js";

// `haril doctor` (M1-D2): read-only. A 24.x below the supported range is a warning (the kept deviation, MC-D6); any
// other version outside the range is an error, as the store gate refuses it (INV-19).

const NODE_REQUIREMENT = "^24.21.0 || >=26.8.0";

type Version = readonly [number, number, number];
type Status = "ok" | "warn" | "error";
type NodeStatus = Status;

const RANK: Record<Status, number> = { ok: 0, warn: 1, error: 2 };

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// Equivalent to "^24.21.0 || >=26.8.0": the 24.x line from 24.21.0, or anything from 26.8.0 on.
function satisfiesRequirement(version: Version): boolean {
  const onLine24 = version[0] === 24 && compareVersions(version, [24, 21, 0]) >= 0;
  return onLine24 || compareVersions(version, [26, 8, 0]) >= 0;
}

// Outside the range is a hard error (exit 2), except a 24.x below 24.21.0, which is only a warning.
function nodeStatus(nodeVersion: string): NodeStatus {
  const version = parseVersion(nodeVersion);
  if (version === null) return "error";
  if (satisfiesRequirement(version)) return "ok";
  return version[0] === 24 ? "warn" : "error";
}

function worst(...statuses: Status[]): Status {
  return statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "ok" as Status);
}

// Gate statuses from the store share the Node vocabulary: ok, warn, error.
function storeStatus(report: StoreInspection): Status {
  const gates = report.gates.map((gate) => gate.status);
  if (report.error !== undefined || gates.includes("error")) return "error";
  return gates.includes("warn") ? "warn" : "ok";
}

// Providers of the section: error when a key is rejected, ok when one answered, warn otherwise (M3-T7).
function providersStatus(loaded: boolean, listings: readonly ProviderListing[]): Status {
  if (!loaded) return "error";
  if (listings.some((listing) => listing.detail === KEY_REJECTED)) return "error";
  return listings.some((listing) => listing.status === "ok") ? "ok" : "warn";
}

function providerRowStatus(listing: Pick<ProviderListing, "status" | "detail">): Status {
  if (listing.status === "ok") return "ok";
  return listing.detail === KEY_REJECTED ? "error" : "warn";
}

// Doctor is read-only: it describes the store and the providers and never creates the directory or the database.
export async function doctor(args: readonly string[], io: CliIo, host: HostInfo): Promise<number> {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err("usage: haril doctor [--json] [--data-dir <path>]");
    return EXIT_USAGE;
  }
  const json = parsed.flags.has("--json");
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = storeAccess(host).inspect(dataDir);

  const node = nodeStatus(host.nodeVersion);
  const loaded = loadProviderConfig(host);
  const timeoutMs = host.gatewayTimeoutMs ?? PROBE_TIMEOUT_MS;
  const listings: readonly ProviderListing[] = !loaded.ok
    ? []
    : await (
        host.providerProbe ??
        ((entries) => Promise.all(entries.map((entry) => listProviderModels(entry, timeoutMs))))
      )(loaded.providers);
  const providers = providersStatus(loaded.ok, listings);
  // The runtime is reported but does not change the exit code: it is installed by the user, not by M1 flows.
  const runtime = (host.inspectRuntime ?? readRuntime)(runtimeRootFor(host), host.platform);
  const overall = worst(node, storeStatus(store), providers);
  const configLine = loaded.ok
    ? `${loaded.source === "file" ? "file" : "defaults"}  ${loaded.path}`
    : `${loaded.path}`;
  if (json) {
    io.out(
      JSON.stringify({
        status: overall,
        node: { version: host.nodeVersion, required: NODE_REQUIREMENT, status: node },
        platform: host.platform,
        arch: host.arch,
        store: {
          status: storeStatus(store),
          dataDir: store.dataDir,
          dbPath: store.dbPath,
          initialized: store.initialized,
          sqliteVersion: store.sqliteVersion,
          schemaVersion: store.schemaVersion,
          gates: store.gates,
          ...(store.error === undefined ? {} : { error: store.error }),
        },
        providers: {
          status: providers,
          config: loaded.ok ? { source: loaded.source, path: loaded.path } : { path: loaded.path },
          ...(loaded.ok ? {} : { errors: loaded.errors }),
          entries: listings.map(({ models, ...listing }) => ({
            ...listing,
            status: providerRowStatus(listing),
            models: models.length,
          })),
        },
        runtime,
      }),
    );
  } else {
    io.out(`haril ${VERSION} doctor`);
    io.out(`  node      ${host.nodeVersion}  ${node}  requires ${NODE_REQUIREMENT}`);
    io.out(`  platform  ${host.platform}`);
    io.out(`  arch      ${host.arch}`);
    io.out(`  store     ${storeStatus(store)}  ${store.dataDir}`);
    io.out(`    database  ${storeDatabaseLine(store)}`);
    io.out(`    sqlite    ${store.sqliteVersion}`);
    for (const gate of store.gates) io.out(`    gate ${gate.name}  ${gate.status}  ${gate.detail}`);
    if (store.error !== undefined) io.out(`    error     ${store.error}`);
    io.out(`  providers  ${providers}  ${configLine}`);
    if (!loaded.ok) for (const error of loaded.errors) io.out(`    error     ${error}`);
    for (const listing of listings) {
      io.out(
        `    ${listing.id}  ${providerRowStatus(listing)}  ${listing.url}  key ${listing.key}  ${listing.detail}`,
      );
    }
    io.out(`  runtime   ${runtime.status}  ${runtime.root}`);
    io.out(`    detail    ${runtime.detail}`);
    if (runtime.node !== undefined)
      io.out(`    node      ${runtime.node.version}  ${runtime.node.path}`);
    if (runtime.pi !== undefined)
      io.out(`    pi        ${runtime.pi.version}  ${runtime.pi.cliPath}`);
    io.out(`  status    ${overall}`);
  }
  if (overall === "error") return EXIT_ERROR;
  return overall === "warn" ? EXIT_WARN : EXIT_OK;
}

function storeDatabaseLine(store: StoreInspection): string {
  if (!store.initialized)
    return `${store.dbPath} (not initialized; the first write command creates it)`;
  return `${store.dbPath} (schema ${store.schemaVersion ?? "unknown"})`;
}
