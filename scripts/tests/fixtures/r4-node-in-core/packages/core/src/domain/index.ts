import { readFileSync } from "node:fs";
import { join } from "path";

export const readers = [readFileSync, join];
