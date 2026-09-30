import { canonicalJson, sha256Hex } from "../delivery/canonical.js";
import { failWith } from "../errors.js";

/**
 * v0.6 I8 — the EXACT, OBJECT-BOUND HUMAN GATE (pure). When a run stops for a human, the thing the human is asked to
 * approve is captured as a bounded, canonical OBJECT and hashed. The hash is persisted with the gate (a durable
 * milestone), so a resume after a restart re-presents PRECISELY that gate: a resume that re-derives a different object
 * (a changed task, a different decision, another gate reason) hashes differently and is refused — a human can never
 * approve one thing while Fusion proceeds with another.
 *
 * The object binds the WORK (task digest), the gate reason and the structured decision request — NOT the ephemeral run
 * id, so the SAME pending gate has the same identity whether it is re-presented under its original run or a resumed one.
 * It carries only bounded, typed facts (a task DIGEST, a reason label, the structured request) — never raw task or
 * provider text.
 */
export const HUMAN_GATE_BINDING_VERSION = 1 as const;

/** The exact, bounded object a human is asked to approve at a gate. */
export interface HumanGateObject {
  /** SHA-256 of the run's full task text (identity of the work), or null when the run had no task. */
  readonly taskSha256: string | null;
  /** The stage the run stopped at — always `"humanGate"` for a human gate. */
  readonly pendingStage: string;
  /** The gate reason label (the outcome code), e.g. `humanGateRequired` / `dependencyApprovalRequired`. */
  readonly reason: string;
  /** The structured decision request bound to the gate, or null when the gate carries none. */
  readonly decision: unknown;
}

/** The canonical hash of a gate object — the durable identity of exactly what the human must approve. */
export function humanGateObjectHash(object: HumanGateObject): string {
  return sha256Hex(canonicalJson({ v: HUMAN_GATE_BINDING_VERSION, taskSha256: object.taskSha256 ?? null,
    pendingStage: object.pendingStage, reason: object.reason, decision: object.decision ?? null }));
}

/** The durable, hash-bound record of a pending gate: its reason label and the object hash. */
export interface HumanGateBinding {
  readonly reason: string;
  readonly objectHash: string;
}

/** Builds the durable binding for a gate object (reason + object hash). */
export function humanGateBinding(object: HumanGateObject): HumanGateBinding {
  return Object.freeze({ reason: object.reason, objectHash: humanGateObjectHash(object) });
}

/**
 * Verifies a resume is about EXACTLY the pending gate. The reason and the object hash must both match what was durably
 * recorded; any difference is a security stop (the object changed since the gate was recorded), never silently proceeded.
 */
export function assertHumanGateUnchanged(persisted: HumanGateBinding, current: HumanGateBinding): void {
  if (persisted.reason !== current.reason || persisted.objectHash !== current.objectHash)
    failWith("SecurityViolation",
      "The pending human gate does not match what was recorded — the object to approve changed since the gate was raised.");
}
