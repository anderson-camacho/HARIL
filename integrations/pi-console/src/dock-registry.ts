// HARIL's visual dock describes independently selectable spaces. These are not
// declarations that a third-party Pi package is installed or running.
//
// This registry has a twin in packages/contracts/src/plugin-dock.ts (DOCK_SLOTS), which the CLI uses to validate
// haril.json. The console bundles into one Pi extension file and imports no workspace package, so the ids are
// repeated here; a test compares them (dock-registry.test.ts).
export const DOCK_LABELS = [
  { id: "main", label: "Principal", labelEn: "Main", tab: "MAIN", readOnly: true },
  { id: "memory", label: "Memoria", labelEn: "Memory", tab: "MEM", readOnly: true },
  { id: "docs", label: "Documentación", labelEn: "Docs", tab: "DOCS", readOnly: true },
  { id: "activity", label: "Actividad", labelEn: "Activity", tab: "ACT", readOnly: true },
  { id: "actions", label: "Acciones", labelEn: "Actions", tab: "ACC", readOnly: true },
] as const;

export type DockId = (typeof DOCK_LABELS)[number]["id"];

export interface DockSlot {
  readonly id: DockId;
  readonly visible: boolean;
}

// The slot that holds the status of the console. It is always the first one and always visible.
export const MAIN_DOCK_ID: DockId = "main";

const REGISTRY = new Map<string, (typeof DOCK_LABELS)[number]>(
  DOCK_LABELS.map((item) => [item.id, item]),
);

export function dockDefinition(id: DockId) {
  return REGISTRY.get(id);
}

export function readDockSlots(raw: unknown): DockSlot[] {
  const value =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) && "value" in raw
      ? (raw as { readonly value: unknown }).value
      : undefined;
  if (!Array.isArray(value)) return DOCK_LABELS.map(({ id }) => ({ id, visible: true }));

  // Preserve user ordering/visibility when the registry adds a new dock module.
  // Unknown IDs (the ones that older releases stored and that are gone: git, youtube, themes, explorer) and duplicate
  // entries cannot inject unregistered views.
  const seen = new Set<DockId>();
  const chosen: DockSlot[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !REGISTRY.has(entry.id) ||
      typeof entry.visible !== "boolean" ||
      seen.has(entry.id)
    )
      continue;
    seen.add(entry.id);
    chosen.push({ id: entry.id, visible: entry.visible });
  }
  for (const { id } of DOCK_LABELS) {
    if (!seen.has(id)) chosen.push({ id, visible: true });
  }
  // MAIN is always first and visible, whatever the stored list says.
  return [
    { id: MAIN_DOCK_ID, visible: true },
    ...chosen.filter((slot) => slot.id !== MAIN_DOCK_ID),
  ];
}
