// Small text helpers shared by the steps: bounded tails of tool output and readable error messages.

export function tail(text: string): string {
  return text.trim().slice(-300);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
