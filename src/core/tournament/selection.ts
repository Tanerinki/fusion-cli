import type { Decision } from "../evidence/obligations.js";
import type { CandidateId, TournamentOutcome } from "./contracts.js";

/**
 * v0.5 — EVIDENCE-BASED SELECTION. No confidence score, no vote, no model preference. A candidate is:
 *
 *   1. ELIMINATED by Fusion's own evidence, in this order of reasons:
 *      - a security violation stops the whole tournament (no candidate is selected at all);
 *      - a failed proof obligation (its v0.4 decision is BLOCKED): safety or correctness;
 *      - a deterministic contradiction by one of Fusion's experiments (a probe, a property or fuzz run);
 *      - an incomplete common profile (a required check has no result);
 *      - a required falsification that did not end clean;
 *      - any other decision than VERIFIED (not deliverable).
 *   2. Among the remaining VERIFIED candidates: if they all made the same change (identical host ChangeSets) they CONVERGED —
 *      that change is selected, and the convergence is recorded (information, never proof).
 *   3. Otherwise by DOMINANCE over host-observed dimensions only — lower is better on each:
 *      - mutations Fusion's checks did not detect (compared only when every candidate had at least one mutation run);
 *      - a new dependency (1) or none (0);
 *      - changed files; changed lines.
 *      A dominates B when A is no worse on every dimension and better on at least one. One undominated candidate is selected;
 *      several undominated candidates are a TIE — MULTIPLE_VERIFIED_CANDIDATES, a human decision. No model breaks a tie.
 */
export interface CandidateFacts {
  readonly id: CandidateId;
  /** The candidate manifest's SHA-256 (its exact revision). */
  readonly revision: string;
  /** Canonical SHA-256 of the host ChangeSet (identical changes converge). */
  readonly patchSha256: string;
  /** `failed`: its author's turn or its materialization failed; nothing about its correctness is known. */
  readonly failed: boolean;
  readonly securityViolation: boolean;
  /** The v0.4 decision under the frozen profile (with Fusion's experiments as checks); undefined when it never got one. */
  readonly decision?: Decision;
  readonly deliverable: boolean;
  /** Failed safety or correctness obligations (kinds), when BLOCKED. */
  readonly failedObligations: readonly string[];
  /** Fusion experiments that contradicted it (ids). */
  readonly contradictions: readonly string[];
  readonly profileComplete: boolean;
  readonly falsification: "notRequired" | "clean" | "failed";
  readonly mutation: Readonly<{ run: number; survived: number }>;
  readonly newDependency: boolean;
  readonly changedFiles: number;
  /** Lines added and removed, as Fusion diffed them against the baseline; `null` when it could not read every file exactly. */
  readonly changedLines: number | null;
}
export type Elimination = Readonly<{ id: CandidateId; reason: string }>;
export type Dimension = "undetectedMutations" | "newDependency" | "changedFiles" | "changedLines";
export type Selection =
  | Readonly<{ kind: "selected"; winner: CandidateId; converged: readonly CandidateId[]; reasons: readonly string[];
      eliminated: readonly Elimination[]; dominated: readonly Readonly<{ id: CandidateId; by: CandidateId; dimensions: readonly Dimension[] }>[] }>
  | Readonly<{ kind: "tie"; candidates: readonly CandidateId[]; differences: readonly string[]; eliminated: readonly Elimination[];
      dominated: readonly Readonly<{ id: CandidateId; by: CandidateId; dimensions: readonly Dimension[] }>[] }>
  | Readonly<{ kind: "none"; outcome: TournamentOutcome; eliminated: readonly Elimination[] }>;

function eliminationOf(c: CandidateFacts): string | undefined {
  if (c.failed) return "its author's turn or its materialization failed: nothing is known about it";
  if (c.decision === "BLOCKED") return `failed obligation(s): ${c.failedObligations.join(", ") || "BLOCKED"}`;
  if (c.contradictions.length > 0) return `contradicted by Fusion's experiment(s): ${c.contradictions.join(", ")}`;
  if (!c.profileComplete) return "the common verification profile did not complete for it";
  if (c.falsification === "failed") return "the required falsification did not end clean";
  if (c.decision !== "VERIFIED" || !c.deliverable) return `not verified (${c.decision ?? "no decision"})`;
  return undefined;
}
function dimensions(c: CandidateFacts, mutationComparable: boolean): Readonly<Record<Dimension, number | undefined>> {
  return { undetectedMutations: mutationComparable ? c.mutation.survived : undefined, newDependency: c.newDependency ? 1 : 0,
    changedFiles: c.changedFiles, changedLines: c.changedLines ?? undefined };
}
const DIMENSIONS: readonly Dimension[] = ["undetectedMutations", "newDependency", "changedFiles", "changedLines"];
/** The dimensions on which `a` is strictly better, when `a` dominates `b`; undefined otherwise. */
function dominates(a: Readonly<Record<Dimension, number | undefined>>, b: Readonly<Record<Dimension, number | undefined>>): Dimension[] | undefined {
  const better: Dimension[] = [];
  for (const d of DIMENSIONS) {
    const x = a[d], y = b[d];
    if (x === undefined || y === undefined) continue;
    if (x > y) return undefined;
    if (x < y) better.push(d);
  }
  return better.length > 0 ? better : undefined;
}

export function selectCandidate(candidates: readonly CandidateFacts[]): Selection {
  const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const eliminated: Elimination[] = [];
  if (sorted.some(c => c.securityViolation))
    return Object.freeze({ kind: "none", outcome: "CANDIDATE_SECURITY_VIOLATION",
      eliminated: Object.freeze(sorted.filter(c => c.securityViolation).map(c => ({ id: c.id, reason: "a security violation stopped the tournament" }))) });
  const eligible: CandidateFacts[] = [];
  for (const c of sorted) {
    const reason = eliminationOf(c);
    if (reason === undefined) eligible.push(c); else eliminated.push(Object.freeze({ id: c.id, reason }));
  }
  if (eligible.length === 0) {
    const all = (test: (c: CandidateFacts) => boolean) => sorted.length > 0 && sorted.every(test);
    const outcome: TournamentOutcome = all(c => c.failed) ? "PROVIDER_FAILURE" : all(c => !c.failed && !c.profileComplete) ? "VERIFICATION_PROFILE_FAILED"
      : all(c => !c.failed && c.falsification === "failed") ? "FALSIFICATION_REQUIRED_FAILED" : "NO_VERIFIED_CANDIDATE";
    return Object.freeze({ kind: "none", outcome, eliminated: Object.freeze(eliminated) });
  }
  if (new Set(eligible.map(c => c.patchSha256)).size === 1) {
    const winner = eligible[0]!;
    return Object.freeze({ kind: "selected", winner: winner.id, converged: Object.freeze(eligible.map(c => c.id)),
      reasons: Object.freeze([eligible.length > 1 ? `${eligible.map(c => c.id).join(" and ")} made the identical change (converged); it is verified`
        : `${winner.id} is the only candidate Fusion verified`]), eliminated: Object.freeze(eliminated), dominated: Object.freeze([]) });
  }
  const mutationComparable = eligible.every(c => c.mutation.run > 0);
  const dims = new Map(eligible.map(c => [c.id, dimensions(c, mutationComparable)]));
  const dominated: Array<{ id: CandidateId; by: CandidateId; dimensions: readonly Dimension[] }> = [];
  for (const c of eligible) for (const other of eligible) {
    if (other.id === c.id || dominated.some(d => d.id === c.id)) continue;
    const better = dominates(dims.get(other.id)!, dims.get(c.id)!);
    if (better !== undefined) dominated.push({ id: c.id, by: other.id, dimensions: Object.freeze(better) });
  }
  const front = eligible.filter(c => !dominated.some(d => d.id === c.id));
  if (front.length === 1) {
    const winner = front[0]!;
    const reasons = dominated.map(d => `${d.by} dominates ${d.id} by Fusion's evidence: ${d.dimensions.map(describe).join(", ")}`);
    return Object.freeze({ kind: "selected", winner: winner.id, converged: Object.freeze([]),
      reasons: Object.freeze([...eliminated.map(e => `${e.id} eliminated: ${e.reason}`), ...reasons]),
      eliminated: Object.freeze(eliminated), dominated: Object.freeze(dominated.map(d => Object.freeze(d))) });
  }
  const differences = DIMENSIONS.flatMap(d => {
    const values = front.map(c => `${c.id}=${dims.get(c.id)![d] ?? "n/a"}`);
    return new Set(front.map(c => dims.get(c.id)![d])).size > 1 ? [`${describe(d)}: ${values.join(", ")}`] : [];
  });
  return Object.freeze({ kind: "tie", candidates: Object.freeze(front.map(c => c.id)),
    differences: Object.freeze(differences.length > 0 ? differences : ["no host-observed difference"]), eliminated: Object.freeze(eliminated),
    dominated: Object.freeze(dominated.map(d => Object.freeze(d))) });
}
function describe(d: Dimension): string {
  return d === "undetectedMutations" ? "fewer mutations its checks did not detect" : d === "newDependency" ? "no new dependency"
    : d === "changedFiles" ? "fewer changed files" : "fewer changed lines";
}
