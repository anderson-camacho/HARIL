// HARIL's left dock is a collection of UI slots, not a list of Pi packages loaded at runtime.
// A visible slot is not proof that an extension is installed or running. Integration with Pi's
// extension lifecycle belongs to a later phase; these preferences only describe placement.
export const DOCK_SLOTS = [
  { id: "git", label: "Git" },
  { id: "youtube", label: "YouTube" },
  { id: "memory", label: "Memoria" },
  { id: "themes", label: "Temas" },
] as const;

export type DockSlotId = (typeof DOCK_SLOTS)[number]["id"];

export interface DockSlotPreference {
  readonly id: DockSlotId;
  readonly visible: boolean;
}

const IDS = new Set<string>(DOCK_SLOTS.map((slot) => slot.id));

// Slots that older releases stored in ui.plugins and that no longer exist ("explorer" was the TREE view). A
// haril.json written back then must keep loading, so these entries are ignored before anything is validated;
// the next write of the preferences stores the list without them.
const RETIRED_IDS: ReadonlySet<string> = new Set(["explorer"]);

function isRetiredSlot(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const id = (entry as Record<string, unknown>).id;
  return typeof id === "string" && RETIRED_IDS.has(id);
}

export function dockPreferenceErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return ["/ui/plugins: must be an array of dock slots"];
  // The index stays the one the entry has in the file, so a message points at the right line.
  const entries = value
    .map((entry: unknown, index) => ({ entry, index }))
    .filter(({ entry }) => !isRetiredSlot(entry));
  if (entries.length !== DOCK_SLOTS.length) {
    return [`/ui/plugins: must contain all ${DOCK_SLOTS.length} dock slots exactly once`];
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const { entry, index } of entries) {
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
    for (const key of Object.keys(item)) {
      if (key !== "id" && key !== "visible") errors.push(`${path}/${key}: unknown key`);
    }
  }
  return errors;
}

export function resolveDockSlots(value: unknown): DockSlotPreference[] {
  // All readers can safely use defaults; writers must validate and refuse malformed config.
  if (value === undefined || dockPreferenceErrors(value).length !== 0) {
    return DOCK_SLOTS.map((slot) => ({ id: slot.id, visible: true }));
  }
  // Valid here means an array; dropping the retired entries is what lets the next write heal the file.
  return (value as DockSlotPreference[])
    .filter((slot) => !isRetiredSlot(slot))
    .map((slot) => ({ ...slot }));
}

export function dockSlotExists(id: string): id is DockSlotId {
  return IDS.has(id);
}
