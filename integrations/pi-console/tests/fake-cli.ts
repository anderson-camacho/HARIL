import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake `haril` CLI for the console's tests: a small Node script the console runs through HARIL_NODE and HARIL_CLI,
// exactly as it runs the real one. It records every call (its arguments, and stdin when --stdin is passed) and answers
// from a table keyed by the first words of the command ("stop --now", "workflow start", "usage record"…). No HARIL
// store or runtime is involved.

interface FakeAnswer {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  // Waits this long before answering, to test timeouts.
  readonly delayMs?: number;
}

interface FakeCall {
  readonly args: string[];
  readonly stdin: string | null;
}

export interface FakeCli {
  answer(key: string, answer: FakeAnswer): void;
  calls(): FakeCall[];
  restore(): void;
}

const SCRIPT = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
const [log, table] = [process.env.FAKE_HARIL_LOG, process.env.FAKE_HARIL_TABLE];
const args = process.argv.slice(2);
const stdin = args.includes("--stdin") ? readFileSync(0, "utf8") : null;
appendFileSync(log, JSON.stringify({ args, stdin }) + "\n");
const answers = JSON.parse(readFileSync(table, "utf8"));
const key = Object.keys(answers)
  .filter((candidate) => args.join(" ").startsWith(candidate))
  .sort((a, b) => b.length - a.length)[0];
const answer = key === undefined ? {} : answers[key];
setTimeout(() => {
  if (answer.stdout) process.stdout.write(answer.stdout);
  if (answer.stderr) process.stderr.write(answer.stderr);
  process.exitCode = answer.code ?? 0;
}, answer.delayMs ?? 0);
`;

export function installFakeCli(): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), "haril-fake-cli-"));
  const script = join(dir, "haril.mjs");
  const log = join(dir, "calls.jsonl");
  const table = join(dir, "answers.json");
  writeFileSync(script, SCRIPT);
  writeFileSync(log, "");
  const answers: Record<string, FakeAnswer> = {};
  writeFileSync(table, JSON.stringify(answers));
  const saved = {
    node: process.env.HARIL_NODE,
    cli: process.env.HARIL_CLI,
    log: process.env.FAKE_HARIL_LOG,
    table: process.env.FAKE_HARIL_TABLE,
  };
  process.env.HARIL_NODE = process.execPath;
  process.env.HARIL_CLI = script;
  process.env.FAKE_HARIL_LOG = log;
  process.env.FAKE_HARIL_TABLE = table;
  const put = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  return {
    answer(key, answer) {
      answers[key] = answer;
      writeFileSync(table, JSON.stringify(answers));
    },
    calls() {
      return readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as FakeCall);
    },
    restore() {
      put("HARIL_NODE", saved.node);
      put("HARIL_CLI", saved.cli);
      put("FAKE_HARIL_LOG", saved.log);
      put("FAKE_HARIL_TABLE", saved.table);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
