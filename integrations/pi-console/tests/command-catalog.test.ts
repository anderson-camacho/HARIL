import { describe, expect, it } from "vitest";
import { commandCatalog } from "../src/command-catalog.js";

describe("live HARIL / Pi extension command catalog", () => {
  it("only lists commands actually reported by Pi and separates HARIL from third parties", () => {
    const lines = commandCatalog(
      ["haril", "haril-commands", "haril-panel", "yt", "yt", "../../danger", "mode"],
      [
        { name: "haril", description: "Abrir el menú" },
        { name: "mode", description: "Cambiar modo" },
        { name: "deny", description: "Denegar" },
      ],
    ).join("\n");
    expect(lines).toContain("HARIL (4 disponibles)");
    expect(lines).toContain("/haril · Abrir el menú");
    expect(lines).toContain("/mode · Cambiar modo");
    expect(lines).toContain("/haril-commands");
    expect(lines).toContain("/haril-panel · Abrir el menú de teclado del panel derecho");
    expect(lines).not.toContain("/deny");
    expect(lines).toContain("OTRAS EXTENSIONES · COMANDOS (1)");
    expect(lines).toContain("/yt");
    expect(lines).not.toContain("danger");
    expect(lines).toContain("Alt+L");
    expect(lines).toContain("Alt+I");
    expect(lines).toContain("Alt+K · menú del panel derecho (flechas y Enter) o /haril-panel");
    expect(lines).toContain("/hotkeys");
  });

  it("shows a useful empty state when Pi reports no commands", () => {
    const lines = commandCatalog([], []).join("\n");
    expect(lines).toContain("HARIL (0 disponibles)");
    expect(lines).toContain("No se reportan comandos adicionales.");
    expect(lines).toContain("haril help");
  });
});
