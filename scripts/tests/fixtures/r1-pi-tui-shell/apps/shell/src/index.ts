import { Text } from "@earendil-works/pi-tui";
import { createAgentSession } from "@earendil-works/pi-coding-agent";

// pi-tui is allowed here (R1 exception); pi-coding-agent stays forbidden even in apps/shell.
export const label = new Text("HARIL shell");
export const agent = createAgentSession;
