import { Schema } from "@haril/contracts";

export const a = eval("1 + 1");
export const b = new Function("return 1");
const name = "./dynamic.js";
export const c = import(name);
export const d = import("@haril/contracts");
export const s = Schema;
