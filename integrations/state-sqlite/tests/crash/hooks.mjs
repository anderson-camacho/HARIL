// Test-only resolve hook for the writer children. The workspace sources are TypeScript and import each other with
// `.js` specifiers, which Node cannot map to `.ts` by itself. This hook retries a missing `.js` as `.ts`.
// It is loaded only by register.mjs, from this test directory, and never ships in a build.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      specifier.endsWith(".js") &&
      context.parentURL !== undefined
    ) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw error;
  }
}
