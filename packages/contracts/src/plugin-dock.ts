// HARIL's dock is a collection of UI slots, not a list of Pi packages loaded at runtime. A visible slot is not proof
// that an extension is installed or running. Integration with Pi's extension lifecycle belongs to a later phase;
// these preferences only describe placement.
//
// The registry lives twice: here, for the CLI that validates haril.json, and in integrations/pi-console/src/
// dock-registry.ts, which imports no workspace package because it is bundled into one Pi extension file.
// A slot added or removed in one must be added or removed in the other.
export const DOCK_SLOTS = [
  { id: "main", label: "Principal" },
  { id: "memory", label: "Memoria" },
  { id: "docs", label: "Documentación" },
  { id: "activity", label: "Actividad" },
  { id: "actions", label: "Acciones" },
] as const;

export type DockSlotId = (typeof DOCK_SLOTS)[number]["id"];

export interface DockSlotPreference {
  readonly id: DockSlotId;
  readonly visible: boolean;
}

const IDS = new Set<string>(DOCK_SLOTS.map((slot) => slot.id));

// The slot that holds the status of the console: it is always the first one and always visible, so the user can
// never end up with a dock that has no way to show it.
const PINNED_ID: DockSlotId = "main";

// Slots that older releases stored in ui.plugins and that no longer exist: "explorer" was the TREE view, and "git",
// "youtube" and "themes" were the GIT, YT and THEME views that the MAIN, MEM and DOCS dock replaced. A haril.json
// written back then must keep loading, so these entries are ignored before anything is validated; the next write of
// the preferences stores the list without them.
const RETIRED_IDS: ReadonlySet<string> = new Set(["explorer", "git", "youtube", "themes"]);

function isRetiredSlot(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const id = (entry as Record<string, unknown>).id;
  return typeof id === "string" && RETIRED_IDS.has(id);
}

function defaultSlots(): DockSlotPreference[] {
  return DOCK_SLOTS.map((slot) => ({ id: slot.id, visible: true }));
}

export function dockPreferenceErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return ["/ui/plugins: must be an array of dock slots"];
  const errors: string[] = [];
  const seen = new Set<string>();
  // The index stays the one the entry has in the file, so a message points at the right line. A slot of the registry
  // that the list leaves out is not a problem: it is filled in when the preferences are resolved.
  for (const [index, entry] of value.entries()) {
    if (isRetiredSlot(entry)) continue;
    const path = `/ui/plugins/${index}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${path}: must be an object with id and visible`);
      continue;
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || !IDS.has(item.id)) {
      errors.push(`${path}/id: unknown dock slot`);
    } else if (seen.has(item.id)) {
      errors.push(`${path}/id: duplicate dock slot ${item.id}`);
    } else {
      seen.add(item.id);
    }
    if (typeof item.visible !== "boolean") errors.push(`${path}/visible: must be boolean`);
    else if (item.id === PINNED_ID && !item.visible) {
      errors.push(`${path}/visible: the ${PINNED_ID} slot cannot be hidden`);
    }
    for (const key of Object.keys(item)) {
      if (key !== "id" && key !== "visible") errors.push(`${path}/${key}: unknown key`);
    }
  }
  return errors;
}

export function resolveDockSlots(value: unknown): DockSlotPreference[] {
  // All readers can safely use defaults; writers must validate and refuse malformed config.
  if (value === undefined || dockPreferenceErrors(value).length !== 0) return defaultSlots();
  // Valid here means an array of slots of the registry, retired entries aside. Dropping the retired ones is what lets
  // the next write heal the file, and filling in what the list lacks is what lets an older list keep working.
  const stored: DockSlotPreference[] = [];
  for (const entry of value as readonly DockSlotPreference[]) {
    if (!isRetiredSlot(entry)) stored.push({ id: entry.id, visible: entry.visible });
  }
  const kept = stored.filter((slot) => slot.id !== PINNED_ID);
  const known = new Set(kept.map((slot) => slot.id));
  for (const slot of DOCK_SLOTS) {
    if (slot.id !== PINNED_ID && !known.has(slot.id)) kept.push({ id: slot.id, visible: true });
  }
  return [{ id: PINNED_ID, visible: true }, ...kept];
}

export function dockSlotExists(id: string): id is DockSlotId {
  return IDS.has(id);
}

// True for the slot that always comes first and cannot be hidden (the CLI refuses to hide or move it).
export function isPinnedDockSlot(id: string): boolean {
  return id === PINNED_ID;
}
