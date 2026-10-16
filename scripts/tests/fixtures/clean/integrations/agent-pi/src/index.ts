import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { Marker } from "@haril/core";

export const agent = createAgentSession;
export type AgentMarker = Marker;
