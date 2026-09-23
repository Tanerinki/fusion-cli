import type { AdjudicatedFinding, DelegationPacket, Finding, ReviewEvidence } from "../domain.js";
import type { RiskLevel, RiskSignal } from "../policy/risk.js";
import { MATERIAL_SEVERITIES } from "./findings.js";

export const REVIEW_EVIDENCE_LIMITS = Object.freeze({
  maxListItems: 64, maxItemChars: 2_000, maxChangedPaths: 1_000, maxChangeChars: 256 * 1024, maxPriorFindings: 32,
});
/** At most one corrective implementation after a review; a second review can only succeed or stop. */
export const REVIEW_CYCLE_LIMIT = 2;

/**
 * - `none`: no review beyond Fusion verification (low risk).
 * - `lead`: the Lead reviews the result (medium risk).
 * - `fresh`: a fresh Reviewer reports structured findings and the Lead adjudicates them (high risk, and medium-risk
 *   writers that change files controlling their own verification).
 */
export type ReviewMode = "none" | "lead" | "fresh";
const FRESH_AT_MEDIUM = new Set(["verificationControlPath", "verificationReferencedPath"]);
export function reviewMode(level: RiskLevel, writes: boolean, signals: readonly RiskSignal[]): ReviewMode {
  if (level === "high" || level === "critical") return "fresh";
  if (level === "medium") return writes && signals.some(signal => FRESH_AT_MEDIUM.has(signal.code)) ? "fresh" : "lead";
  return "none";
}

/** A finding that blocks an automatic success until it is fixed or decided. */
export function isOutstanding(entry: AdjudicatedFinding): boolean {
  const severity = entry.finding.severity;
  if (entry.verdict === "CONFIRMED" || entry.verdict === "PARTIAL") return MATERIAL_SEVERITIES.has(severity);
  return entry.verdict === "UNVERIFIABLE" && (severity === "BLOCKER" || severity === "HIGH");
}

export type ReviewOutcome =
  | Readonly<{ kind: "clean" }>
  | Readonly<{ kind: "correction"; findings: readonly Finding[] }>
  | Readonly<{ kind: "gate"; state: "decisionRequired" | "humanGateRequired" }>;
/**
 * Deterministic outcome of one adjudicated review. Only fixable outstanding findings, with a corrective attempt
 * still available, lead to a correction. An outstanding BLOCKER always needs a human; other outstanding findings
 * need a decision. Unverifiable or explicitly human-decision findings are never sent back for autonomous fixing.
 */
export function reviewOutcome(adjudicated: readonly AdjudicatedFinding[], correctionAvailable: boolean): ReviewOutcome {
  const open = adjudicated.filter(isOutstanding);
  if (open.length === 0) return { kind: "clean" };
  const fixable = open.every(entry => entry.verdict !== "UNVERIFIABLE" && entry.requiredAction === "fix");
  if (fixable && correctionAvailable) return { kind: "correction", findings: open.map(entry => entry.finding) };
  return { kind: "gate", state: open.some(entry => entry.finding.severity === "BLOCKER") ? "humanGateRequired" : "decisionRequired" };
}

const clip = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, max)}…`;
const clipList = (items: readonly string[]): string[] =>
  items.slice(0, REVIEW_EVIDENCE_LIMITS.maxListItems).map(item => clip(item, REVIEW_EVIDENCE_LIMITS.maxItemChars));

/**
 * Review evidence comes only from the caller's packet and Fusion's observations. The implementer's summary, the
 * Lead's plan and every transcript are deliberately absent; a read-only task's deliverable is its answer.
 */
export function reviewEvidence(base: DelegationPacket, verification: ReviewEvidence["verification"],
  change: Readonly<{ kind: "diff" | "answer"; changedPaths: readonly string[]; text: string; truncated: boolean }>): ReviewEvidence {
  const truncated = change.truncated || change.text.length > REVIEW_EVIDENCE_LIMITS.maxChangeChars ||
    change.changedPaths.length > REVIEW_EVIDENCE_LIMITS.maxChangedPaths;
  return {
    task: { goal: clip(base.task.goal, REVIEW_EVIDENCE_LIMITS.maxItemChars * 8), constraints: clipList(base.task.constraints),
      acceptanceCriteria: clipList(base.task.acceptanceCriteria) },
    architecture: { decisions: clipList(base.architecture.decisions), invariants: clipList(base.architecture.invariants) },
    scope: { relevantFiles: clipList(base.scope.relevantFiles), allowedFiles: clipList(base.scope.allowedFiles),
      forbiddenFiles: clipList(base.scope.forbiddenFiles) },
    verification: { required: verification.required, passed: verification.passed,
      commands: verification.commands.map(command => ({ id: command.id, passed: command.passed })) },
    change: { kind: change.kind, changedPaths: change.changedPaths.slice(0, REVIEW_EVIDENCE_LIMITS.maxChangedPaths),
      text: change.text.slice(0, REVIEW_EVIDENCE_LIMITS.maxChangeChars), truncated },
  };
}
