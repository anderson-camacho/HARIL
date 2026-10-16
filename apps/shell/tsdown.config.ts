import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

// One self-contained ESM file: pi-tui and its JavaScript dependencies are inlined, so the installed release needs
// no node_modules. Its optional native addon is not shipped; pi-tui loads it fail-soft (TUI-D11).
export default defineConfig({
  entry: { shell: fileURLToPath(new URL("./src/main.ts", import.meta.url)) },
  format: "esm",
  platform: "node",
  outDir: fileURLToPath(new URL("./dist", import.meta.url)),
  fixedExtension: true,
  clean: true,
  deps: {
    alwaysBundle: [
      /^@earendil-works\/pi-tui(\/|$)/,
      /^marked(\/|$)/,
      /^get-east-asian-width(\/|$)/,
    ],
  },
  banner: "#!/usr/bin/env node",
});
