/**
 * v0.5 — THE CANDIDATE TOURNAMENT'S CONTRACTS: budgets, the candidate lifecycle and the tournament's outcomes.
 *
 * A tournament is not a collection of chat turns. It is typed state that only Fusion advances: a model proposes a candidate
 * (a ChangeSet), Fusion materializes it in its own private candidate, verifies it against a profile frozen before any result
 * existed, runs its own experiments, and selects only when its own evidence justifies it — or reports a tie. No transition is
 * ever inferred from a model's words.
 */

/** Hard limits. No role can raise them; a request beyond them is refused before any model turn. */
export const TOURNAMENT_LIMITS = Object.freeze({
  /** Candidates of a tournament the policy starts; a human may ask for up to `maxCandidates`. */
  defaultCandidates: 2,
  maxCandidates: 3,
  /** Candidate generations running at the same time. */
  maxParallel: 2,
  /** One batch of Fusion's experiments per tournament (no loop until something passes). */
  experimentBatches: 1,
  /** Probes, property and fuzz runs: together at most 8 commands, the bound of one confined run. */
  maxProbes: 4,
  maxPropertyRuns: 2,
  maxPropertyCases: 200,
  maxFuzzRuns: 2,
  maxFuzzCases: 500,
  /** Fusion-owned mutations per candidate (each one confined verification run). */
  maxMutationsPerCandidate: 3,
  /** Lines of a file Fusion diffs to derive mutations; a larger file is not mutated (said so). */
  mutationMaxLines: 4_000,
  /** Fresh reconstruction and revalidation of the selected candidate: exactly once. */
  revalidations: 1,
  /** A failing property or fuzz case kept as a replayable reproducer (bounded, redacted). */
  reproducerChars: 1_000,
  /** Candidate ids are fixed labels: `c1`…`c3`. */
  candidateIds: Object.freeze(["c1", "c2", "c3"] as const),
});
export type CandidateId = (typeof TOURNAMENT_LIMITS.candidateIds)[number];
export const isCandidateId = (value: unknown): value is CandidateId =>
  (TOURNAMENT_LIMITS.candidateIds as readonly unknown[]).includes(value);

/**
 * A candidate's lifecycle. `failed`: its author's turn or its materialization failed (no evidence either way); `rejected`:
 * Fusion's own evidence rules it out; `tied`: verified and not dominated, with another verified candidate equally so.
 */
export const CANDIDATE_STATES = ["proposed", "materialized", "verified", "unverified", "rejected", "failed", "survivor",
  "selected", "notSelected", "tied", "revalidated", "deliveryEligible"] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];
const TRANSITIONS: Readonly<Record<CandidateState, readonly CandidateState[]>> = Object.freeze({
  proposed: ["materialized", "failed", "rejected"],
  materialized: ["verified", "unverified", "rejected", "failed"],
  verified: ["survivor", "rejected"],
  unverified: [],
  rejected: [],
  failed: [],
  survivor: ["selected", "notSelected", "tied", "rejected"],
  tied: ["selected", "notSelected"],
  selected: ["revalidated", "rejected"],
  notSelected: [],
  revalidated: ["deliveryEligible"],
  deliveryEligible: [],
});
export class IllegalCandidateTransition extends Error {
  constructor(readonly from: CandidateState, readonly to: CandidateState) { super(`A candidate cannot move from ${from} to ${to}.`); }
}
/** The only way a candidate's state changes: an allowed transition, or an error (never silently). */
export function advance(from: CandidateState, to: CandidateState): CandidateState {
  if (!TRANSITIONS[from].includes(to)) throw new IllegalCandidateTransition(from, to);
  return to;
}
export const allowedTransitions = (from: CandidateState): readonly CandidateState[] => TRANSITIONS[from];

/** How a tournament ended. Never collapsed into "failed". */
export const TOURNAMENT_OUTCOMES = [
  "DELIVERY_ELIGIBLE", "NO_VERIFIED_CANDIDATE", "MULTIPLE_VERIFIED_CANDIDATES", "TOURNAMENT_BUDGET_EXHAUSTED",
  "CANDIDATE_SECURITY_VIOLATION", "VERIFICATION_PROFILE_FAILED", "DISCRIMINATOR_INCONCLUSIVE", "FALSIFICATION_REQUIRED_FAILED", "REVALIDATION_MISMATCH",
  "PROVIDER_FAILURE", "CANDIDATE_MATERIALIZATION_FAILED", "CANCELLED",
  // A candidate's author asked the human a question, or its run reached the human gate: the whole tournament stops for the
  // human — no sibling is selected on an assumption the human never made.
  "DECISION_REQUESTED", "HUMAN_GATE_REQUIRED",
] as const;
export type TournamentOutcome = (typeof TOURNAMENT_OUTCOMES)[number];

/**
 * How independent the candidates' generation was — stated, never inflated: separate contexts (always), separate provider
 * bindings, or separate models. Separate contexts alone are not model diversity.
 */
export type Independence = "separateContext" | "separateProvider" | "separateModel";
export function independenceOf(bindings: readonly Readonly<{ provider: string; model: string }>[]): Independence {
  const providers = new Set(bindings.map(b => b.provider)), models = new Set(bindings.map(b => `${b.provider}/${b.model}`));
  return bindings.length > 1 && models.size === bindings.length ? providers.size === bindings.length ? "separateProvider" : "separateModel"
    : "separateContext";
}
