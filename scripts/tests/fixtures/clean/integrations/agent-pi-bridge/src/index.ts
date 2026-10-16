import { createServer } from "node:net";
import { Schema } from "@haril/contracts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const bridge = [createServer, Schema];
export type Api = ExtensionAPI;
