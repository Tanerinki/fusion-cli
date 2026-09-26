import type { ProcessOutcome } from "../../platform/process/supervisor.js";
import { allowlistedLabel, apiErrorStatusClass, MAX_BYTES, processTerminalFacts, type TurnTerminalClass,
  type TurnTerminalDiagnostic } from "../../platform/process/terminal-diagnostic.js";
import type { ProviderDiagnostic } from "./failure-diagnostic.js";

/** O5.5B23: the Exec JSONL's terminal events (`run.terminal.<status>`), as protocol labels. */
export const MUSE_TERMINAL_STATUSES = Object.freeze(["completed", "failed", "cancelled"] as const);
/** Fusion's own bounded classification of a failed terminal's reason (`failure-diagnostic.ts`), as protocol labels. */
const FAILURE_REASONS: Readonly<Record<ProviderDiagnostic["classification"], string>> = Object.freeze({
  schemaRejected: "schema_rejected", authorizationRejected: "authorization_rejected", rateLimited: "rate_limited",
  providerUnavailable: "provider_unavailable", timeout: "timeout", cancelled: "cancelled", providerFailure: "provider_failure" });
export const MUSE_TERMINAL_REASONS = Object.freeze([...MUSE_TERMINAL_STATUSES, ...Object.values(FAILURE_REASONS)]);

/** What one Exec attempt knows about its terminal event and its reader. In memory only: just the mapping below ever leaves. */
export interface MuseTerminalFacts {
  readonly malformed: boolean;
  /** The one terminal event, if any: its status, the byte length of its text and Fusion's classification of a failure. */
  readonly terminal: Readonly<{ status: string; textBytes: number; failure?: ProviderDiagnostic }> | undefined;
  /** The turn completed, so its text was handed to the reader. */
  readonly parsingReached: boolean;
  /** The reply passed every structural rule and reached the schema check (O5.5B22's exact definition). */
  readonly schemaCheckReached: boolean;
}

/**
 * O5.5B23 — the bounded terminal diagnostic (O5.5B14's provider-neutral shape) of one Muse Exec model turn. Exec reports
 * no agentic turn count, permission denials or error entries, so those stay null. Labels come only from the allowlists
 * above; the terminal text is measured, never copied. Fusion's own observations come first, then the terminal event:
 * a failed one is RESULT_IS_ERROR, a cancelled one RESULT_TERMINAL_NOT_COMPLETED, a completed one RESULT_OK.
 */
export function museTerminalDiagnostic(facts: MuseTerminalFacts, outcome: ProcessOutcome | undefined, started: boolean): TurnTerminalDiagnostic {
  const process = processTerminalFacts(outcome);
  const terminal = facts.terminal;
  const issue = outcome?.issue?.kind;
  const invalidStream = facts.malformed || issue === "ProtocolError" || issue === "StreamError" || (outcome?.observerIssues.length ?? 0) > 0;
  const status = terminal === undefined ? "missing" : allowlistedLabel(terminal.status, MUSE_TERMINAL_STATUSES);
  const reason = terminal === undefined ? "missing" : status === "failed"
    ? allowlistedLabel(FAILURE_REASONS[terminal.failure?.classification ?? "providerFailure"], MUSE_TERMINAL_REASONS) : status;
  const classification: TurnTerminalClass = process.cancelled ? "CANCELLED" : process.timedOut ? "TIMEOUT"
    : !started || issue === "SpawnFailure" ? "NOT_STARTED"
    : invalidStream ? "MALFORMED_STREAM" : process.fusionTermination !== null ? "STOPPED_BY_FUSION"
    : terminal === undefined ? "MISSING_RESULT"
    : status === "failed" ? "RESULT_IS_ERROR"
    : status !== "completed" ? "RESULT_TERMINAL_NOT_COMPLETED"
    : "RESULT_OK";
  const bytes = terminal === undefined ? 0 : Math.min(terminal.textBytes, MAX_BYTES);
  return Object.freeze({ schemaVersion: 1 as const, classification, resultSubtype: status, terminalReason: reason,
    isError: status === "failed" ? true : status === "completed" ? false : null,
    internalTurnCount: null, permissionDenialCount: null, errorEntryCount: null,
    resultTextPresent: bytes > 0, resultTextByteLength: bytes,
    apiErrorStatusClass: terminal === undefined ? "unknown" as const : apiErrorStatusClass(terminal.failure?.httpStatus),
    structuredParsingReached: facts.parsingReached, schemaValidationReached: facts.schemaCheckReached, ...process });
}
