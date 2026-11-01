// The level of the git role's action (feature haril-factory, F7). Everything here is a closed list: per subcommand, the
// options it may carry, by their exact spelling. git accepts unique prefixes of a long option ("--outp" for "--output"),
// so a list of refused options loses to its parser; here an unknown spelling is refused whatever it would have meant.
// A person answers every publish and destructive action; a forbidden one never runs, and no action moves a protected
// branch. The same function judges the action when it is asked for and again when a grant runs it. Pure: no I/O.

export const GIT_LEVELS = ["free", "local", "publish", "destructive"] as const;
export type GitLevel = (typeof GIT_LEVELS)[number];

export type GitClassification =
  | { readonly level: GitLevel }
  | { readonly level: "forbidden"; readonly why: string };

const PROTECTED_BRANCHES = new Set(["main", "master"]);

export function isProtectedBranch(name: string): boolean {
  const short = name
    .replace(/^\+/, "")
    .replace(/^refs\//i, "")
    .replace(/^heads\//i, "")
    .toLowerCase();
  return PROTECTED_BRANCHES.has(short);
}

interface OptionSpec {
  // Long options with no value.
  readonly flags?: readonly string[];
  // Long options that take their value as --name=value or as the next argument.
  readonly values?: readonly string[];
  // Long options whose value, if any, comes only as --name=value.
  readonly optional?: readonly string[];
  // Short options with no value; they combine ("-fu").
  readonly short?: string;
  // Short options whose value is the rest of the argument or the next one.
  readonly shortValues?: string;
  // "-5", as `git log` takes it.
  readonly numeric?: boolean;
}

interface Parsed {
  readonly seen: ReadonlySet<string>;
  readonly valueOf: (...names: readonly string[]) => string | undefined;
  readonly positional: readonly string[];
  // What comes after a bare "--".
  readonly paths: readonly string[];
}

type ParseResult =
  | { readonly ok: true; readonly parsed: Parsed }
  | { readonly ok: false; readonly option: string };

// A value taken from the next argument never starts with "-": git could read that argument as an option of its own.
function parseOptions(args: readonly string[], spec: OptionSpec): ParseResult {
  const seen = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  const paths: string[] = [];
  const shortFlags = spec.short ?? "";
  const shortValues = spec.shortValues ?? "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--") {
      paths.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const takeNext = (name: string): boolean => {
      const next = args[index + 1];
      if (next === undefined) return true;
      if (next.startsWith("-")) return false;
      values.set(name, next);
      index += 1;
      return true;
    };
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      const name = equal === -1 ? arg : arg.slice(0, equal);
      const value = equal === -1 ? undefined : arg.slice(equal + 1);
      if (spec.optional?.includes(name) === true) {
        if (value !== undefined) values.set(name, value);
      } else if (spec.values?.includes(name) === true) {
        if (value !== undefined) values.set(name, value);
        else if (!takeNext(name)) return { ok: false, option: arg };
      } else if (spec.flags?.includes(name) !== true || value !== undefined) {
        return { ok: false, option: arg };
      }
      seen.add(name);
      continue;
    }
    if (spec.numeric === true && /^-\d+$/.test(arg)) continue;
    for (let at = 1; at < arg.length; at += 1) {
      const letter = arg[at] as string;
      const name = `-${letter}`;
      if (shortFlags.includes(letter)) {
        seen.add(name);
        continue;
      }
      if (!shortValues.includes(letter)) return { ok: false, option: arg };
      seen.add(name);
      const rest = arg.slice(at + 1);
      if (rest !== "") values.set(name, rest);
      else if (!takeNext(name)) return { ok: false, option: arg };
      break;
    }
  }
  return {
    ok: true,
    parsed: {
      seen,
      valueOf: (...names) => {
        for (const name of names) {
          const value = values.get(name);
          if (value !== undefined) return value;
        }
        return undefined;
      },
      positional,
      paths,
    },
  };
}

function forbidden(why: string): GitClassification {
  return { level: "forbidden", why };
}

const FREE: GitClassification = { level: "free" };
const LOCAL: GitClassification = { level: "local" };
const DESTRUCTIVE: GitClassification = { level: "destructive" };

// An absolute path or a ".." segment names something outside the worktree ("git diff /etc/passwd x" reads it).
function leavesWorktree(argument: string): boolean {
  if (/^[\\/]/.test(argument) || /^[A-Za-z]:/.test(argument) || argument.includes("\\\\")) {
    return true;
  }
  return /(^|[\\/=:;,])\.\.($|[\\/=:;,])/.test(argument);
}

// A remote by its name: never a URL or a path, which would send or fetch somewhere nobody configured.
function isRemoteName(remote: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(remote);
}

function hasAny(parsed: Parsed, ...names: readonly string[]): boolean {
  return names.some((name) => parsed.seen.has(name));
}

const NOT_EXPLICIT = /[*?[\]\s\\~^]|\.\.|@\{/;

function classifyPush(parsed: Parsed): GitClassification {
  const [remote, refspec, ...extra] = parsed.positional;
  if (
    parsed.paths.length > 0 ||
    extra.length > 0 ||
    remote === undefined ||
    refspec === undefined
  ) {
    return forbidden("a push names exactly one remote and one branch or tag");
  }
  if (!isRemoteName(remote)) return forbidden(`${remote} is not the name of a remote`);
  const plus = refspec.startsWith("+");
  const body = plus ? refspec.slice(1) : refspec;
  const colon = body.indexOf(":");
  const source = colon === -1 ? body : body.slice(0, colon);
  const target = colon === -1 ? body : body.slice(colon + 1);
  if (target === "" || target.includes(":")) {
    return forbidden(`"${refspec}" does not name its target`);
  }
  if (NOT_EXPLICIT.test(source) || NOT_EXPLICIT.test(target)) {
    return forbidden(`"${refspec}" is not one explicit branch or tag`);
  }
  if (target === "HEAD" || target === "@") {
    return forbidden("a push names the branch it goes to; HEAD says only where it stands now");
  }
  if (isProtectedBranch(target))
    return forbidden("nothing is pushed to main or master by an agent");
  const removes = hasAny(parsed, "-d", "--delete") || (colon !== -1 && source === "");
  const forces = plus || hasAny(parsed, "-f", "--force", "--force-with-lease");
  return removes || forces ? DESTRUCTIVE : { level: "publish" };
}

// A fetch and a pull bring in named branches. A refspec with a target moves a local ref, which is not what either is
// free or local for.
function remoteProblem(parsed: Parsed, verb: string): string | null {
  const [remote, ...refs] = parsed.positional;
  if (remote !== undefined && !isRemoteName(remote)) {
    return `${remote} is not the name of a remote`;
  }
  const moved = refs.find(
    (ref) => ref.startsWith("+") || ref.includes(":") || NOT_EXPLICIT.test(ref),
  );
  return moved === undefined ? null : `git ${verb} takes branch names only, not "${moved}"`;
}

function classifyBranch(parsed: Parsed): GitClassification {
  const removes = hasAny(parsed, "-d", "-D", "--delete");
  const forces = hasAny(parsed, "-f", "--force", "-M", "-C");
  const renames = hasAny(parsed, "-m", "--move", "-c", "--copy");
  const lists = hasAny(parsed, "-l", "--list", "--show-current");
  const names = parsed.positional;
  if (!removes && !forces && !renames && (lists || names.length === 0)) {
    return parsed.valueOf("-u", "--set-upstream-to") === undefined ? FREE : LOCAL;
  }
  if (names.some(isProtectedBranch)) return forbidden("no agent moves main or master");
  return removes || forces ? DESTRUCTIVE : LOCAL;
}

function classifyTag(parsed: Parsed): GitClassification {
  if (hasAny(parsed, "-d", "--delete", "-f", "--force")) return DESTRUCTIVE;
  if (hasAny(parsed, "-l", "--list")) return FREE;
  const writes =
    parsed.positional.length > 0 || hasAny(parsed, "-a", "--annotate", "-m", "--message");
  return writes ? LOCAL : FREE;
}

function classifySwitch(parsed: Parsed): GitClassification {
  const created = parsed.valueOf("-c", "--create", "-C", "--force-create");
  if (created !== undefined && isProtectedBranch(created)) {
    return forbidden("no agent creates or resets main or master");
  }
  return hasAny(parsed, "-f", "--force", "--discard-changes", "-C", "--force-create")
    ? DESTRUCTIVE
    : LOCAL;
}

// "git checkout x" overwrites a file when x names one and no branch, and nothing here can tell: only creating a branch
// or detaching is local. `git switch` is the local way to change branch.
function classifyCheckout(parsed: Parsed): GitClassification {
  const created = parsed.valueOf("-b", "-B");
  if (created !== undefined && isProtectedBranch(created)) {
    return forbidden("no agent creates or resets main or master");
  }
  if (hasAny(parsed, "-f", "--force", "-B") || parsed.paths.length > 0) return DESTRUCTIVE;
  return parsed.seen.has("-b") || parsed.seen.has("--detach") ? LOCAL : DESTRUCTIVE;
}

function classifyRestore(parsed: Parsed): GitClassification {
  const stagedOnly = hasAny(parsed, "-S", "--staged") && !hasAny(parsed, "-W", "--worktree");
  return stagedOnly ? LOCAL : DESTRUCTIVE;
}

function classifyRm(parsed: Parsed): GitClassification {
  if (hasAny(parsed, "-f", "--force")) return DESTRUCTIVE;
  if (parsed.seen.has("--cached")) return LOCAL;
  const everything = [...parsed.positional, ...parsed.paths].some((path) =>
    /^(\.[\\/]?|\*|:[\\/])$/.test(path),
  );
  return everything ? DESTRUCTIVE : LOCAL;
}

function classifyStash(parsed: Parsed): GitClassification {
  const [action] = parsed.positional;
  if (action === undefined) return LOCAL;
  if (["push", "list", "show", "apply"].includes(action)) return LOCAL;
  // The stash is shared with every other worktree of the repository, the person's own among them.
  if (["pop", "drop", "clear"].includes(action)) return DESTRUCTIVE;
  return forbidden(`git stash ${action} is not on the git role's list`);
}

function classifyUpdateRef(parsed: Parsed): GitClassification {
  if (parsed.positional.length === 0) return forbidden("git update-ref names the ref it moves");
  return parsed.positional.some(isProtectedBranch)
    ? forbidden("no agent moves main or master")
    : DESTRUCTIVE;
}

interface GitRule {
  readonly options: OptionSpec;
  readonly classify: (parsed: Parsed) => GitClassification;
  // It moves the branch it stands on: never on a protected one.
  readonly movesHead?: boolean;
}

const DIFF_FLAGS = [
  "--stat",
  "--shortstat",
  "--numstat",
  "--summary",
  "--compact-summary",
  "--name-only",
  "--name-status",
  "--patch",
  "--no-patch",
  "--raw",
  "--minimal",
  "--patience",
  "--histogram",
  "--no-color",
  "--no-renames",
  "--ignore-all-space",
  "--ignore-space-change",
  "--ignore-space-at-eol",
  "--ignore-blank-lines",
  "--function-context",
  "--no-ext-diff",
  "--no-textconv",
  "--check",
  "--exit-code",
  "--quiet",
  "--full-index",
  "--no-prefix",
];
const DIFF_OPTIONAL = [
  "--stat",
  "--color",
  "--word-diff",
  "--abbrev",
  "--find-renames",
  "--unified",
];
const LOG_FLAGS = [
  ...DIFF_FLAGS,
  "--oneline",
  "--graph",
  "--no-decorate",
  "--all",
  "--no-merges",
  "--merges",
  "--first-parent",
  "--reverse",
  "--abbrev-commit",
  "--follow",
  "--topo-order",
  "--date-order",
  "--author-date-order",
  "--left-right",
  "--full-history",
];
const LOG: OptionSpec = {
  flags: LOG_FLAGS,
  values: [
    "--author",
    "--committer",
    "--grep",
    "--since",
    "--until",
    "--after",
    "--before",
    "--format",
    "--date",
    "--max-count",
    "--skip",
    "--diff-filter",
  ],
  optional: [...DIFF_OPTIONAL, "--decorate", "--pretty", "--branches", "--tags", "--remotes"],
  short: "pswbqzRiu",
  shortValues: "nLUSG",
  numeric: true,
};
const free = (options: OptionSpec): GitRule => ({ options, classify: () => FREE });

const GIT_RULES: Readonly<Record<string, GitRule>> = {
  status: free({
    flags: [
      "--short",
      "--branch",
      "--long",
      "--show-stash",
      "--ahead-behind",
      "--no-ahead-behind",
      "--renames",
      "--no-renames",
    ],
    optional: ["--porcelain", "--untracked-files", "--ignored"],
    short: "sbzu",
  }),
  log: free(LOG),
  show: free(LOG),
  diff: free({
    flags: [...DIFF_FLAGS, "--cached", "--staged", "--merge-base"],
    values: ["--diff-filter"],
    optional: DIFF_OPTIONAL,
    short: "pswbqzRu",
    shortValues: "USG",
  }),
  "rev-parse": free({
    flags: [
      "--verify",
      "--show-toplevel",
      "--git-dir",
      "--is-inside-work-tree",
      "--is-bare-repository",
      "--symbolic-full-name",
      "--show-prefix",
      "--show-cdup",
      "--quiet",
    ],
    optional: ["--short", "--abbrev-ref"],
    short: "q",
  }),
  "ls-files": free({
    flags: [
      "--cached",
      "--deleted",
      "--modified",
      "--others",
      "--exclude-standard",
      "--stage",
      "--unmerged",
      "--ignored",
      "--full-name",
      "--error-unmatch",
    ],
    short: "cdmosuiz",
  }),
  blame: free({
    flags: ["--porcelain", "--line-porcelain", "--show-email", "--root"],
    values: ["--date"],
    short: "swlept",
    shortValues: "L",
  }),
  describe: free({
    flags: ["--tags", "--always", "--long", "--exact-match", "--all", "--first-parent"],
    values: ["--match", "--exclude", "--candidates"],
    optional: ["--abbrev", "--dirty"],
  }),
  shortlog: free({
    flags: ["--summary", "--numbered", "--email", "--all", "--no-merges", "--merges"],
    values: ["--since", "--until", "--after", "--before", "--author", "--grep"],
    short: "sne",
  }),
  fetch: {
    options: {
      flags: [
        "--prune",
        "--tags",
        "--no-tags",
        "--all",
        "--quiet",
        "--verbose",
        "--dry-run",
        "--unshallow",
      ],
      values: ["--depth"],
      short: "ptqvn",
    },
    classify: (parsed) => {
      const problem = remoteProblem(parsed, "fetch");
      return problem === null ? FREE : forbidden(problem);
    },
  },
  push: {
    options: {
      flags: ["--set-upstream", "--force", "--delete", "--force-if-includes"],
      optional: ["--force-with-lease"],
      short: "ufd",
    },
    classify: classifyPush,
  },
  branch: {
    options: {
      flags: [
        "--list",
        "--all",
        "--remotes",
        "--show-current",
        "--verbose",
        "--no-color",
        "--force",
        "--move",
        "--copy",
        "--delete",
      ],
      values: [
        "--contains",
        "--no-contains",
        "--merged",
        "--no-merged",
        "--points-at",
        "--format",
        "--sort",
        "--set-upstream-to",
      ],
      short: "arvlfmMcCdD",
      shortValues: "u",
    },
    classify: classifyBranch,
  },
  tag: {
    options: {
      flags: ["--list", "--delete", "--force", "--annotate"],
      values: ["--message", "--sort", "--contains", "--points-at"],
      short: "ldfa",
      shortValues: "m",
    },
    classify: classifyTag,
  },
  add: {
    options: {
      flags: ["--all", "--update", "--verbose", "--dry-run", "--intent-to-add"],
      short: "AuvnN",
    },
    classify: () => LOCAL,
  },
  commit: {
    options: {
      flags: ["--all", "--amend", "--no-edit", "--allow-empty", "--signoff", "--quiet"],
      values: ["--message"],
      short: "asq",
      shortValues: "m",
    },
    classify: () => LOCAL,
    movesHead: true,
  },
  switch: {
    options: {
      flags: ["--force", "--discard-changes", "--detach", "--no-guess", "--quiet"],
      values: ["--create", "--force-create"],
      short: "fqd",
      shortValues: "cC",
    },
    classify: classifySwitch,
  },
  checkout: {
    options: { flags: ["--force", "--detach", "--quiet"], short: "fq", shortValues: "bB" },
    classify: classifyCheckout,
  },
  restore: {
    options: {
      flags: ["--staged", "--worktree", "--quiet"],
      values: ["--source"],
      short: "SWq",
      shortValues: "s",
    },
    classify: classifyRestore,
  },
  rm: {
    options: {
      flags: ["--cached", "--force", "--recursive", "--quiet", "--dry-run"],
      short: "frqn",
    },
    classify: classifyRm,
  },
  mv: {
    options: { flags: ["--force", "--verbose", "--dry-run"], short: "fkvn" },
    classify: (parsed) => (hasAny(parsed, "-f", "--force") ? DESTRUCTIVE : LOCAL),
  },
  stash: {
    options: {
      flags: ["--include-untracked", "--keep-index", "--quiet", "--stat", "--patch"],
      values: ["--message"],
      short: "ukqp",
      shortValues: "m",
    },
    classify: classifyStash,
  },
  reset: {
    options: { flags: ["--hard", "--soft", "--mixed", "--keep", "--merge", "--quiet"], short: "q" },
    classify: (parsed) => (hasAny(parsed, "--hard", "--keep", "--merge") ? DESTRUCTIVE : LOCAL),
    movesHead: true,
  },
  merge: {
    options: {
      flags: [
        "--no-ff",
        "--ff",
        "--ff-only",
        "--squash",
        "--no-commit",
        "--commit",
        "--abort",
        "--continue",
        "--no-edit",
        "--quiet",
      ],
      values: ["--message"],
      short: "q",
      shortValues: "m",
    },
    classify: () => LOCAL,
    movesHead: true,
  },
  revert: {
    options: {
      flags: ["--no-commit", "--no-edit", "--abort", "--continue", "--skip"],
      values: ["--mainline"],
      short: "n",
      shortValues: "m",
    },
    classify: () => LOCAL,
    movesHead: true,
  },
  "cherry-pick": {
    options: {
      flags: ["--no-commit", "--abort", "--continue", "--skip"],
      values: ["--mainline"],
      short: "nx",
      shortValues: "m",
    },
    classify: () => LOCAL,
    movesHead: true,
  },
  pull: {
    options: {
      flags: ["--ff-only", "--ff", "--no-ff", "--no-rebase", "--no-edit", "--quiet"],
      optional: ["--rebase"],
      short: "qr",
    },
    classify: (parsed) => {
      const problem = remoteProblem(parsed, "pull");
      return problem === null ? LOCAL : forbidden(problem);
    },
    movesHead: true,
  },
  clean: {
    options: { flags: ["--force", "--dry-run", "--quiet"], short: "fdxXnq" },
    classify: () => DESTRUCTIVE,
  },
  rebase: {
    options: {
      flags: ["--abort", "--continue", "--skip", "--quit", "--autostash", "--no-autostash"],
      values: ["--onto"],
    },
    classify: () => DESTRUCTIVE,
    movesHead: true,
  },
  "update-ref": {
    options: { short: "d", shortValues: "m" },
    classify: classifyUpdateRef,
    movesHead: true,
  },
  gc: {
    options: { flags: ["--aggressive", "--auto", "--quiet"], optional: ["--prune"] },
    classify: () => DESTRUCTIVE,
  },
  prune: {
    options: { flags: ["--dry-run", "--verbose"], values: ["--expire"], short: "nv" },
    classify: () => DESTRUCTIVE,
  },
};

function classifyGit(args: readonly string[], currentBranch: string | null): GitClassification {
  const [sub, ...rest] = args;
  if (sub === undefined || sub.startsWith("-")) {
    return forbidden("a git action starts with its subcommand; an option before it is refused");
  }
  const rule = Object.hasOwn(GIT_RULES, sub) ? GIT_RULES[sub] : undefined;
  if (rule === undefined) return forbidden(`git ${sub} is not on the git role's list`);
  const read = parseOptions(rest, rule.options);
  if (!read.ok) return forbidden(`git ${sub}: ${read.option} is not on the git role's list`);
  const outside = [...read.parsed.positional, ...read.parsed.paths].find(leavesWorktree);
  if (outside !== undefined) return forbidden(`git ${sub}: ${outside} is outside the worktree`);
  if (rule.movesHead === true && currentBranch !== null && isProtectedBranch(currentBranch)) {
    return forbidden(`nothing is merged or committed into ${currentBranch} by an agent`);
  }
  return rule.classify(read.parsed);
}

// gh reads of the current repository: never another one (--repo), never a browser (--web).
const GH_READ: OptionSpec = {
  flags: [
    "--comments",
    "--required",
    "--name-only",
    "--patch",
    "--log",
    "--log-failed",
    "--verbose",
    "--exit-status",
  ],
  values: [
    "--json",
    "--jq",
    "--template",
    "--limit",
    "--state",
    "--base",
    "--head",
    "--author",
    "--label",
    "--search",
    "--branch",
    "--workflow",
    "--status",
    "--event",
    "--job",
    "--attempt",
    "--color",
  ],
  short: "cv",
  shortValues: "qtLsBHAlSbwesja",
};
const FREE_GH: readonly (readonly [string, string])[] = [
  ["pr", "view"],
  ["pr", "list"],
  ["pr", "status"],
  ["pr", "checks"],
  ["pr", "diff"],
  ["run", "list"],
  ["run", "view"],
  ["release", "list"],
  ["release", "view"],
];
const PUBLISH_GH: readonly (readonly [string, string])[] = [
  ["pr", "create"],
  ["pr", "edit"],
  ["pr", "comment"],
  ["release", "create"],
];
const DESTRUCTIVE_GH: readonly (readonly [string, string])[] = [
  ["pr", "close"],
  ["release", "delete"],
  ["repo", "delete"],
];

function matchesGh(args: readonly string[], list: readonly (readonly [string, string])[]): boolean {
  return list.some(([group, action]) => args[0] === group && args[1] === action);
}

function classifyGh(args: readonly string[]): GitClassification {
  if (args[0] === "pr" && args[1] === "merge") {
    return forbidden("a pull request is merged by a person, never by an agent");
  }
  if (matchesGh(args, FREE_GH)) {
    const read = parseOptions(args.slice(2), GH_READ);
    return read.ok ? FREE : forbidden(`gh: ${read.option} is not on the git role's list`);
  }
  if (matchesGh(args, PUBLISH_GH)) return { level: "publish" };
  if (matchesGh(args, DESTRUCTIVE_GH)) return DESTRUCTIVE;
  return forbidden(`gh ${args.slice(0, 2).join(" ")} is not on the git role's list`);
}

// `currentBranch`: where the worktree stands now, when known. What the lists do not name is refused.
export function classifyGitCommand(
  program: "git" | "gh",
  args: readonly string[],
  currentBranch: string | null = null,
): GitClassification {
  return program === "git" ? classifyGit(args, currentBranch) : classifyGh(args);
}
