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
  // The native block.md files ship next to the bundle: `methodology list` reads dist/blocks (M3-T1).
  copy: [
    {
      // Globs need forward slashes, so the absolute path is converted before the pattern is appended.
      from: `${fileURLToPath(new URL("../../blocks", import.meta.url))
        .split("\\")
        .join("/")}/**/*.md`,
      to: fileURLToPath(new URL("./dist/blocks", import.meta.url)),
      flatten: false,
    },
  ],
});
