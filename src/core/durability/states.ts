import { failWith } from "../errors.js";

/**
 * v0.6 — DURABLE EXECUTION & RECOVERY contracts (pure). These are the closed label sets and the small state machines the
 * durability half of v0.6 is built on. They are deliberately provider- and platform-neutral and carry no I/O: the journal,
 * checkpoints, single-writer lease, recovery planner and recoverable apply (later PRs) all speak in these terms.
 *
 * Guiding rules (sections 32, 47, 50, 60): UNKNOWN never becomes safe automatically; a security violation is causally
 * dominant over cancellation noise; states are never collapsed into a generic "failed"; and language stays precise —
 * "idempotent intent", "single-use claim", "durable completion record", never "exactly once everywhere".
 */

/** A durable run's observable state (section 53/60). Derived from the journal, never set optimistically. */
export const DURABLE_RUN_STATES = Object.freeze(["RUNNING", "INTERRUPTED", "RECOVERY_REQUIRED", "COMPLETED", "BLOCKED"] as const);
export type DurableRunState = (typeof DURABLE_RUN_STATES)[number];

/**
 * How an interrupted operation is classified from its actual semantics (section 32). `UNKNOWN` is the honest default and
 * is NEVER auto-promoted to a safe class — only `isAutoResumable` operations may continue without a human.
 */
export const RECOVERY_CLASSES = Object.freeze([
  "SAFE_TO_REPLAY",      // deterministic read-only verification; an idempotent host check
  "SAFE_TO_RESUME",      // an exact transactional step with durable idempotency state
  "REQUIRES_REVALIDATION", // stale verification/evidence must be re-established
  "REQUIRES_HUMAN",      // an ambiguous external or mutating side effect
  "BLOCKED",             // corruption or a security violation
  "UNKNOWN",             // not yet determined — never treated as safe
] as const);
export type RecoveryClass = (typeof RECOVERY_CLASSES)[number];

/** Only these two classes may resume without a human decision. Everything else stops (or must be revalidated first). */
export function isAutoResumable(cls: RecoveryClass): boolean {
  return cls === "SAFE_TO_REPLAY" || cls === "SAFE_TO_RESUME";
}

/**
 * Explicit RECOVERY-FAILURE / recovery-outcome states (section 60). Never collapsed to a generic failure. Some are
 * outcomes (TRANSACTION_COMMITTED), some are stops for a human (RECOVERY_REQUIRED, FOREIGN_MODIFICATION, RESUME_BLOCKED).
 */
export const RECOVERY_STATES = Object.freeze([
  "RUN_INTERRUPTED", "RUN_ALREADY_CLAIMED", "CHECKPOINT_INVALID", "JOURNAL_CORRUPT", "RECOVERY_REQUIRED",
  "FOREIGN_MODIFICATION", "TRANSACTION_INCOMPLETE", "TRANSACTION_COMMITTED", "TRANSACTION_ROLLED_BACK", "RESUME_BLOCKED",
] as const);
export type RecoveryState = (typeof RECOVERY_STATES)[number];

/**
 * The RECOVERABLE APPLY TRANSACTION states (section 37). Accurate terminology — this is a durable, recoverable, journaled
 * local apply with per-file staged writes, NOT full multi-file ACID (section 50). Every transition is durable.
 *
 *   PREPARED -> CLAIMED -> APPLYING -> VERIFYING -> COMMITTED
 *                                   -> ROLLBACK_REQUIRED -> ROLLING_BACK -> ROLLED_BACK
 *   (any point may stop at RECOVERY_REQUIRED; nothing before CLAIMED has written, so it ends FAILED)
 */
export const TRANSACTION_STATES = Object.freeze([
  "PREPARED", "CLAIMED", "APPLYING", "VERIFYING", "COMMITTED",
  "ROLLBACK_REQUIRED", "ROLLING_BACK", "ROLLED_BACK", "RECOVERY_REQUIRED", "FAILED",
] as const);
export type TransactionState = (typeof TRANSACTION_STATES)[number];

const TRANSACTION_NEXT: Readonly<Record<string, readonly TransactionState[]>> = Object.freeze({
  none: ["PREPARED"],
  PREPARED: ["CLAIMED", "FAILED"],
  CLAIMED: ["APPLYING", "RECOVERY_REQUIRED"],
  APPLYING: ["VERIFYING", "ROLLBACK_REQUIRED", "RECOVERY_REQUIRED"],
  VERIFYING: ["COMMITTED", "ROLLBACK_REQUIRED", "RECOVERY_REQUIRED"],
  ROLLBACK_REQUIRED: ["ROLLING_BACK", "RECOVERY_REQUIRED"],
  ROLLING_BACK: ["ROLLED_BACK", "RECOVERY_REQUIRED"],
  COMMITTED: [], ROLLED_BACK: [], FAILED: [], RECOVERY_REQUIRED: [],
});
export const TERMINAL_TRANSACTION_STATES: ReadonlySet<TransactionState> =
  new Set<TransactionState>(["COMMITTED", "ROLLED_BACK", "FAILED", "RECOVERY_REQUIRED"]);
/** Before CLAIMED nothing is written; from CLAIMED on the approval is spent, whatever follows. */
export const WROTE_ONCE_CLAIMED = (state: TransactionState): boolean =>
  state !== "PREPARED" && state !== "FAILED";

export function isTransactionTransitionAllowed(from: TransactionState | "none", to: TransactionState): boolean {
  return (TRANSACTION_NEXT[from] ?? []).includes(to);
}
/** The state a sequence of transaction transitions describes; an illegal step fails closed (the log is corrupt). */
export function transactionStateFromHistory(history: readonly TransactionState[]): TransactionState | "none" {
  let position: TransactionState | "none" = "none";
  for (const next of history) {
    if (!isTransactionTransitionAllowed(position, next)) failWith("SecurityViolation", `A transaction cannot move from ${position} to ${next}.`);
    position = next;
  }
  return position;
}

/**
 * The typed cause of a provider/candidate process ending (section 47). These are NEVER conflated. When more than one is
 * observed, `dominantTerminalCause` chooses by precedence: a security violation dominates a sandbox denial, which
 * dominates a host-crash recovery, a provider failure, a timeout, and — least dominant — a cancellation. This preserves
 * the established fatal-error precedence: a security violation is not masked by cancellation noise.
 */
export const TERMINAL_CAUSES = Object.freeze([
  "SECURITY_VIOLATION", "SANDBOX_DENIED", "HOST_CRASH_RECOVERY", "PROVIDER_FAILED", "TIMEOUT", "CANCELLED",
] as const);
export type TerminalCause = (typeof TERMINAL_CAUSES)[number];
/** Index 0 is most dominant. */
const CAUSE_PRECEDENCE: readonly TerminalCause[] = TERMINAL_CAUSES;

export function dominantTerminalCause(causes: readonly TerminalCause[]): TerminalCause | undefined {
  let best: TerminalCause | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const c of causes) {
    const rank = CAUSE_PRECEDENCE.indexOf(c);
    if (rank >= 0 && rank < bestRank) { bestRank = rank; best = c; }
  }
  return best;
}

/** Cleanup outcome for Fusion-owned disposable state (section 46). Cleanup failure never falsifies correctness state. */
export const CLEANUP_STATES = Object.freeze(["CLEANUP_COMPLETE", "CLEANUP_PENDING", "CLEANUP_FAILED"] as const);
export type CleanupState = (typeof CLEANUP_STATES)[number];
