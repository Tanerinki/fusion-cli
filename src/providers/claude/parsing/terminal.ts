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
   * The schema/contract stage was reached: the reply passed every structural envelope rule and was handed on to the
   * caller's contract check, or refused by the schema check itself (O5.5B22; O5.5B18 and before counted less exactly).
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

/** Stop reasons of the model's last message the result frame may carry (a label, never text). */
export const CLAUDE_STOP_REASONS = Object.freeze(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal",
  "model_context_window_exceeded"] as const);
export type ClaudeFailureCategory = "turnLimit" | "inputTooLarge" | "rateLimited" | "authentication" | "providerApiError" | "modelError" |
  "malformedToolUse" | "structuredOutput" | "budget" | "hookStopped" | "aborted" | "providerError";
const CATEGORY_TEXT: Readonly<Record<ClaudeFailureCategory, string>> = Object.freeze({
  turnLimit: "Claude stopped at Fusion's turn limit before it answered",
  inputTooLarge: "Claude reported its input as too large",
  rateLimited: "Claude reported a usage or rate limit",
  authentication: "Claude reported an authentication failure",
  providerApiError: "Claude reported a provider API error",
  modelError: "Claude reported a model error",
  malformedToolUse: "Claude gave up after malformed tool calls",
  structuredOutput: "Claude could not produce the required structured output",
  budget: "Claude stopped at a budget limit",
  hookStopped: "a Claude hook stopped the turn",
  aborted: "Claude aborted the turn",
  providerError: "Claude reported a failed turn",
});
/**
 * v0.2.3 — a SAFE, human-readable account of a failed Claude turn: one category, then allowlisted protocol labels, counts
 * and numbers only (`subtype`, `terminal_reason`, `stop_reason`, `is_error`, `num_turns` against Fusion's `max_turns`,
 * `api_error_status`, `duration_ms`, the exit code). No provider text, prompt, reply or path is ever read into it.
 */
export function claudeFailureSummary(facts: ClaudeResultFacts, outcome: ProcessOutcome | undefined, maxTurns?: number):
  Readonly<{ category: ClaudeFailureCategory; detail: string }> {
  const diagnostic = claudeTerminalDiagnostic(facts, outcome, true);
  const result = facts.result;
  const stop = result === undefined ? "missing" : allowlistedLabel(result.stop_reason, CLAUDE_STOP_REASONS);
  const status = typeof result?.api_error_status === "number" && Number.isInteger(result.api_error_status) &&
    result.api_error_status >= 100 && result.api_error_status <= 599 ? result.api_error_status : null;
  const duration = boundedCount(result?.duration_ms);
  const reason = diagnostic.terminalReason, subtype = diagnostic.resultSubtype;
  const category: ClaudeFailureCategory =
    subtype === "error_max_turns" || reason === "max_turns" ? "turnLimit"
    : reason === "prompt_too_long" || stop === "model_context_window_exceeded" ? "inputTooLarge"
    : reason === "blocking_limit" || reason === "rapid_refill_breaker" || status === 429 ? "rateLimited"
    : status === 401 || status === 403 ? "authentication"
    : reason === "api_error" || (status !== null && status >= 400) ? "providerApiError"
    : reason === "model_error" ? "modelError"
    : reason === "malformed_tool_use_exhausted" ? "malformedToolUse"
    : subtype === "error_max_structured_output_retries" || reason === "structured_output_retry_exhausted" ? "structuredOutput"
    : subtype === "error_max_budget_usd" || reason === "budget_exhausted" ? "budget"
    : reason === "hook_stopped" || reason === "stop_hook_prevented" ? "hookStopped"
    : reason === "aborted_streaming" || reason === "aborted_tools" ? "aborted"
    : "providerError";
  const fields = [`subtype=${subtype}`, `terminal_reason=${reason}`, `stop_reason=${stop}`, `is_error=${diagnostic.isError ?? "missing"}`,
    `num_turns=${diagnostic.internalTurnCount ?? "missing"}`, ...(maxTurns === undefined ? [] : [`max_turns=${maxTurns}`]),
    `api_error_status=${status ?? "none"}`, ...(duration === null ? [] : [`duration_ms=${duration}`]),
    `exit_code=${diagnostic.processExitCode ?? "none"}`];
  return Object.freeze({ category, detail: `${CATEGORY_TEXT[category]} [${fields.join(" ")}]` });
}
