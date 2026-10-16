// Typed error and result shapes shared by the ports (contract: HarilError, Result<T, E>).

export interface HarilError {
  readonly code: string;
  readonly message: string;
}

export type Result<T, E = HarilError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
