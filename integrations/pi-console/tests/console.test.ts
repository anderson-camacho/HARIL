import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import harilConsole from "../src/console.js";
import type { GitSummary } from "../src/git-summary.js";
import type { ConsoleComponent, ConsoleTheme, ConsoleTui } from "../src/pi-types.js";
import { stripAnsi } from "../src/text.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";
import { type FakeContext, type FakePi, fakeContext, fakePi } from "./fake-pi.js";

// The folder line of the bar in the running console: powerline segments with the git counts, which come from a
// background read the footer's render only asks for and never waits on.

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const THEME: ConsoleTheme = { fg: (_tone, text) => text, bold: (text) => text };
const ARROW = String.fromCodePoint(0xe0b0);
const BRANCH = String.fromCodePoint(0xe0a0);
const FOLDER = String.fromCodePoint(0xf07b);
const SOME: GitSummary = { staged: 1, modified: 2, untracked: 3 };

type FooterData = {
  getGitBranch(): string | null;
  getExtensionStatuses(): Map<string, string>;
  onBranchChange(listener: () => void): () => void;
};
type Footer = (tui: ConsoleTui, theme: ConsoleTheme, data: FooterData) => ConsoleComponent;

interface Reads {
  readonly cwds: string[];
  answer(value: GitSummary | undefined): void;
  fail(message: string): void;
}

let cli: FakeCli;
let fake: FakePi;
let ctx: FakeContext;
let footer: Footer | undefined;
let anchor: ((tui: ConsoleTui, theme: ConsoleTheme) => ConsoleComponent) | undefined;
let reads: Reads;
let renders: Mock<(force?: boolean) => void>;
let branchListeners: (() => void)[];
let branch: string | null;
let statuses: Map<string, string>;

function manualReads(): { reads: Reads; read: (cwd: string) => Promise<GitSummary | undefined> } {
  const cwds: string[] = [];
  const pending: { resolve: (v: GitSummary | undefined) => void; reject: (e: Error) => void }[] =
    [];
  return {
    reads: {
      cwds,
      answer: (value) => pending.shift()?.resolve(value),
      fail: (message) => pending.shift()?.reject(new Error(message)),
    },
    read: (cwd) => {
      cwds.push(cwd);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

async function start(): Promise<void> {
  cli = installFakeCli();
  fake = fakePi();
  ctx = fakeContext();
  footer = undefined;
  anchor = undefined;
  branch = "main";
  statuses = new Map();
  branchListeners = [];
  renders = vi.fn<(force?: boolean) => void>();
  const manual = manualReads();
  reads = manual.reads;
  Object.assign(ctx.ui, {
    setFooter(value: Footer) {
      footer = value;
    },
    setWidget(key: string, value: typeof anchor) {
      if (key === "haril-native-panes-anchor") anchor = value;
    },
  });
  harilConsole(fake.pi, { git: { read: manual.read } });
  await fake.fire("session_start", { reason: "startup" }, ctx);
}

function mount(tui: ConsoleTui = { terminal: { columns: 160, rows: 45 }, requestRender: renders }) {
  if (footer === undefined) throw new Error("Expected the console to install its footer");
  return footer(tui, THEME, {
    getGitBranch: () => branch,
    getExtensionStatuses: () => statuses,
    onBranchChange: (listener) => {
      branchListeners.push(listener);
      return () => {
        branchListeners = branchListeners.filter((item) => item !== listener);
      };
    },
  });
}

function folderLine(component: ConsoleComponent, width = 140): string {
  return stripAnsi(component.render(width)[1] ?? "");
}

beforeEach(async () => {
  // The terminal here is not attached to the dock, so the bar is the full one, with its folder line.
  vi.stubEnv("HARIL_POWERLINE", "");
  await start();
});

afterEach(async () => {
  await fake.fire("session_shutdown", {}, ctx);
  cli.restore();
  vi.unstubAllEnvs();
});

describe("the folder line in the console", () => {
  it("draws powerline segments by default, and the counts once git has answered", async () => {
    const component = mount();
    expect(folderLine(component)).toBe(` ${FOLDER} fake-cwd ${ARROW} ${BRANCH} main ${ARROW}`);
    // The render asked for the counts and went on without them: git has not even been started yet.
    expect(reads.cwds).toEqual([]);
    await settle();
    expect(reads.cwds).toEqual(["fake-cwd"]);
    expect(renders).not.toHaveBeenCalled();

    reads.answer(SOME);
    await settle();
    // The answer asks Pi to draw the footer again, and that draw has the counts.
    expect(renders).toHaveBeenCalledTimes(1);
    expect(folderLine(component)).toBe(
      ` ${FOLDER} fake-cwd ${ARROW} ${BRANCH} main +1 ~2 ?3 ${ARROW}`,
    );
  });

  it("keeps the extension statuses after the segments", async () => {
    statuses = new Map([["indexer", "indexer ready"]]);
    const component = mount();
    expect(folderLine(component)).toBe(
      ` ${FOLDER} fake-cwd ${ARROW} ${BRANCH} main ${ARROW}  indexer ready`,
    );
  });

  it("reads git once for any number of draws, and again only after the time to live", async () => {
    const component = mount();
    for (let index = 0; index < 20; index++) component.render(140);
    await settle();
    reads.answer(SOME);
    await settle();
    for (let index = 0; index < 20; index++) component.render(140);
    await settle();
    expect(reads.cwds).toEqual(["fake-cwd"]);
  });

  it("reads git again when the branch changes, and asks Pi to draw the footer", async () => {
    const component = mount();
    component.render(140);
    await settle();
    reads.answer(SOME);
    await settle();
    renders.mockClear();

    branch = "feature";
    for (const listener of branchListeners) listener();
    expect(renders).toHaveBeenCalledTimes(1);
    expect(folderLine(component)).toContain(`${BRANCH} feature +1 ~2 ?3`);
    await settle();
    expect(reads.cwds).toEqual(["fake-cwd", "fake-cwd"]);
    reads.answer({ staged: 0, modified: 0, untracked: 0 });
    await settle();
    expect(folderLine(component)).toBe(` ${FOLDER} fake-cwd ${ARROW} ${BRANCH} feature ${ARROW}`);
  });

  it("shows no counts, and breaks nothing, when git fails", async () => {
    const component = mount();
    component.render(140);
    await settle();
    reads.fail("git exploded");
    await settle();
    expect(folderLine(component)).toBe(` ${FOLDER} fake-cwd ${ARROW} ${BRANCH} main ${ARROW}`);
    expect(component.render(140)).toHaveLength(3);
  });

  it("does not run git outside a repository, and shows the folder segment alone", async () => {
    branch = null;
    const component = mount();
    expect(folderLine(component)).toBe(` ${FOLDER} fake-cwd ${ARROW}`);
    await settle();
    expect(reads.cwds).toEqual([]);
  });

  it("says nothing after the footer goes away", async () => {
    const component = mount();
    component.render(140);
    await settle();
    component.dispose?.();
    reads.answer(SOME);
    await settle();
    expect(renders).not.toHaveBeenCalled();
    expect(branchListeners).toEqual([]);
  });

  it("keeps the first line of the bar as it is", async () => {
    const component = mount();
    const first = stripAnsi(component.render(140)[0] ?? "");
    expect(first).toContain("◆ HARIL");
    expect(first).toContain("MODE: ACTION");
    expect(first.endsWith("■ STOP ALL")).toBe(true);
  });
});

describe("HARIL_POWERLINE=off", () => {
  it("is the plain folder line it has always been, and git is never run", async () => {
    vi.stubEnv("HARIL_POWERLINE", "off");
    const component = mount();
    expect(component.render(140)[1]).toBe("fake-cwd (main)");
    await settle();
    expect(reads.cwds).toEqual([]);
    expect(renders).not.toHaveBeenCalled();
  });

  it("takes effect on the next draw, with no restart", async () => {
    const component = mount();
    expect(folderLine(component)).toContain(BRANCH);
    vi.stubEnv("HARIL_POWERLINE", "off");
    expect(component.render(140)[1]).toBe("fake-cwd (main)");
  });
});

describe("beside the right sidebar", () => {
  it("draws no folder line and does not run git", async () => {
    // With the dock drawn, the right sidebar holds the status and the bar is one line.
    const root = {
      render: () => ["Pi chat"],
      invalidate: () => undefined,
      [LAYOUT_NODE]: () => ({ type: "vstack", gap: 0, align: "stretch", entries: [] }),
    };
    const tui = {
      layoutRoot: root,
      terminal: { columns: 160, rows: 45 },
      requestRender: renders,
    };
    anchor?.(tui as unknown as ConsoleTui, THEME);
    const component = mount(tui);
    const lines = component.render(160).map(stripAnsi);
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("fake-cwd");
    await settle();
    expect(reads.cwds).toEqual([]);
  });
});
