import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

// One self-contained ESM file, like the bridge: the console imports only node:* builtins, which stay external.
export default defineConfig({
  entry: { console: fileURLToPath(new URL("./src/console.ts", import.meta.url)) },
  format: "esm",
  platform: "node",
  outDir: fileURLToPath(new URL("./dist", import.meta.url)),
  fixedExtension: true,
  clean: true,
});
