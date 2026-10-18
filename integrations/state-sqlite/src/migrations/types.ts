export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly kind: "additive" | "incompatible";
  readonly sql: string;
  // Checksums of earlier texts of this migration that built the same schema (a comment or row-order edit). A database
  // that recorded one of them is not corrupt. Empty for nearly every migration: an applied migration is never edited.
  readonly previousChecksums?: readonly string[];
}
