import type { FusionError } from "./domain.js";

const NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/u;
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u;

/**
 * A stable label for an unexpected failure that is safe to persist or display: the error class and,
 * when present, its errno/storage code. Messages are never included because they can carry paths,
 * payload fragments, or credentials.
 */
export function safeCauseCode(error: unknown): string {
  if (!(error instanceof Error)) return error === undefined ? "unknown" : typeof error;
  const name = NAME.test(error.name) ? error.name : "Error";
  const raw = (error as { code?: unknown; kind?: unknown }).code ?? (error as { kind?: unknown }).kind;
  return typeof raw === "string" && CODE.test(raw) && raw !== name ? `${name}:${raw}` : name;
}

/** Typed replacement for an unexpected exception; the original cause is reduced to a safe code. */
export function internalError(safeMessage: string, cause: unknown): FusionError {
  return { kind: "InternalError", safeMessage, retryable: false, causeCode: safeCauseCode(cause) };
}
