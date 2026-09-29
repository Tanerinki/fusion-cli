import { riskRank, type RiskLevel } from "../policy/risk.js";
import type { TaskClass } from "../evidence/obligations.js";
import { TOURNAMENT_LIMITS } from "./contracts.js";

/**
 * v0.5 — WHEN TO RUN A TOURNAMENT: an explicit, host-owned policy (versioned code, never learned online). Simple, obvious or
 * low-value work stays one candidate; a tournament is started where alternative solutions can add evidence Fusion can check.
 *
 * - Never for read-only work, and never for a critical task (it stops at the human gate before any candidate exists).
 * - ELIGIBLE when there is something to compare: risk at least medium, a security-sensitive task, a diagnosis with competing
 *   explanations, or an earlier attempt at this task that failed.
 * - STARTED by the policy for an eligible fix or refactor (2 candidates). A plain change (a feature) stays single unless the
 *   human asks: without a reproduced defect, alternatives are harder to compare.
 * - A HUMAN may ask for 1–3 candidates (`--candidates`); more is refused as over budget, before any model turn.
 * - A MODEL's advice is only advice: it may start the default tournament for an eligible task the policy would keep single,
 *   never more candidates, never for an ineligible task, and never fewer than the policy chose.
 */
export const TOURNAMENT_POLICY_VERSION = "v0.5-route-1";
export interface RouteFacts {
  readonly writer: boolean;
  readonly taskClass: TaskClass;
  readonly sensitive: boolean;
  readonly risk: RiskLevel;
  /** Competing explanations of a diagnosis this fix rests on. */
  readonly alternatives: number;
  /** An earlier attempt at the same task failed or ended without a verified change. */
  readonly priorFailure: boolean;
}
export interface RouteRequest {
  /** A human's explicit candidate count. */
  readonly requested?: number;
  /** A model's recommendation — advice, recorded, never authority. */
  readonly advice?: "tournament" | "single";
  /** The repository owner's candidate budget (1-3): it caps the policy and bounds what a human may ask for. */
  readonly cap?: number;
}
export type TournamentRoute = Readonly<{
  route: "single" | "tournament";
  candidates: number;
  eligible: boolean;
  source: "policy" | "human" | "advice";
  reasons: readonly string[];
}>;
export class TournamentBudgetRefused extends Error {
  constructor(readonly requested: number, readonly cap: number = TOURNAMENT_LIMITS.maxCandidates) {
    super(cap < TOURNAMENT_LIMITS.maxCandidates
      ? `This repository allows at most ${cap} candidate${cap === 1 ? "" : "s"} (limits.maxCandidates); ${requested} were asked for.`
      : `A tournament has at most ${TOURNAMENT_LIMITS.maxCandidates} candidates; ${requested} were asked for.`);
  }
}

export function tournamentRoute(facts: RouteFacts, request: RouteRequest = {}): TournamentRoute {
  const reasons: string[] = [];
  const cap = request.cap ?? TOURNAMENT_LIMITS.maxCandidates;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > TOURNAMENT_LIMITS.maxCandidates) throw new RangeError("The candidate budget must be 1-3.");
  if (request.requested !== undefined && (!Number.isSafeInteger(request.requested) || request.requested < 1 ||
      request.requested > cap)) throw new TournamentBudgetRefused(request.requested, cap);
  if (!facts.writer || facts.risk === "critical") {
    reasons.push(!facts.writer ? "not a change: nothing to compare" : "critical: the human gate comes first");
    return Object.freeze({ route: "single", candidates: 1, eligible: false, source: "policy", reasons: Object.freeze(reasons) });
  }
  if (riskRank(facts.risk) >= riskRank("medium")) reasons.push(`risk ${facts.risk}`);
  if (facts.sensitive) reasons.push("security-sensitive");
  if (facts.alternatives >= 2) reasons.push(`${facts.alternatives} competing explanations`);
  if (facts.priorFailure) reasons.push("an earlier attempt failed");
  const eligible = reasons.length > 0;
  const policy = eligible && facts.taskClass !== "change";
  if (request.requested !== undefined) {
    const n = request.requested;
    return Object.freeze({ route: n > 1 ? "tournament" : "single", candidates: n, eligible, source: "human",
      reasons: Object.freeze([...reasons, `the human asked for ${n} candidate${n === 1 ? "" : "s"}`]) });
  }
  const budgeted = Math.min(TOURNAMENT_LIMITS.defaultCandidates, cap);
  if ((policy || (eligible && request.advice === "tournament")) && budgeted === 1) {
    reasons.push("the repository's budget allows one candidate (limits.maxCandidates)");
    return Object.freeze({ route: "single", candidates: 1, eligible, source: "policy", reasons: Object.freeze(reasons) });
  }
  if (policy) return Object.freeze({ route: "tournament", candidates: budgeted, eligible, source: "policy",
    reasons: Object.freeze(reasons) });
  if (eligible && request.advice === "tournament")
    return Object.freeze({ route: "tournament", candidates: budgeted, eligible, source: "advice",
      reasons: Object.freeze([...reasons, "a model recommended comparing solutions (advice within the policy's bounds)"]) });
  if (!eligible) reasons.push("low risk with nothing to compare: one candidate");
  else reasons.push("a plain change: one candidate unless the human asks");
  return Object.freeze({ route: "single", candidates: 1, eligible, source: "policy", reasons: Object.freeze(reasons) });
}
