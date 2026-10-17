import type { PendingApproval, TaskDetailView } from "../data.js";
import { planDetailLines, plansView } from "./plan.js";
import { configView, modelsView, themesView, unavailableView } from "./setup.js";
import type { PanelContext, PanelId, PanelView } from "./types.js";
import { eventsView, tokensView } from "./usage.js";
import { agentsView, liveView, projectsView, taskDetailLines, tasksView } from "./work.js";

export {
  PANELS,
  type PanelContext,
  type PanelId,
  type PanelView,
  type ShellSettings,
} from "./types.js";

// Builds one panel. Each panel is built only when it is selected: the app calls this for the active panel alone.
export function buildPanelView(id: PanelId, context: PanelContext): PanelView {
  switch (id) {
    case "projects":
      return projectsView(context);
    case "tasks":
      return tasksView(context);
    case "agents":
      return agentsView(context);
    case "tokens":
      return tokensView(context);
    case "events":
      return eventsView(context);
    case "models":
      return modelsView(context);
    case "config":
      return configView(context);
    case "themes":
      return themesView(context);
    case "memory":
    case "services":
    case "terminals":
      return unavailableView();
    case "plans":
      return plansView(context);
    case "live":
      return liveView(context);
  }
}

// The detail of one task, the lines Enter on the Tasks panel opens.
export function buildTaskDetailView(view: TaskDetailView): string[] {
  return taskDetailLines(view);
}

// The tasks of one proposed plan, the lines Enter on the Plans panel opens (LD-T5).
export function buildPlanDetailView(approval: PendingApproval, context: PanelContext): string[] {
  return planDetailLines(approval, context);
}
