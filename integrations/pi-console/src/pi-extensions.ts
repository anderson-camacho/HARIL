// HARIL's private Pi agent package declarations (NOT a live inventory of Pi's loaded modules).
// No package source is executed or installed when this data is decoded.
export interface PiExtensionPackage {
  readonly source: string;
  readonly extensions: "enabled" | "disabled" | "filtered";
}

export function decodePiExtensionPackages(
  value: unknown,
): readonly PiExtensionPackage[] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.scope !== "haril-private-pi-agent" || !Array.isArray(record.packages)) {
    return undefined;
  }
  const packages: PiExtensionPackage[] = [];
  for (const raw of record.packages) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.source !== "string" ||
      item.source.trim() === "" ||
      (item.extensions !== "enabled" &&
        item.extensions !== "disabled" &&
        item.extensions !== "filtered")
    ) {
      return undefined;
    }
    packages.push({ source: item.source, extensions: item.extensions });
  }
  return packages;
}

export function extensionStatusText(state: PiExtensionPackage["extensions"]): string {
  switch (state) {
    case "enabled":
      return "Declarada · habilitada para el próximo inicio";
    case "disabled":
      return "Declarada · extensiones deshabilitadas";
    case "filtered":
      return "Declarada · filtro personalizado (usar pi config)";
  }
}
