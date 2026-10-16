import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

// One self-contained ESM file (ADR-0004 decision 5): the bridge imports only node:* builtins, which stay external.
export default defineConfig({
  entry: { bridge: fileURLToPath(new URL("./src/bridge.ts", import.meta.url)) },
  format: "esm",
  platform: "node",
  outDir: fileURLToPath(new URL("./dist", import.meta.url)),
  fixedExtension: true,
  clean: true,
});
