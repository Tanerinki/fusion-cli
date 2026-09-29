import type { TaskClass } from "../evidence/obligations.js";
import { riskRank, type RiskLevel } from "../policy/risk.js";
import type { TournamentOutcome } from "./contracts.js";
import { TOURNAMENT_POLICY_VERSION, tournamentRoute, type RouteFacts } from "./route.js";

/**
 * v0.5 — OFFLINE ROUTING CALIBRATION. What past builds tell about the routing policy, computed offline from Fusion's own
 * records: labels and counts only (never task text, paths, provider text or source). It answers questions such as "if policy
 * B had run tournaments on these past task classes, how often would it have separated a candidate Fusion rejected from one it
 * verified?" — as an estimate with its sample, or "insufficient data". It never changes the routing: a policy change is a
 * versioned code change, reviewed like any other.
 */
export const ROUTING_RECORD_FORMAT = "fusion.routingRecord" as const;
export type OutcomeClass = "verified" | "decisionRequired" | "humanGate" | "failed" | "timedOut" | "cancelled" | "blocked";
export type SelectionClass = "onlyVerified" | "converged" | "dominance" | "humanChoice";
export interface RoutingRecord {
  readonly format: typeof ROUTING_RECORD_FORMAT;
  readonly version: 1;
  readonly policyVersion: string;
  readonly facts: Readonly<{ taskClass: TaskClass; sensitive: boolean; risk: RiskLevel; alternatives: number; priorFailure: boolean }>;
  readonly route: "single" | "tournament";
  readonly candidates: number;
  readonly source: "policy" | "human" | "advice";
  readonly outcome: OutcomeClass;
  readonly tournament?: Readonly<{
    outcome: TournamentOutcome;
    /** Candidates Fusion judged (with a v0.4 decision). */
    judged: number;
    /** Judged candidates Fusion verified. */
    verified: number;
    /** Judged candidates Fusion's own evidence rejected (a failed obligation or a contradiction by its experiments). */
    rejected: number;
    /** Candidates whose author, materialization or budget failed (no evidence either way). */
    failed: number;
    selection?: SelectionClass;
    mutationsRun: number;
    mutationsSurvived: number;
  }>;
  /** The run's wall time, when recorded. */
  readonly durationMs?: number;
}
/** The tournament SEPARATED candidates: Fusion's evidence rejected one while it verified another — what one candidate could not show. */
export const separated = (record: RoutingRecord): boolean =>
  record.tournament !== undefined && record.tournament.rejected > 0 && record.tournament.verified > 0;

/** A routing policy under evaluation: the number of candidates it would have run for these facts (1 = single). */
export interface CalibrationPolicy { readonly id: string; readonly description: string; candidates(facts: RouteFacts): number }
const fix = (c: TaskClass): boolean => c === "bugFix" || c === "configFix" || c === "refactor";
/** Versioned candidate policies to compare — evaluated only, never applied. */
export const CALIBRATION_POLICIES: readonly CalibrationPolicy[] = Object.freeze([
  { id: TOURNAMENT_POLICY_VERSION, description: "the current policy", candidates: (facts: RouteFacts) => tournamentRoute(facts).candidates },
  { id: "single-always", description: "never a tournament (the v0.4 route)", candidates: () => 1 },
  { id: "fixes-at-any-risk", description: "every fix, refactor or configuration fix runs 2 candidates, at any risk",
    candidates: (facts: RouteFacts) => facts.writer && facts.risk !== "critical" && fix(facts.taskClass) ? 2 : tournamentRoute(facts).candidates },
  { id: "high-risk-only", description: "2 candidates only at high risk or for security-sensitive work",
    candidates: (facts: RouteFacts) => facts.writer && facts.risk !== "critical" && (riskRank(facts.risk) >= riskRank("high") || facts.sensitive) ? 2 : 1 },
].map(p => Object.freeze(p)));

/** Below this many observed tournaments in a group, no rate is estimated. */
export const MIN_SAMPLE = 3;
export interface GroupEstimate {
  readonly group: string;
  readonly runs: number;
  readonly tournaments: number;
  readonly separated: number;
  /** Observed separation rate among this group's tournaments; absent below MIN_SAMPLE. */
  readonly rate?: number;
  /** Runs the policy would turn into tournaments that ran single. */
  readonly added: number;
  /** Tournaments the policy would have run single. */
  readonly dropped: number;
  /** Observed separations in the dropped tournaments (exact: they happened). */
  readonly separationsLost: number;
  /** Expected separations in the added tournaments (rate × added); absent when the rate is unknown. */
  readonly separationsGainedEstimate?: number;
  readonly candidateRunsDelta: number;
}
export interface WhatIfReport {
  readonly policy: string;
  readonly description: string;
  readonly records: number;
  /** Runs a human routed (their choice stands under any policy): not counted in the deltas. */
  readonly humanRouted: number;
  readonly groups: readonly GroupEstimate[];
  readonly totals: Readonly<{ added: number; dropped: number; separationsLost: number; separationsGainedEstimate?: number;
    unestimatedAdded: number; candidateRunsDelta: number }>;
}
const groupOf = (record: RoutingRecord): string => `${record.facts.taskClass}/${record.facts.risk}${record.facts.sensitive ? "/sensitive" : ""}`;
const factsOf = (record: RoutingRecord): RouteFacts => ({ writer: true, ...record.facts });

/** What `policy` would have done on these past runs, group by group — estimates only where the records support one. */
export function whatIf(records: readonly RoutingRecord[], policy: CalibrationPolicy): WhatIfReport {
  const byGroup = new Map<string, RoutingRecord[]>();
  for (const record of records) byGroup.set(groupOf(record), [...(byGroup.get(groupOf(record)) ?? []), record]);
  const groups: GroupEstimate[] = [];
  let humanRouted = 0;
  for (const [group, members] of [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const tournaments = members.filter(r => r.tournament !== undefined);
    const hits = tournaments.filter(separated).length;
    const rate = tournaments.length >= MIN_SAMPLE ? hits / tournaments.length : undefined;
    let added = 0, dropped = 0, lost = 0, delta = 0;
    for (const record of members) {
      if (record.source === "human") { humanRouted++; continue; }
      const would = policy.candidates(factsOf(record));
      delta += would - record.candidates;
      if (would > 1 && record.candidates === 1) added++;
      if (would === 1 && record.candidates > 1) { dropped++; if (separated(record)) lost++; }
    }
    groups.push(Object.freeze({ group, runs: members.length, tournaments: tournaments.length, separated: hits, ...(rate === undefined ? {} : { rate }),
      added, dropped, separationsLost: lost, ...(rate === undefined ? {} : { separationsGainedEstimate: rate * added }), candidateRunsDelta: delta }));
  }
  const estimable = groups.filter(g => g.separationsGainedEstimate !== undefined);
  const unestimatedAdded = groups.filter(g => g.separationsGainedEstimate === undefined).reduce((n, g) => n + g.added, 0);
  const sum = (key: "added" | "dropped" | "separationsLost" | "candidateRunsDelta") => groups.reduce((n, g) => n + g[key], 0);
  return Object.freeze({ policy: policy.id, description: policy.description, records: records.length, humanRouted, groups: Object.freeze(groups),
    totals: Object.freeze({ added: sum("added"), dropped: sum("dropped"), separationsLost: sum("separationsLost"),
      ...(estimable.length === 0 ? {} : { separationsGainedEstimate: estimable.reduce((n, g) => n + g.separationsGainedEstimate!, 0) }),
      unestimatedAdded, candidateRunsDelta: sum("candidateRunsDelta") }) });
}
