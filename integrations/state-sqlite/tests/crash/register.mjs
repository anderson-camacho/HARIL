// Registers the test-only resolve hook. The durability tests start each writer with `node --import <this file>`.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
