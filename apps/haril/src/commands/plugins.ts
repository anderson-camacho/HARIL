import { DOCK_SLOTS, dockSlotExists, resolveDockSlots } from "@haril/contracts";
import { argsProblem, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { configDocumentErrors, harilConfigPath } from "../providers.js";
import { readConfigDocument, serializeConfig, writeConfigAtomically } from "./config-file.js";

// Manages the native HARIL dock's visibility/order. It deliberately does not
// install, enable, unload or inspect Pi extensions: Pi's live inventory is not available here.
const USAGE = [
  "usage: haril plugins list [--json]",
  "       haril plugins show|hide <git|youtube|memory|themes> [--json]",
  "       haril plugins move <id> up|down [--json]",
  "       haril plugins reset [--json]",
  "These settings control HARIL's visual left dock; Pi extensions are not changed.",
].join("\n");

type Slot = ReturnType<typeof resolveDockSlots>[number];

function failure(io: CliIo, message: string): number {
  io.err(`haril: ${message}`);
  return EXIT_USAGE;
}

function display(io: CliIo, slots: readonly Slot[], configPath: string, json: boolean): void {
  if (json) {
    io.out(JSON.stringify({ configPath, scope: "dock-preferences-only", plugins: slots }));
    return;
  }
  io.out("HARIL · plugin dock (visible in compatible Pi terminals; not loaded Pi extensions)");
  for (const [index, slot] of slots.entries()) {
    const label = DOCK_SLOTS.find((item) => item.id === slot.id)?.label ?? slot.id;
    io.out(
      `  ${index + 1}. ${label.padEnd(12)} ${slot.visible ? "visible" : "hidden"}  (${slot.id})`,
    );
  }
  io.out(
    "Use haril plugins show/hide/move; reopen haril or use /haril-plugins to refresh the native dock.",
  );
}

export function plugins(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: [], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [verb = "list", id, direction, ...extra] = parsed.positionals;
  const json = parsed.flags.has("--json");
  if (extra.length > 0) return failure(io, USAGE);
  if (verb === "list" || verb === "reset") {
    if (id !== undefined || direction !== undefined) return failure(io, USAGE);
  } else if (verb === "show" || verb === "hide") {
    if (id === undefined || direction !== undefined || !dockSlotExists(id)) {
      return failure(io, USAGE);
    }
  } else if (verb === "move") {
    if (id === undefined || !dockSlotExists(id) || (direction !== "up" && direction !== "down")) {
      return failure(io, USAGE);
    }
  } else return failure(io, USAGE);

  const configPath = harilConfigPath(host).path;
  const read = readConfigDocument(configPath);
  if (!read.ok) return failure(io, `${configPath}: ${read.error}`);
  const configErrors = configDocumentErrors(read.document);
  if (configErrors.length > 0) {
    return failure(
      io,
      `${configPath} has problems; fix them before managing dock slots:\n${configErrors.join("\n")}`,
    );
  }
  const ui = read.document.ui as Record<string, unknown> | undefined;
  const slots = resolveDockSlots(ui?.plugins);
  if (verb === "list") {
    display(io, slots, configPath, json);
    return EXIT_OK;
  }

  if (verb === "reset") {
    slots.splice(0, slots.length, ...resolveDockSlots(undefined));
  } else {
    const index = slots.findIndex((slot) => slot.id === id);
    const current = slots[index];
    if (current === undefined) return failure(io, `unknown plugin dock slot: ${id}`);
    if (verb === "show" || verb === "hide") {
      slots[index] = { id: current.id, visible: verb === "show" };
    } else if (verb === "move") {
      const nextIndex = index + (direction === "up" ? -1 : 1);
      if (nextIndex >= 0 && nextIndex < slots.length) {
        const [chosen] = slots.splice(index, 1);
        if (chosen !== undefined) slots.splice(nextIndex, 0, chosen);
      }
    }
  }

  const nextDocument = { ...read.document, ui: { ...ui, plugins: slots } };
  const errors = configDocumentErrors(nextDocument);
  if (errors.length > 0) return failure(io, `preferences were not saved: ${errors.join("; ")}`);
  const text = serializeConfig(nextDocument, read.exists ? read.text : undefined);
  if (!read.exists || text !== read.text) {
    try {
      writeConfigAtomically(configPath, text);
    } catch (error) {
      return failure(
        io,
        `could not save ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  display(io, slots, configPath, json);
  return EXIT_OK;
}
