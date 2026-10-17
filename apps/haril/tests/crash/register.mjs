// Registers the test-only resolve hook. The parent test starts each child with `node --import <this file>`.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
