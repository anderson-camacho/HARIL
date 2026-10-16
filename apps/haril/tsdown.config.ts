import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

// One self-contained ESM file: @haril/* and typebox are inlined, node:* builtins stay external.
export default defineConfig({
  entry: { haril: fileURLToPath(new URL("./src/main.ts", import.meta.url)) },
  format: "esm",
  platform: "node",
  outDir: fileURLToPath(new URL("./dist", import.meta.url)),
  fixedExtension: true,
  clean: true,
  deps: {
    alwaysBundle: [/^@haril\//, /^typebox(\/|$)/],
    onlyBundle: [/^typebox(\/|$)/],
  },
  banner: "#!/usr/bin/env node",
});
