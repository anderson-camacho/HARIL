import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { plainText } from "./text.js";

export function insideExplorerRoot(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return (
    offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  );
}

export async function resolveExplorerFolder(
  root: string,
  current: string,
  request: string,
): Promise<string> {
  const rawTarget = request === "/" ? root : resolve(current, request);
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(rawTarget)]);
  if (!insideExplorerRoot(realRoot, realTarget))
    throw new Error("No se puede salir de la carpeta del proyecto.");
  if (!(await stat(realTarget)).isDirectory()) throw new Error("La ruta no es una carpeta.");
  return realTarget;
}

/** Returns folders, not files, with ordinary folders ahead of hidden ones. Never follows symlinks in the menu. */
export async function explorerFolderChoices(
  current: string,
): Promise<readonly { label: string; name: string }[]> {
  const entries = await readdir(current, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .sort(
      (a, b) =>
        Number(a.name.startsWith(".")) - Number(b.name.startsWith(".")) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 150)
    .map((entry) => ({ label: `▸ ${plainText(entry.name)}`, name: entry.name }));
}
