import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { storeAccess } from "../host.js";
import { dataDirFor, openExisting, sha256 } from "./common.js";

// `haril project init|list` (M1-T3). init previews by default; --yes applies (M1-D9).

const METHODOLOGIES = ["odd", "tdd", "custom"] as const;
type Methodology = (typeof METHODOLOGIES)[number];

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INIT_USAGE =
  "usage: haril project init [path] --name <name> [--slug <slug>] [--methodology odd|tdd|custom] [--yes] [--json] [--data-dir <path>]";

export function project(args: readonly string[], io: CliIo, host: HostInfo): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "init") return projectInit(rest, io, host);
  if (subcommand === "list") return projectList(rest, io, host);
  if (subcommand === undefined) io.err("haril: project needs a subcommand");
  else io.err(`haril: unknown project subcommand "${subcommand}"`);
  io.err("usage: haril project init|list");
  return EXIT_USAGE;
}

function isMethodology(value: string): value is Methodology {
  return (METHODOLOGIES as readonly string[]).includes(value);
}

// Lowercase words joined with dashes; the result still has to pass SLUG_PATTERN.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

// The manifest is declarative and carries no machine-specific paths (PROJECTS.md 3.2).
function manifestText(name: string, slug: string, methodology: Methodology): string {
  const manifest = {
    schemaVersion: 1,
    name,
    slug,
    methodology,
    security: {
      minLevel: "N0",
      shell: "deny",
      allowedPaths: ["."],
      dataClass: "internal",
      optIn: [],
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

interface InitPlan {
  readonly projectId: string;
  readonly name: string;
  readonly slug: string;
  readonly methodology: Methodology;
  readonly rootPath: string;
  readonly dataDir: string;
  readonly manifestPath: string;
  readonly manifestText: string;
  readonly manifestSha256: string;
  // "create" writes the manifest, "keep" finds it identical, "conflict" finds other content (refused).
  readonly manifestState: "create" | "keep" | "conflict";
}

function projectInit(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: ["--name", "--slug", "--methodology", "--data-dir"],
    flags: ["--yes", "--json"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [pathArg, ...extra] = parsed.positionals;
  if (extra.length > 0) {
    io.err(INIT_USAGE);
    return EXIT_USAGE;
  }

  const name = lastValue(parsed, "--name")?.trim() ?? "";
  if (name === "") {
    io.err("haril: project init needs --name <name>");
    return EXIT_USAGE;
  }
  const slug = lastValue(parsed, "--slug") ?? slugify(name);
  if (!SLUG_PATTERN.test(slug)) {
    io.err(`haril: slug "${slug}" must be lowercase letters, digits and dashes (at most 63)`);
    return EXIT_USAGE;
  }
  const methodology = lastValue(parsed, "--methodology") ?? "odd";
  if (!isMethodology(methodology)) {
    io.err(`haril: unknown methodology "${methodology}"; use odd, tdd or custom`);
    return EXIT_USAGE;
  }
  const rootPath = resolve(host.cwd ?? process.cwd(), pathArg ?? ".");
  if (!isDirectory(rootPath)) {
    io.err(`haril: project root is not a directory: ${rootPath}`);
    return EXIT_USAGE;
  }

  const plan = buildPlan(host, {
    name,
    slug,
    methodology,
    rootPath,
    dataDirFlag: lastValue(parsed, "--data-dir"),
  });
  const json = parsed.flags.has("--json");
  if (!parsed.flags.has("--yes")) {
    printPreview(io, json, plan);
    return EXIT_OK;
  }
  return applyInit(io, host, plan, json);
}

function buildPlan(
  host: HostInfo,
  input: {
    readonly name: string;
    readonly slug: string;
    readonly methodology: Methodology;
    readonly rootPath: string;
    readonly dataDirFlag: string | undefined;
  },
): InitPlan {
  const text = manifestText(input.name, input.slug, input.methodology);
  const manifestPath = join(input.rootPath, ".haril", "project.json");
  const manifestState = manifestStateOf(manifestPath, text);
  return {
    projectId: storeAccess(host).ids.next(),
    name: input.name,
    slug: input.slug,
    methodology: input.methodology,
    rootPath: input.rootPath,
    dataDir: dataDirFor(host, input.dataDirFlag),
    manifestPath,
    manifestText: text,
    manifestSha256: sha256(text),
    manifestState,
  };
}

function manifestStateOf(path: string, text: string): InitPlan["manifestState"] {
  if (!existsSync(path)) return "create";
  return readFileSync(path, "utf8") === text ? "keep" : "conflict";
}

// The preview does not assign the project id: it is generated when --yes applies (no id is promised here).
function printPreview(io: CliIo, json: boolean, plan: InitPlan): void {
  const projectDir = join(plan.dataDir, "projects", "<project id>");
  if (json) {
    io.out(
      JSON.stringify({
        applied: false,
        projectId: null,
        slug: plan.slug,
        name: plan.name,
        methodology: plan.methodology,
        rootPath: plan.rootPath,
        dataDir: plan.dataDir,
        manifestSha256: plan.manifestSha256,
        files: [
          { path: plan.manifestPath, action: plan.manifestState, sha256: plan.manifestSha256 },
          { path: projectDir, action: "create-directory" },
        ],
      }),
    );
    return;
  }
  io.out("haril project init (preview)");
  io.out("  project id   assigned when applied");
  io.out(`  name         ${plan.name}`);
  io.out(`  slug         ${plan.slug}`);
  io.out(`  methodology  ${plan.methodology}`);
  io.out(`  root         ${plan.rootPath}`);
  io.out("  files");
  io.out(`    ${plan.manifestState.padEnd(8)} ${plan.manifestPath}  sha256 ${plan.manifestSha256}`);
  io.out(`    create-dir ${projectDir}`);
  if (plan.manifestState === "conflict") {
    io.out(
      "  .haril/project.json exists with other content; --yes will refuse and not overwrite it.",
    );
  }
  io.out("Nothing applied. Re-run with --yes to apply.");
}

// Order (PROJECTS.md 2): refuse conflicts first, write the manifest, create the data directory, then
// register. The registration is the commit point; a re-run with identical content completes it.
function applyInit(io: CliIo, host: HostInfo, plan: InitPlan, json: boolean): number {
  if (plan.manifestState === "conflict") {
    io.err(
      `haril: ${plan.manifestPath} already exists with different content and was not overwritten; review it or remove it, then run again`,
    );
    return EXIT_USAGE;
  }

  const store = storeAccess(host).open(plan.dataDir);
  try {
    const existing = store.projects.getByRootPath(plan.rootPath);
    let projectId = plan.projectId;
    if (existing !== undefined) {
      if (existing.slug !== plan.slug) {
        io.err(`haril: ${plan.rootPath} is already registered as "${existing.slug}"`);
        return EXIT_USAGE;
      }
      projectId = existing.projectId;
    } else if (store.projects.getBySlug(plan.slug) !== undefined) {
      io.err(`haril: slug "${plan.slug}" is already registered for another root`);
      return EXIT_USAGE;
    }

    if (plan.manifestState === "create") writeNew(plan.manifestPath, plan.manifestText);
    mkdirSync(join(plan.dataDir, "projects", projectId), { recursive: true });
    if (existing === undefined) {
      store.projects.register({
        projectId,
        slug: plan.slug,
        name: plan.name,
        rootPath: plan.rootPath,
        manifestSha256: plan.manifestSha256,
        manifestJson: plan.manifestText,
      });
    }

    const idempotent = existing !== undefined;
    if (json) {
      io.out(
        JSON.stringify({
          applied: true,
          idempotent,
          projectId,
          slug: plan.slug,
          name: plan.name,
          rootPath: plan.rootPath,
          dataDir: plan.dataDir,
          manifestSha256: plan.manifestSha256,
        }),
      );
    } else {
      io.out(
        idempotent
          ? `project ${plan.slug} was already registered (no changes)`
          : `project ${plan.slug} initialized at ${plan.rootPath}`,
      );
      io.out(`  project id  ${projectId}`);
      io.out(`  manifest    ${plan.manifestPath}`);
    }
    return EXIT_OK;
  } finally {
    store.close();
  }
}

function projectList(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err("usage: haril project list [--json] [--data-dir <path>]");
    return EXIT_USAGE;
  }
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = openExisting(host, dataDir);
  try {
    const projects = store?.projects.list() ?? [];
    if (parsed.flags.has("--json")) {
      io.out(JSON.stringify({ initialized: store !== undefined, projects }));
    } else if (store === undefined) {
      io.out(
        "haril project list: not initialized (run haril project init <path> --name <name> --yes)",
      );
    } else if (projects.length === 0) {
      io.out("no projects registered");
    } else {
      for (const item of projects)
        io.out(`${item.slug}  ${item.name}  ${item.rootPath}  ${item.projectId}`);
    }
    return EXIT_OK;
  } finally {
    store?.close();
  }
}

// Writes through a temporary file and a rename, so a crash never leaves a half-written manifest.
function writeNew(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
