// Strict x.y.z version comparison shared by `haril update` and `haril tools`: anything else is not a version.

export function versionParts(input: unknown): number[] | null {
  if (typeof input !== "string" || !/^\d+\.\d+\.\d+$/.test(input)) return null;
  return input.split(".").map(Number);
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  if (left === null || right === null) throw new Error("invalid version");
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
