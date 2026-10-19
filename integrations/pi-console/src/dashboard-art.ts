// An intentionally static terminal wordmark: no animation, cursor movement or ANSI escape
// sequences. It remains readable in terminals without image-protocol support.
const BRAND_ART = [
  "██   ██  █████  ██████  ██ ██",
  "██   ██ ██   ██ ██   ██ ██ ██",
  "███████ ███████ ██████  ██ ██",
  "██   ██ ██   ██ ██  ██  ██ ██",
  "██   ██ ██   ██ ██   ██ ██ ███████",
] as const;

export function renderBrandMark(): string {
  return "HARIL ◉";
}

export function renderBrandArt(): readonly string[] {
  return BRAND_ART;
}
