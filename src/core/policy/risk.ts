/** Deterministic, monotonic risk algebra. Provider- and model-neutral by construction: it only sees facts. */
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export type RiskSignalSource = "task" | "scope" | "capability" | "verification" | "diff" | "policy";
/** One fact and the minimum risk it implies, with a deterministic, non-secret explanation. */
export interface RiskSignal {
  readonly code: string;
  readonly level: RiskLevel;
  readonly source: RiskSignalSource;
  readonly evidence: string;
}
export interface RiskAssessment {
  /** The highest level implied by any signal ever observed for this task. */
  readonly level: RiskLevel;
  /** All distinct signals, sorted by level (highest first), then code, then evidence. */
  readonly signals: readonly RiskSignal[];
  /** Codes of the signals that set the level: the explanation of WHY. */
  readonly decisive: readonly string[];
  /** Number of escalation steps applied after the initial assessment. */
  readonly revision: number;
}

export const riskRank = (level: RiskLevel): number => RISK_LEVELS.indexOf(level);
export const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => riskRank(a) >= riskRank(b) ? a : b;
export const isRiskLevel = (value: unknown): value is RiskLevel => RISK_LEVELS.includes(value as RiskLevel);

function compareSignals(a: RiskSignal, b: RiskSignal): number {
  return riskRank(b.level) - riskRank(a.level) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
    (a.evidence < b.evidence ? -1 : a.evidence > b.evidence ? 1 : 0) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
}
function normalize(signals: readonly RiskSignal[]): RiskSignal[] {
  const unique = new Map<string, RiskSignal>();
  for (const signal of signals) {
    if (!isRiskLevel(signal.level) || typeof signal.code !== "string" || typeof signal.evidence !== "string")
      throw new TypeError("Invalid risk signal.");
    const frozen = Object.freeze({ code: signal.code, level: signal.level, source: signal.source, evidence: signal.evidence });
    unique.set(`${frozen.level}\u0000${frozen.code}\u0000${frozen.source}\u0000${frozen.evidence}`, frozen);
  }
  return [...unique.values()].sort(compareSignals);
}
function build(signals: readonly RiskSignal[], floor: RiskLevel, revision: number): RiskAssessment {
  const sorted = normalize(signals);
  const level = sorted.reduce<RiskLevel>((current, signal) => maxRisk(current, signal.level), floor);
  const decisive = [...new Set(sorted.filter(signal => signal.level === level).map(signal => signal.code))];
  return Object.freeze({ level, signals: Object.freeze(sorted), decisive: Object.freeze(decisive), revision });
}

/** Initial assessment. With no signal the task is low risk; every signal can only raise that. */
export function assessRisk(signals: readonly RiskSignal[]): RiskAssessment {
  return build(signals, "low", 0);
}

/**
 * Adds newly discovered facts. The result is never lower than the previous level, whatever the new signals
 * say, so later logic cannot autonomously de-escalate a task.
 */
export function escalateRisk(previous: RiskAssessment, additional: readonly RiskSignal[]): RiskAssessment {
  if (!isRiskLevel(previous.level)) throw new TypeError("Invalid prior risk assessment.");
  const next = build([...previous.signals, ...additional], previous.level, previous.revision + 1);
  return next;
}
