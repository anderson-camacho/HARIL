// import fake from "@haril/os";
/* export * from "@haril/os"; */
const s1 = 'import x from "@haril/os"';
const s2 = "export { y } from '@haril/os'";
const s3 = `import z from "@haril/os"
import("@haril/os")`;
const s4 = `outer ${`inner import("@haril/os")`} ${"import w from '@haril/os'"}`;
const re = /import q from "@haril/os"/;
const div = 10 / 2 / 5;
import type {
  Marker,
  Other,
} from "@haril/core";
export * from "@haril/contracts";
export { Schema } from "@haril/contracts";
export type { Kind } from "@haril/contracts";
import { Type } from "@haril/contracts";
export const lazy = import("@haril/contracts");
export const s5 = [s1, s2, s3, s4, re, div, Type];
