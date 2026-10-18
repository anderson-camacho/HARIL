export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly kind: "additive" | "incompatible";
  readonly sql: string;
}
