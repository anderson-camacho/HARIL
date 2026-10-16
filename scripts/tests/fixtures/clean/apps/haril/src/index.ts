import { Schema } from "@haril/contracts";
import { gitSchema } from "@haril/git";
import { agent } from "@haril/agent-pi";
import { broker } from "@haril/gateway";

export const app = [Schema, gitSchema, agent, broker];
