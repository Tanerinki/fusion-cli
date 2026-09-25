import type { ProcessOutcome } from "../../../platform/process/supervisor.js";
import { allowlistedLabel, apiErrorStatusClass, boundedCount, MAX_BYTES, processTerminalFacts, type TurnTerminalClass,
  type TurnTerminalDiagnostic } from "../../../platform/process/terminal-diagnostic.js";

/**
 * O5.5B14: the stream-json result vocabulary of the pinned runtime, Claude Code 2.1.280, as its own result schema defines
 * it (read from the installed binary's bytes, never by launching it; docs/o5-5b14-lead-live-diagnostics.md): `success`
 * and the four error variants of the result message.
 */
export const CLAUDE_RESULT_SUBTYPES = Object.freeze(["success", "error_max_turns", "error_during_execution", "error_max_budget_usd",
  "error_max_structured_output_retries"] as const);
/** Its `terminal_reason` values (2.1.280): the terminal states of the run loop; `completed` is the only normal one. */
export const CLAUDE_TERMINAL_REASONS = Object.freeze(["blocking_limit", "rapid_refill_breaker", "prompt_too_long", "image_error",
  "model_error", "api_error", "malformed_tool_use_exhausted", "aborted_streaming", "aborted_tools", "stop_hook_prevented", "hook_stopped",
  "tool_deferred", "max_turns", "background_requested", "completed", "budget_exhausted", "structured_output_retry_exhausted",
  "tool_deferred_unavailable", "turn_setup_failed"] as const);

/** What a stream knows about its result frame and its reader. In memory only: just the mapping below ever leaves. */
export interface ClaudeResultFacts {
  readonly malformed: boolean;
  readonly result: Readonly<Record<string, unknown>> | undefined;
  /** The result was successful, so its text was handed to the reader. */
  readonly parsingReached: boolean;
  /**
   * A schema or contract check ran on the reply: the envelope evaluated the expected schema, or handed a value on to the
   * caller's contract check (O5.5B18; before, merely "the reply body parsed as JSON").
   */
  readonly schemaCheckReached: boolean;
}

/**
 * The bounded terminal diagnostic of one Claude model turn from its stream and process facts. Labels come only from the
 * allowlists above (`other` / `missing` otherwise); the result text is measured, error entries and permission denials
 * are counted, and nothing else of the frame is read. `started` is false when no model process was spawned.
 */
export function claudeTerminalDiagnostic(facts: ClaudeResultFacts, outcome: ProcessOutcome | undefined, started: boolean): TurnTerminalDiagnostic {
  const result = facts.result;
  const process = processTerminalFacts(outcome);
  const text = result?.result;
  const resultSubtype = result === undefined ? "missing" : allowlistedLabel(result.subtype, CLAUDE_RESULT_SUBTYPES);
  const terminalReason = result === undefined ? "missing" : allowlistedLabel(result.terminal_reason, CLAUDE_TERMINAL_REASONS);
  const isError = typeof result?.is_error === "boolean" ? result.is_error : null;
  const count = (value: unknown) => Array.isArray(value) ? boundedCount(value.length) : null;
  const issue = outcome?.issue?.kind;
  // The stream the transport refuses as invalid: malformed events, invalid or truncated JSONL, failed pipes.
  const invalidStream = facts.malformed || issue === "ProtocolError" || issue === "StreamError" || (outcome?.observerIssues.length ?? 0) > 0;
  // Fusion's own observations first; the result frame's fields explain only a turn that reached its result.
  const classification: TurnTerminalClass = process.cancelled ? "CANCELLED" : process.timedOut ? "TIMEOUT"
    : !started || issue === "SpawnFailure" ? "NOT_STARTED"
    : invalidStream ? "MALFORMED_STREAM" : process.fusionTermination !== null ? "STOPPED_BY_FUSION"
    : result === undefined ? "MISSING_RESULT"
    : resultSubtype === "error_max_turns" ? "RESULT_ERROR_MAX_TURNS"
    : resultSubtype === "error_during_execution" ? "RESULT_ERROR_DURING_EXECUTION"
    : resultSubtype !== "success" ? "RESULT_OTHER_SEMANTIC_ERROR"
    : isError === true ? "RESULT_IS_ERROR"
    : terminalReason !== "completed" ? "RESULT_TERMINAL_NOT_COMPLETED"
    : isError !== false ? "RESULT_OTHER_SEMANTIC_ERROR"
    : "RESULT_OK";
  return Object.freeze({ schemaVersion: 1 as const, classification, resultSubtype, terminalReason, isError,
    internalTurnCount: boundedCount(result?.num_turns), permissionDenialCount: count(result?.permission_denials),
    errorEntryCount: count(result?.errors),
    resultTextPresent: typeof text === "string" && text.length > 0,
    resultTextByteLength: typeof text === "string" ? Math.min(Buffer.byteLength(text, "utf8"), MAX_BYTES) : 0,
    apiErrorStatusClass: result === undefined ? "unknown" as const : apiErrorStatusClass(result.api_error_status),
    structuredParsingReached: facts.parsingReached, schemaValidationReached: facts.schemaCheckReached, ...process });
}
