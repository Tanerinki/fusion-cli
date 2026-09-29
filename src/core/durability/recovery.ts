import type { RecoveryClass } from "./states.js";

/**
 * v0.6 — RECOVERY CLASSIFICATION (§32), pure. An interrupted operation is classified from its ACTUAL semantics, never
 * optimistically. The cardinal rule: an operation is auto-resumable only when its class is proven SAFE; `UNKNOWN` is the
 * honest default and never becomes safe automatically (that is enforced by `isAutoResumable` in states.ts).
 *
 * The classifier is a pure function of typed, host-observed facts about the interrupted operation — never a model claim.
 */

/** Whether the operation only reads / observes, or whether it has (or may have) an external or filesystem side effect. */
export type OperationEffect = "readOnly" | "sideEffecting";

export interface InterruptedOperation {
  /** Does the operation mutate anything outside disposable Fusion-owned state, or is it a pure read/verify? */
  readonly effect: OperationEffect;
  /** True only when Fusion has a DURABLE record that this exact operation intent already completed. */
  readonly durableCompletionRecord: boolean;
  /** True when the operation carries a stable idempotency key bound to its intent (safe to resume exactly once). */
  readonly hasIdempotencyKey: boolean;
  /** True when evidence the operation rests on was observed against a state that may have since changed. */
  readonly evidenceStale: boolean;
  /** True when a foreign/external modification was detected that Fusion did not make. */
  readonly foreignModification: boolean;
  /** True when corruption or a security violation was detected for this operation. */
  readonly corruptionOrViolation: boolean;
}

/**
 * Classifies an interrupted operation. Precedence, most dominant first:
 *  1. corruption / security violation  → BLOCKED (never resumed).
 *  2. foreign modification             → REQUIRES_HUMAN.
 *  3. a durable completion record       → SAFE_TO_REPLAY for a read-only op (idempotent), SAFE_TO_RESUME for a
 *                                          side-effecting op that also has an idempotency key (return the recorded result).
 *  4. stale evidence                    → REQUIRES_REVALIDATION.
 *  5. a read-only op with no side effect → SAFE_TO_REPLAY.
 *  6. a side-effecting op with an idempotency key and no ambiguity → SAFE_TO_RESUME.
 *  7. anything else (ambiguous side effect) → REQUIRES_HUMAN.
 * An operation whose facts cannot be established stays UNKNOWN (never auto-resumed) — express that by passing an
 * operation whose side effect is ambiguous; the classifier will not invent safety.
 */
export function classifyInterrupted(op: InterruptedOperation): RecoveryClass {
  if (op.corruptionOrViolation) return "BLOCKED";
  if (op.foreignModification) return "REQUIRES_HUMAN";
  if (op.durableCompletionRecord) {
    if (op.effect === "readOnly") return "SAFE_TO_REPLAY";
    return op.hasIdempotencyKey ? "SAFE_TO_RESUME" : "REQUIRES_HUMAN";
  }
  if (op.evidenceStale) return "REQUIRES_REVALIDATION";
  if (op.effect === "readOnly") return "SAFE_TO_REPLAY";
  if (op.hasIdempotencyKey) return "SAFE_TO_RESUME";
  return "REQUIRES_HUMAN";
}
