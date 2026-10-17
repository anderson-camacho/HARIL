import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

// One self-contained ESM file: pi-tui, the @haril/* workspace packages and typebox are inlined, node:* builtins stay
// external, so the installed release needs no node_modules. pi-tui's optional native addon is not shipped; pi-tui
// loads it fail-soft (TUI-D11).
const BUNDLED = [
  /^@earendil-works\/pi-tui(\/|$)/,
  /^@haril\//,
  /^marked(\/|$)/,
  /^get-east-asian-width(\/|$)/,
  /^typebox(\/|$)/,
];

export default defineConfig({
  entry: { shell: fileURLToPath(new URL("./src/main.ts", import.meta.url)) },
  format: "esm",
  platform: "node",
  outDir: fileURLToPath(new URL("./dist", import.meta.url)),
  fixedExtension: true,
  clean: true,
  deps: {
    alwaysBundle: BUNDLED,
    onlyBundle: BUNDLED,
  },
  banner: "#!/usr/bin/env node",
});
