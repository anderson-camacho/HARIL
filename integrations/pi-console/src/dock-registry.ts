// HARIL's visual dock describes independently selectable spaces. These are not
// declarations that a third-party Pi package is installed or running.
export const DOCK_LABELS = [
  { id: "git", label: "Git", labelEn: "Git", tab: "GIT", glyph: "⑂", readOnly: true },
  { id: "youtube", label: "YouTube", labelEn: "YouTube", tab: "YT", glyph: "▶", readOnly: true },
  { id: "memory", label: "Memoria", labelEn: "Memory", tab: "MEM", glyph: "◈", readOnly: true },
  { id: "themes", label: "Temas", labelEn: "Themes", tab: "THEME", glyph: "◐", readOnly: true },
] as const;

export type DockId = (typeof DOCK_LABELS)[number]["id"];

export interface DockSlot {
  readonly id: DockId;
  readonly visible: boolean;
}

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
  // Unknown IDs and duplicate entries cannot inject unregistered views.
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
  return chosen;
}
