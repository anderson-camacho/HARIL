// Public surface of @haril/os: operating-system adapters. The block loader reads block.md files (ADR-0014 D7).
export {
  type BlockFileParse,
  checkSectionMarkers,
  parseBlockFile,
  type SectionMarkerCheck,
} from "./blocks/block-file.js";
export {
  type BlockEntry,
  type BlockRegistry,
  type BlockRegistryLoad,
  type BlockRejection,
  loadBlockRegistry,
} from "./blocks/registry.js";
export { parseStrictJson, type StrictJsonResult } from "./blocks/strict-json.js";
