import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  type BlockCategory,
  type BlockManifest,
  type MethodologyPayload,
  validateBlockManifest,
  validateMethodologyPayload,
} from "@haril/contracts";
import { checkSectionMarkers, parseBlockFile } from "./block-file.js";

// Loads the native blocks from a directory of block.md files (ADR-0014 D3, D5). Data only: nothing in a
// block is executed or imported. Fail closed: one invalid block rejects the whole registry, with reasons.

const BLOCK_FILE = "block.md";
const MAX_BLOCK_BYTES = 256 * 1024;
const RESERVED_PREFIX = "haril.";
const FORBIDDEN_SCHEMA_KEYWORDS = ["$ref", "pattern", "patternProperties"];

export interface BlockEntry {
  readonly id: string;
  readonly version: string;
  readonly category: BlockCategory;
  // Path of block.md relative to the blocks directory, with "/" separators.
  readonly path: string;
  // SHA-256 of the exact bytes of block.md.
  readonly sha256: string;
  // First prose line of the body, for listings.
  readonly summary: string;
  readonly manifest: BlockManifest;
  readonly payload: MethodologyPayload | undefined;
}

export interface BlockRegistry {
  list(): BlockEntry[];
  get(id: string): BlockEntry | undefined;
}

export interface BlockRejection {
  readonly path: string;
  readonly reasons: string[];
}

export type BlockRegistryLoad =
  | { readonly ok: true; readonly registry: BlockRegistry }
  | { readonly ok: false; readonly rejected: BlockRejection[] };

export function loadBlockRegistry(dir: string): BlockRegistryLoad {
  let files: string[];
  try {
    files = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .map((entry) => entry.split(sep).join("/"))
      .filter((entry) => entry.split("/").pop() === BLOCK_FILE)
      .sort();
  } catch {
    return {
      ok: false,
      rejected: [{ path: dir, reasons: ["the blocks directory cannot be read"] }],
    };
  }

  const rejected: BlockRejection[] = [];
  const entries: BlockEntry[] = [];
  for (const path of files) {
    const outcome = readBlock(join(dir, path), path);
    if (outcome.ok) entries.push(outcome.entry);
    else rejected.push({ path, reasons: outcome.reasons });
  }

  const seen = new Map<string, number>();
  for (const entry of entries) seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1);
  for (const [id, count] of seen) {
    if (count > 1) {
      for (const entry of entries.filter((item) => item.id === id)) {
        rejected.push({ path: entry.path, reasons: [`id "${id}" is declared by ${count} blocks`] });
      }
    }
  }

  if (rejected.length > 0) {
    return { ok: false, rejected: rejected.sort((a, b) => a.path.localeCompare(b.path)) };
  }
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: true,
    registry: { list: () => [...sorted], get: (id) => sorted.find((item) => item.id === id) },
  };
}

type BlockOutcome =
  | { readonly ok: true; readonly entry: BlockEntry }
  | { readonly ok: false; readonly reasons: string[] };

function readBlock(fullPath: string, path: string): BlockOutcome {
  let bytes: Buffer;
  try {
    bytes = readFileSync(fullPath);
  } catch {
    return { ok: false, reasons: ["the block file cannot be read"] };
  }
  if (bytes.length > MAX_BLOCK_BYTES) {
    return { ok: false, reasons: [`the block file exceeds ${MAX_BLOCK_BYTES} bytes`] };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reasons: ["the block file is not valid UTF-8"] };
  }

  const parsed = parseBlockFile(text);
  if (!parsed.ok) return { ok: false, reasons: [parsed.error] };

  const manifest = validateBlockManifest(parsed.frontmatter);
  if (!manifest.ok) return { ok: false, reasons: manifest.errors };
  const block = manifest.value;

  const reasons: string[] = [];
  if (!block.id.startsWith(RESERVED_PREFIX)) {
    reasons.push(`id "${block.id}" must use the reserved "${RESERVED_PREFIX}" namespace`);
  }
  if (block.id.split(".")[1] !== block.category) {
    reasons.push(
      `id "${block.id}" must name the category "${block.category}" in its second segment`,
    );
  }
  for (const keyword of forbiddenSchemaKeywords(block.config.schema)) {
    reasons.push(`config.schema uses "${keyword}", which the restricted subset does not allow`);
  }

  const markers = checkSectionMarkers(parsed.body);
  const sectionIds = markers.ok ? markers.sectionIds : [];
  if (!markers.ok) reasons.push(...markers.errors);

  let payload: MethodologyPayload | undefined;
  if (block.category === "methodology") {
    const checked = validateMethodologyPayload(block.config.payload);
    if (!checked.ok) {
      reasons.push(...checked.errors.map((error) => `config.payload${error}`));
    } else {
      payload = checked.value;
      reasons.push(...methodologyRules(block, checked.value, sectionIds));
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    entry: {
      id: block.id,
      version: block.version,
      category: block.category,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      summary: summaryOf(parsed.body, block.id),
      manifest: block,
      payload,
    },
  };
}

// Cross-field rules of a methodology payload that the schema cannot express.
function methodologyRules(
  block: BlockManifest,
  payload: MethodologyPayload,
  sectionIds: readonly string[],
): string[] {
  const reasons: string[] = [];
  const dependencyIds = new Set(block.dependencies.map((dependency) => dependency.id));
  const roleIds = new Set<string>();
  for (const role of payload.roles) {
    if (roleIds.has(role.id)) reasons.push(`payload role "${role.id}" is declared twice`);
    roleIds.add(role.id);
    if (!dependencyIds.has(role.agent)) {
      reasons.push(
        `payload role "${role.id}" uses agent "${role.agent}", not declared in dependencies`,
      );
    }
  }
  const gateIds = new Set<string>();
  for (const gate of payload.gates) {
    if (gateIds.has(gate.id)) reasons.push(`payload gate "${gate.id}" is declared twice`);
    gateIds.add(gate.id);
    const referenced = [
      ...("role" in gate ? [gate.role] : []),
      ...("requiresRole" in gate ? [gate.requiresRole] : []),
      ...("roles" in gate ? (gate.roles ?? []) : []),
    ];
    for (const role of referenced) {
      if (!roleIds.has(role))
        reasons.push(`payload gate "${gate.id}" references unknown role "${role}"`);
    }
  }
  const sectionSeen = new Set<string>();
  for (const section of payload.sections) {
    if (sectionSeen.has(section.id))
      reasons.push(`payload section "${section.id}" is declared twice`);
    sectionSeen.add(section.id);
    if (!sectionIds.includes(section.id)) {
      reasons.push(`payload section "${section.id}" has no haril:section marker in the body`);
    }
    for (const role of section.roles) {
      if (!roleIds.has(role))
        reasons.push(`payload section "${section.id}" references unknown role "${role}"`);
    }
  }
  return reasons;
}

function forbiddenSchemaKeywords(schema: unknown, found: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const item of schema) forbiddenSchemaKeywords(item, found);
  } else if (typeof schema === "object" && schema !== null) {
    for (const [key, value] of Object.entries(schema)) {
      if (FORBIDDEN_SCHEMA_KEYWORDS.includes(key) && !found.includes(key)) found.push(key);
      forbiddenSchemaKeywords(value, found);
    }
  }
  return found;
}

// The first prose line of the body, outside markers; the id when the body has none.
function summaryOf(body: string, id: string): string {
  const line = body
    .split("\n")
    .map((raw) => raw.trim())
    .find((text) => text !== "" && !text.startsWith("<!--"));
  return line === undefined ? id : line.slice(0, 120);
}
