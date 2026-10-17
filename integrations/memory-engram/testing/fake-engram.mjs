// Fake `engram` executable for the supervision tests: `node fake-engram.mjs serve` serves the fake Engram HTTP
// server (fake-engram-server.ts, loaded with Node's type stripping) on 127.0.0.1:ENGRAM_PORT for ENGRAM_DATA_DIR.
// Not an Engram build: every behaviour is a simulation chosen by FAKE_ENGRAM_SCENARIO, which only the tests' spawn
// wrapper sets. It never reads or writes outside ENGRAM_DATA_DIR and refuses the two traps of 06 sec7 the way a
// careful caller must notice them: an empty data dir (Engram would fall back to ~/.engram) and a port of 0 or an
// invalid one (Engram would fall back to 7437).
//
// Scenarios: ok (default), never_ready (stays alive without listening), exit0 (exits 0 at once, as a serve that found
// its own instance does, #1462), wrong_instance (answers /health with an instance_id that is not .instance-id),
// grandchild (spawns a long-lived child and writes its pid to fake-grandchild.pid, then serves).
// POST /__fake/exit?code=N makes it exit with N after answering.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { FakeEngramServer } from "./fake-engram-server.ts";

const scenario = process.env.FAKE_ENGRAM_SCENARIO ?? "ok";
const dataDir = process.env.ENGRAM_DATA_DIR ?? "";
const rawPort = process.env.ENGRAM_PORT ?? "";
const port = Number(rawPort);

if (process.argv.at(-1) !== "serve") {
  process.stderr.write("fake-engram: only `serve` is simulated\n");
  process.exit(2);
}
if (dataDir.trim() === "" || !isAbsolute(dataDir)) {
  process.stderr.write(
    "fake-engram: ENGRAM_DATA_DIR is empty or relative (Engram would use ~/.engram)\n",
  );
  process.exit(3);
}
if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535 || port === 7437) {
  process.stderr.write(
    "fake-engram: ENGRAM_PORT is missing, 0, invalid or 7437 (Engram would use 7437)\n",
  );
  process.exit(3);
}

// .instance-id: 32 hex, stable for the data dir (06 sec3.9).
const instanceFile = join(dataDir, ".instance-id");
if (!existsSync(instanceFile)) writeFileSync(instanceFile, `${randomBytes(16).toString("hex")}\n`);
const instanceId = readFileSync(instanceFile, "utf8").trim();

if (scenario === "exit0") process.exit(0);
if (scenario === "never_ready") {
  setInterval(() => {}, 1000);
} else {
  if (scenario === "grandchild") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    writeFileSync(join(dataDir, "fake-grandchild.pid"), String(child.pid));
  }
  const server = new FakeEngramServer({
    port,
    token: process.env.ENGRAM_HTTP_TOKEN ?? "",
    instanceId: scenario === "wrong_instance" ? randomBytes(16).toString("hex") : instanceId,
    onExitRequest: (code) => process.exit(code),
  });
  await server.start();
  process.stdout.write(`fake-engram: listening on 127.0.0.1:${port}\n`);
}
