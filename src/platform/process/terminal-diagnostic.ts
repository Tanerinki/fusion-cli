import type { KillReason, ProcessOutcome } from "./supervisor.js";

/**
 * O5.5B14 — the bounded terminal diagnostic of one provider model turn: WHY the turn ended, as the provider's own result
 * classification and Fusion's process classification, in enums, booleans, counts and bounded integers only. No field can
 * hold text: result text, error strings, stderr, prompts, provider messages and identifiers are never copied, only
 * measured (a byte length) or counted. It explains an outcome; it never decides one.
 *
 * Classification precedence (the first that holds): CANCELLED, TIMEOUT, NOT_STARTED (no process spawned),
 * MALFORMED_STREAM (malformed events, invalid or truncated JSONL, failed pipes), STOPPED_BY_FUSION (Fusion ended the
 * process, e.g. a refused init or an output limit), MISSING_RESULT, then the result frame's own fields —
 * RESULT_ERROR_MAX_TURNS, RESULT_ERROR_DURING_EXECUTION, RESULT_OTHER_SEMANTIC_ERROR (any other non-success subtype),
 * RESULT_IS_ERROR, RESULT_TERMINAL_NOT_COMPLETED, RESULT_OTHER_SEMANTIC_ERROR again for a success frame without an explicit
 * `false` error flag — and RESULT_OK last. Fusion's own observations come first; a provider field can only explain a
 * turn that reached its result.
 */
export const TURN_TERMINAL_CLASSES = Object.freeze(["CANCELLED", "TIMEOUT", "NOT_STARTED", "MALFORMED_STREAM", "STOPPED_BY_FUSION",
  "MISSING_RESULT", "RESULT_ERROR_MAX_TURNS", "RESULT_ERROR_DURING_EXECUTION", "RESULT_OTHER_SEMANTIC_ERROR", "RESULT_IS_ERROR",
  "RESULT_TERMINAL_NOT_COMPLETED", "RESULT_OK"] as const);
export type TurnTerminalClass = (typeof TURN_TERMINAL_CLASSES)[number];
export const API_ERROR_STATUS_CLASSES = Object.freeze(["none", "4xx", "5xx", "other", "unknown"] as const);
export type ApiErrorStatusClass = (typeof API_ERROR_STATUS_CLASSES)[number];
export const PROCESS_SIGNALS = Object.freeze(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "other"] as const);
export type ProcessSignalLabel = (typeof PROCESS_SIGNALS)[number];
const KILL_REASONS: readonly KillReason[] = Object.freeze(["user", "timeout", "outputLimit", "protocolError", "shutdown"]);

export interface TurnTerminalDiagnostic {
  readonly schemaVersion: 1;
  readonly classification: TurnTerminalClass;
  /** The result frame's subtype as an allowlisted protocol label, `other` for an unknown one, `missing` without it. */
  readonly resultSubtype: string;
  /** The result frame's terminal reason as an allowlisted protocol label, `other`, or `missing`. */
  readonly terminalReason: string;
  readonly isError: boolean | null;
  /** The provider's own agentic turn count for this turn (its `num_turns`), when reported. */
  readonly internalTurnCount: number | null;
  /** How many permission denials the provider reported (never which tool or input). */
  readonly permissionDenialCount: number | null;
  /** How many error entries the provider's result carried (never their text). */
  readonly errorEntryCount: number | null;
  readonly resultTextPresent: boolean;
  readonly resultTextByteLength: number;
  readonly apiErrorStatusClass: ApiErrorStatusClass;
  /** The reply reached Fusion's reader: the provider reported success, so the reply text was read. */
  readonly structuredParsingReached: boolean;
  /**
   * A schema or contract check ran on the reply: its envelope evaluated the expected schema, or handed one JSON value on
   * to the ResultPacket / core contract check. O5.5B18 narrowed this from "the reply body parsed as JSON", which also
   * counted a fence body refused by a raw-only envelope before any check ran.
   */
  readonly schemaValidationReached: boolean;
  readonly processExitCode: number | null;
  readonly processSignal: ProcessSignalLabel | null;
  /** Fusion's own termination of the process, if it ended it. */
  readonly fusionTermination: KillReason | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

/** A protocol label: lower-case identifier characters only, bounded — it can hold no sentence, path or secret text. */
const LABEL = /^[a-z][a-z0-9_]{0,47}$/u;
const MAX_COUNT = 1_000_000;
/** Far above any provider output Fusion accepts (its stdout limits are a few MiB). */
export const MAX_BYTES = 64 * 1024 * 1024;
/** A non-negative safe integer up to a bound, else null (never a guess). */
export function boundedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT ? value as number : null;
}
/** A reported HTTP-like status as a class: `none` when absent or null, `unknown` when not a number. */
export function apiErrorStatusClass(value: unknown): ApiErrorStatusClass {
  if (value === undefined || value === null) return "none";
  if (typeof value !== "number" || !Number.isInteger(value)) return "unknown";
  return value >= 400 && value <= 499 ? "4xx" : value >= 500 && value <= 599 ? "5xx" : "other";
}
/** A label from an allowlist, `other` for any other string, `missing` when absent. */
export function allowlistedLabel(value: unknown, allowed: readonly string[]): string {
  if (value === undefined || value === null) return "missing";
  return typeof value === "string" && allowed.includes(value) && LABEL.test(value) ? value : "other";
}
/** The process facts of a turn: exit code, a bounded signal label, Fusion's termination, timeout and cancellation. */
export function processTerminalFacts(outcome: ProcessOutcome | undefined): Pick<TurnTerminalDiagnostic, "processExitCode" | "processSignal" |
  "fusionTermination" | "timedOut" | "cancelled"> {
  const signal = outcome?.signal ?? null;
  const termination = outcome?.termination?.reason ?? null;
  return { processExitCode: Number.isSafeInteger(outcome?.exitCode) ? outcome!.exitCode : null,
    processSignal: signal === null ? null : (PROCESS_SIGNALS as readonly string[]).includes(signal) ? signal as ProcessSignalLabel : "other",
    fusionTermination: termination !== null && KILL_REASONS.includes(termination) ? termination : null,
    timedOut: outcome?.issue?.kind === "Timeout" || termination === "timeout",
    cancelled: outcome?.issue?.kind === "Cancelled" || termination === "user" };
}

const KEYS: readonly (keyof TurnTerminalDiagnostic)[] = Object.freeze(["schemaVersion", "classification", "resultSubtype", "terminalReason",
  "isError", "internalTurnCount", "permissionDenialCount", "errorEntryCount", "resultTextPresent", "resultTextByteLength", "apiErrorStatusClass",
  "structuredParsingReached", "schemaValidationReached", "processExitCode", "processSignal", "fusionTermination", "timedOut", "cancelled"]);
const nullableCount = (value: unknown) => value === null || boundedCount(value) !== null;
const CHECKS: Readonly<Record<keyof TurnTerminalDiagnostic, (value: unknown) => boolean>> = Object.freeze({
  schemaVersion: value => value === 1,
  classification: value => (TURN_TERMINAL_CLASSES as readonly unknown[]).includes(value),
  resultSubtype: value => typeof value === "string" && LABEL.test(value),
  terminalReason: value => typeof value === "string" && LABEL.test(value),
  isError: value => value === null || typeof value === "boolean",
  internalTurnCount: nullableCount, permissionDenialCount: nullableCount, errorEntryCount: nullableCount,
  resultTextPresent: value => typeof value === "boolean",
  resultTextByteLength: value => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_BYTES,
  apiErrorStatusClass: value => (API_ERROR_STATUS_CLASSES as readonly unknown[]).includes(value),
  structuredParsingReached: value => typeof value === "boolean", schemaValidationReached: value => typeof value === "boolean",
  processExitCode: value => value === null || (Number.isSafeInteger(value) && Math.abs(value as number) <= 2 ** 32),
  processSignal: value => value === null || (PROCESS_SIGNALS as readonly unknown[]).includes(value),
  fusionTermination: value => value === null || (KILL_REASONS as readonly unknown[]).includes(value),
  timedOut: value => typeof value === "boolean", cancelled: value => typeof value === "boolean",
});
/**
 * Re-validates a terminal diagnostic an adapter reports before it may enter evidence: exactly the known keys, each an
 * enum, a label, a boolean or a bounded integer. Anything else — an extra key, a string that is not a label, a
 * non-integer — makes the whole diagnostic `invalid`; nothing is copied through. `null` when none was reported.
 */
export function terminalOnlyDiagnostic(candidate: unknown): TurnTerminalDiagnostic | "invalid" | null {
  if (candidate === undefined || candidate === null) return null;
  if (typeof candidate !== "object" || Array.isArray(candidate)) return "invalid";
  const source = candidate as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== KEYS.length || !KEYS.every(key => Object.hasOwn(source, key))) return "invalid";
  const out: Record<string, unknown> = {};
  for (const key of KEYS) {
    if (!CHECKS[key](source[key])) return "invalid";
    out[key] = source[key];
  }
  return Object.freeze(out) as unknown as TurnTerminalDiagnostic;
}
