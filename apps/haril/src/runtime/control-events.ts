import type { ControlEvent } from "@haril/control";
import type { RunEvent } from "@haril/core";

// What the control channel tells a subscriber about a run event (LD-T2): its type and, when it has one, the task id.
// Goals, outputs, paths, keys and the other fields stay in the store; the subscriber reads them from there.
export function controlEventOf(event: RunEvent): ControlEvent {
  return "taskId" in event
    ? { eventType: event.type, taskId: event.taskId }
    : { eventType: event.type };
}
