import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

// One self-contained ESM file. The bootstrap imports node:* builtins only, so nothing is bundled.
export default defineConfig({
  entry: { "haril-bootstrap": fileURLToPath(new URL("./src/main.ts", import.meta.url)) },
  format: "esm",
  platform: "node",
  outDir: fileURLToPath(new URL("./dist", import.meta.url)),
  fixedExtension: true,
  clean: true,
  banner: "#!/usr/bin/env node",
});
