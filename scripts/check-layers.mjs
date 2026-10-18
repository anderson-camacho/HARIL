// Layer and dependency checker for the HARIL monorepo (ADR-0015, rules R1-R10 and the layer matrix).
// Usage: node scripts/check-layers.mjs   (exits 1 on any violation)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContext,
  discoverWorkspaces,
  isEntryPoint,
  listSourceFiles,
  relPosix,
  reportAndExit,
  resolveSpecifier,
  scanSource,
} from "./lib/scan.mjs";

const CONTRACTS = "packages/contracts";
const CORE = "packages/core";
const BRIDGE = "integrations/agent-pi-bridge";
// The HARIL console is a Pi extension bundled into one file like the bridge: node:* builtins and its own files only.
// Unlike the bridge it runs the haril CLI, so child_process is allowed; it never imports another workspace.
const CONSOLE = "integrations/pi-console";
const OS = "integrations/os";
const GATEWAY = "integrations/gateway";
const PI_WORKSPACES = new Set(["integrations/agent-pi", BRIDGE]);
// R1 exception (TUI-D1, ARCHITECTURE 6.3): the terminal UI library is imported only by apps/shell.
const SHELL = "apps/shell";
const PI_TUI = "@earendil-works/pi-tui";
const VARIANT_SEGMENT = /(^|\/)(win32|posix)(\/|$)/;

// Core folder layers (ADR-0015 / ARCHITECTURE 6.3). An edge is allowed only to a strictly lower
// layer or to the same folder; supervisor, executor and orchestrator share layer 3.
const CORE_LAYERS = {
  kernel: 0,
  ports: 1,
  agents: 2,
  blocks: 2,
  budget: 2,
  memory: 2,
  methodologies: 2,
  policy: 2,
  projects: 2,
  router: 2,
  taxis: 2,
  telemetry: 2,
  domain: 2,
  supervisor: 3,
  executor: 3,
  orchestrator: 3,
};

/**
 * @param {string} rootDir repository root
 * @returns {{ rule: string, file: string, line: number | null, message: string }[]}
 */
export function checkLayers(rootDir) {
  const workspaces = discoverWorkspaces(rootDir);
  const ctx = buildContext(rootDir, workspaces);
  const violations = [];
  let modules = 0;
  let edges = 0;

  for (const ws of workspaces) {
    if (ws.kind === undefined) {
      violations.push(guard(ws.rel, `workspace ${ws.rel} has no layer assignment`));
    }
  }

  const unknownCoreFolders = new Set();
  for (const ws of workspaces) {
    if (ws.kind === undefined) continue;
    for (const file of listSourceFiles(join(ws.dir, "src"))) {
      modules++;
      const fileRel = relPosix(rootDir, file);
      if (ws.kind === "core") {
        const folder = coreFolderOf(fileRel);
        if (folder && CORE_LAYERS[folder] === undefined) unknownCoreFolders.add(folder);
      }
      const source = readFileSync(file, "utf8");
      for (const edge of scanSource(source).edges) {
        edges++;
        if (edge.specifier === null) continue;
        violations.push(...checkEdge(ctx, ws, file, edge));
      }
    }
  }

  for (const folder of unknownCoreFolders) {
    violations.push(
      guard(`${CORE}/src/${folder}`, `core folder "${folder}" has no layer assignment`),
    );
  }
  if (modules === 0) violations.push(guard(".", "no modules scanned"));
  if (edges === 0) violations.push(guard(".", "no import edges scanned"));

  violations.push(...checkWorkspaceCycles(ctx));

  return violations.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule),
  );
}

function guard(file, message) {
  return { rule: "GUARD", file, line: null, message };
}

function coreFolderOf(rel) {
  const prefix = `${CORE}/src/`;
  if (!rel.startsWith(prefix)) return undefined;
  const parts = rel.slice(prefix.length).split("/");
  return parts.length > 1 ? parts[0] : null;
}

function checkEdge(ctx, ws, fileAbs, edge) {
  const file = relPosix(ctx.rootDir, fileAbs);
  const out = [];
  const report = (rule, message) => out.push({ rule, file, line: edge.line, message });
  const spec = edge.specifier;

  if (isPiTui(spec)) {
    if (ws.rel !== SHELL) report("R1", `"${spec}" may only be imported by apps/shell`);
  } else if (spec.startsWith("@earendil-works/") && !PI_WORKSPACES.has(ws.rel)) {
    report("R1", `"${spec}" may only be imported by agent-pi and agent-pi-bridge`);
  }

  const target = resolveSpecifier(spec, fileAbs, ctx);
  const targetRel = target.abs ? relPosix(ctx.rootDir, target.abs) : null;

  if (ws.rel !== OS && (VARIANT_SEGMENT.test(spec) || VARIANT_SEGMENT.test(targetRel ?? ""))) {
    report("R8", `"${spec}" is a win32/posix variant; only integrations/os may import it`);
  }

  if (target.kind === "builtin") {
    if (ws.kind === "contracts" || ws.kind === "core") {
      report("R4", `${ws.rel} must not import Node builtin "${spec}"`);
    }
    if (ws.rel === BRIDGE && baseName(target.name) === "child_process") {
      report("R6", `agent-pi-bridge must not import "${spec}"`);
    }
    return out;
  }

  if (ws.rel === CONSOLE && target.kind !== "internal") {
    report("R6", `pi-console may only import node:* builtins, not "${spec}"`);
    return out;
  }

  if (target.kind === "external") {
    if (ws.kind === "core") {
      report("MATRIX", `core may not depend on external package "${spec}"`);
    }
    if (ws.rel === "apps/bootstrap") {
      report("MATRIX", `apps/bootstrap may only import node:* builtins, not "${spec}"`);
    }
    return out;
  }

  if (target.kind === "unknown") {
    report("MATRIX", `"${spec}" does not match any workspace`);
    return out;
  }

  const tws = target.ws;
  if (!tws) {
    report("MATRIX", `"${spec}" resolves outside every workspace`);
    return out;
  }

  if (
    ws.rel === GATEWAY &&
    fileRelStartsWith(file, `${GATEWAY}/src/broker/`) &&
    targetRel.startsWith(`${GATEWAY}/src/providers/`)
  ) {
    report("R9", "gateway broker must not import gateway providers");
  }

  if (tws !== ws && target.reachesSrc) {
    report("R2", `"${spec}" imports another workspace's src/; use its package exports`);
  }

  if (tws !== ws) {
    if (ws.rel === CONSOLE) {
      report("R6", `pi-console must not import another workspace (${tws.rel})`);
    } else if (ws.rel === BRIDGE && tws.rel === CORE) {
      report("R6", "agent-pi-bridge must not import @haril/core");
    } else {
      const message = matrixMessage(ws, tws, edge.typeOnly, spec);
      if (message) report("MATRIX", message);
    }
  }

  if (ws.kind === "core" && tws.rel === CORE) {
    const srcFolder = coreFolderOf(file);
    const dstFolder = coreFolderOf(targetRel);
    if (srcFolder && CORE_LAYERS[srcFolder] !== undefined && dstFolder !== undefined) {
      if (dstFolder === null) {
        report("R10", `core/${srcFolder} must not import the core root facade`);
      } else if (
        dstFolder !== srcFolder &&
        CORE_LAYERS[dstFolder] !== undefined &&
        CORE_LAYERS[dstFolder] >= CORE_LAYERS[srcFolder]
      ) {
        report(
          "R10",
          `core/${srcFolder} (layer ${CORE_LAYERS[srcFolder]}) must not import core/${dstFolder} (layer ${CORE_LAYERS[dstFolder]})`,
        );
      }
    }
  }

  return out;
}

function matrixMessage(ws, tws, typeOnly, spec) {
  if (tws.kind === undefined) return `"${spec}" targets a workspace with no layer assignment`;
  if (ws.kind === "contracts") return `contracts may not import ${tws.rel}`;
  if (ws.kind === "core") {
    return tws.rel === CONTRACTS ? null : `core may only import contracts, not ${tws.rel}`;
  }
  if (ws.kind === "integration") {
    if (tws.rel === CONTRACTS) return null;
    if (tws.rel === CORE) {
      if (ws.rel === BRIDGE || typeOnly) return null;
      return `integrations may only type-import @haril/core, "${spec}" is a value import`;
    }
    return `integrations may not import ${tws.rel}`;
  }
  if (ws.kind === "app") {
    if (ws.rel === "apps/bootstrap") return `apps/bootstrap may not import ${tws.rel}`;
    return tws.kind === "app" ? `apps may not import other apps (${tws.rel})` : null;
  }
  return null;
}

function isPiTui(spec) {
  return spec === PI_TUI || spec.startsWith(`${PI_TUI}/`);
}

function fileRelStartsWith(file, prefix) {
  return file.startsWith(prefix);
}

function baseName(name) {
  return name.split("/")[0];
}

function checkWorkspaceCycles(ctx) {
  const byName = new Map(
    ctx.workspaces.filter((ws) => ws.kind !== undefined).map((ws) => [ws.name, ws]),
  );
  const graph = new Map();
  for (const ws of byName.values()) {
    const deps = { ...ws.pkg.dependencies, ...ws.pkg.devDependencies };
    const edges = Object.entries(deps)
      .filter(
        ([dep, range]) =>
          typeof range === "string" && range.startsWith("workspace:") && byName.has(dep),
      )
      .map(([dep]) => dep);
    graph.set(ws.name, edges);
  }

  const violations = [];
  for (const cycle of findCycles(graph)) {
    const ws = byName.get(cycle[0]);
    violations.push({
      rule: "R3",
      file: `${ws.rel}/package.json`,
      line: null,
      message: `workspace dependency cycle: ${cycle.join(" -> ")}`,
    });
  }
  return violations;
}

function findCycles(graph) {
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    state.set(node, "active");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === "active") {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const node of graph.keys()) {
    if (!state.has(node)) visit(node);
  }
  return cycles;
}

if (isEntryPoint(import.meta.url)) {
  const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
  reportAndExit("check-layers", checkLayers(REPO_ROOT));
}
