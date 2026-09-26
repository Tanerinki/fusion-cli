import type { FusionError } from "../core/domain.js";
import type { PendingStage, WorkflowResult } from "../core/workflow/types.js";
import { EXIT_CODES, presentFailure } from "../cli/failure-presentation.js";
import { REAL_WRITER_MODE_NOT_READY } from "./writer-gate.js";

/**
 * What a user sees. `ANSWERED` and `COMPLETED` are the only finished states; `COMPLETED` alone means Fusion's
 * required verification (and every required review gate) passed. The three `*_REQUIRED` states mean work remains.
 */
export const DISPLAY_STATES = ["ANSWERED", "COMPLETED", "REVIEW_REQUIRED", "DECISION_REQUIRED", "HUMAN_GATE_REQUIRED",
  "FAILED", "CANCELLED", "TIMED_OUT", "BLOCKED"] as const;
export type DisplayState = (typeof DISPLAY_STATES)[number];
export const UNFINISHED_STATES: ReadonlySet<DisplayState> = new Set(["REVIEW_REQUIRED", "DECISION_REQUIRED", "HUMAN_GATE_REQUIRED"]);

export interface CommandOutcome {
  readonly state: DisplayState;
  readonly exitCode: number;
  /** Stable machine-readable reason, e.g. `REAL_WRITER_MODE_NOT_READY` or the typed error kind. */
  readonly code: string;
  readonly message: string;
  readonly pendingStage?: PendingStage;
  readonly error?: FusionError;
}

const POLICY_KINDS = new Set(["CapabilityUnavailable", "BillingBlocked", "AuthMismatch"]);

/** Maps a terminal workflow result to exactly one user-visible state; unfinished work is never reported as done. */
export function outcomeOf(result: WorkflowResult): CommandOutcome {
  const pending = result.pendingStage === undefined ? {} : { pendingStage: result.pendingStage };
  switch (result.state) {
    case "completed":
      return { state: "COMPLETED", exitCode: EXIT_CODES.success, code: "completed",
        message: "Completed: Fusion verification and every required review gate passed." };
    case "answered":
      return { state: "ANSWERED", exitCode: EXIT_CODES.success, code: "answered",
        message: "Answered: a read-only result without authoritative verification; nothing was verified or changed." };
    case "reviewRequired":
      return { state: "REVIEW_REQUIRED", exitCode: EXIT_CODES.reviewRequired, code: result.error?.kind ?? "reviewRequired", ...pending,
        ...(result.error ? { error: result.error } : {}),
        message: "Not finished: a fresh review is still required and Fusion could not run it." };
    case "decisionRequired":
      return { state: "DECISION_REQUIRED", exitCode: EXIT_CODES.decisionRequired, code: "decisionRequired", ...pending,
        ...(result.error ? { error: result.error } : {}),
        message: "Not finished: a Lead or human decision is required before this work can continue." };
    case "humanGateRequired":
      return { state: "HUMAN_GATE_REQUIRED", exitCode: EXIT_CODES.humanGateRequired, code: "humanGateRequired", ...pending,
        message: "Not finished: a human must approve before any autonomous work continues." };
    case "cancelled":
      return { state: "CANCELLED", exitCode: EXIT_CODES.cancelled, code: "Cancelled", message: "Cancelled: no result was accepted.",
        ...(result.error ? { error: result.error } : {}) };
    case "failed":
      return failedOutcome(result.error ?? { kind: "InternalError", retryable: false, safeMessage: "The run failed." },
        result.transitions.at(-1)?.reason === "policyFailure");
  }
}

/** A typed failure as an outcome: timeouts and routing/billing refusals get their own states. */
export function failedOutcome(error: FusionError, policyRefusal = POLICY_KINDS.has(error.kind)): CommandOutcome {
  const exitCode = presentFailure(error).exitCode;
  if (error.kind === "Timeout") return { state: "TIMED_OUT", exitCode, code: "Timeout", message: error.safeMessage, error };
  if (error.kind === "Cancelled") return { state: "CANCELLED", exitCode, code: "Cancelled", message: error.safeMessage, error };
  if (policyRefusal && POLICY_KINDS.has(error.kind)) return { state: "BLOCKED", exitCode, code: error.kind, message: error.safeMessage, error };
  return { state: "FAILED", exitCode, code: error.kind, message: error.safeMessage, error };
}

export function writerBlockedOutcome(): CommandOutcome {
  return { state: "BLOCKED", exitCode: EXIT_CODES.blocked, code: REAL_WRITER_MODE_NOT_READY,
    message: "This task needs a Writer build, which a human must confirm at an interactive terminal (fusion build asks for it). " +
      "No provider was started and nothing was changed." };
}
/** v0.1: a build refused before any model turn because Fusion cannot verify its result in confinement. */
export function verificationUnavailableOutcome(reason: string): CommandOutcome {
  return { state: "BLOCKED", exitCode: EXIT_CODES.blocked, code: "verificationUnavailable",
    message: `${reason} No provider was started and nothing was changed.` };
}
