import { failWith } from "../../core/errors.js";

/**
 * Generic, backend-neutral record of what a confined verification backend OBSERVED. The O5.5B3 `ConfinementProof`
 * fact set was shaped for a Windows helper (registry, profile); forcing another mechanism into it would either leave
 * facts meaningless or stretch them. Here each backend names its own NARROW facts — `networkModeNoneObserved`, never a
 * universal `networkIsolation` — so a claim cannot outgrow its evidence. Evidence is observation, not acceptance:
 * `productionEligible` is the constant `false`, and nothing here reads or changes readiness.
 */
export const BACKEND_EVIDENCE_VERSION = 1;
/** Who made the observation: the container engine's own metadata, the guest probe, or the host. */
export type BackendEvidenceSource = "daemon" | "guest" | "host";
/** Same meaning as the proof contract's states, kept separate so this module stays independent of that contract. */
export type BackendFactState = "observedPass" | "observedFail" | "notObserved";
export const BACKEND_EVIDENCE_LIMITS = Object.freeze({ maxFacts: 128, maxAttempts: 1_000_000 });

export interface BackendEvidenceFact {
  readonly fact: string;
  readonly source: BackendEvidenceSource;
  readonly state: BackendFactState;
  readonly attempts: number;
  readonly failures: number;
}
export interface BackendEvidence {
  readonly schemaVersion: typeof BACKEND_EVIDENCE_VERSION;
  readonly backendId: string;
  readonly facts: readonly BackendEvidenceFact[];
  readonly productionEligible: false;
}
export interface BackendEvidenceEvaluation {
  /** Every required fact is present exactly once and `observedPass`. */
  readonly complete: boolean;
  readonly passed: readonly string[];
  readonly failed: readonly string[];
  readonly notObserved: readonly string[];
  /** Required facts the evidence does not mention at all. */
  readonly missing: readonly string[];
  readonly productionEligible: false;
}

const FACT_NAME = /^[a-z][A-Za-z0-9]{2,63}$/u;
const SOURCES = new Set<unknown>(["daemon", "guest", "host"]);

/**
 * One fact with a state derived from its counts, so the state can never contradict them: no attempt is
 * `notObserved`, any failure is `observedFail`, and only attempts without failure are `observedPass`.
 */
export function observedFact(fact: string, source: BackendEvidenceSource, attempts: number, failures: number): BackendEvidenceFact {
  if (!FACT_NAME.test(fact) || !SOURCES.has(source) || !Number.isSafeInteger(attempts) || !Number.isSafeInteger(failures) ||
      attempts < 0 || failures < 0 || failures > attempts || attempts > BACKEND_EVIDENCE_LIMITS.maxAttempts)
    failWith("InvalidInput", "Backend evidence fact is invalid.");
  const state: BackendFactState = attempts === 0 ? "notObserved" : failures > 0 ? "observedFail" : "observedPass";
  return Object.freeze({ fact, source, state, attempts, failures });
}
/** A single yes/no observation. */
export function checkFact(fact: string, source: BackendEvidenceSource, holds: boolean): BackendEvidenceFact {
  return observedFact(fact, source, 1, holds ? 0 : 1);
}
export function unobservedFact(fact: string, source: BackendEvidenceSource): BackendEvidenceFact {
  return observedFact(fact, source, 0, 0);
}

export function backendEvidence(backendId: string, facts: readonly BackendEvidenceFact[]): BackendEvidence {
  if (facts.length > BACKEND_EVIDENCE_LIMITS.maxFacts) failWith("InvalidInput", "Backend evidence has too many facts.");
  return Object.freeze({ schemaVersion: BACKEND_EVIDENCE_VERSION, backendId, facts: Object.freeze([...facts]),
    productionEligible: false });
}

/** Completeness against a caller-pinned required set. A duplicated fact is contradictory and counts as failed. */
export function evaluateBackendEvidence(evidence: BackendEvidence, required: readonly string[]): BackendEvidenceEvaluation {
  const byFact = new Map<string, BackendEvidenceFact[]>();
  for (const fact of evidence.facts) byFact.set(fact.fact, [...(byFact.get(fact.fact) ?? []), fact]);
  const passed: string[] = [], failed: string[] = [], notObserved: string[] = [], missing: string[] = [];
  for (const name of required) {
    const entries = byFact.get(name);
    if (entries === undefined) missing.push(name);
    else if (entries.length !== 1 || entries[0]!.state === "observedFail") failed.push(name);
    else if (entries[0]!.state === "notObserved") notObserved.push(name);
    else passed.push(name);
  }
  return Object.freeze({ complete: required.length > 0 && passed.length === required.length,
    passed: Object.freeze(passed), failed: Object.freeze(failed), notObserved: Object.freeze(notObserved),
    missing: Object.freeze(missing), productionEligible: false });
}
