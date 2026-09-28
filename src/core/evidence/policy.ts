import { riskRank, type RiskAssessment } from "../policy/risk.js";
import type { PathClass, TaskOperation } from "../policy/task-inspector.js";
import { reviewMode } from "../review/policy.js";
import type { ObligationRequirement, ObligationTier, TaskClass } from "./obligations.js";

/**
 * v0.4 — THE RELIABILITY POLICY: how much proof a change needs, decided by the host from facts it already owns — the human's
 * task text and confirmed scope, the operation, the task inspector's path classes and the (monotonic) risk. Never from a
 * model reply. It keeps simple work cheap and makes risky work prove more:
 *
 *   - every Writer change: its confined checks pass, it stays in its confirmed scope, no protected file changes;
 *   - a bug fix or configuration fix: Fusion also runs its checks on the UNCHANGED baseline first (a reproduction; no model
 *     turn), and requires the defect reproduced, resolved by the change, and its root cause supported by Fusion's evidence;
 *   - a refactor: the checks that passed before the change still pass after it;
 *   - medium risk and above for a fix, and any security-sensitive change: a FRESH FALSIFICATION (the fresh Reviewer, asked to
 *     break the conclusion rather than to approve it) that must leave no blocker;
 *   - high risk or security-sensitive: the correctness obligations become safety obligations (no delivery while unknown).
 *
 * Classification only ever ADDS proof: a misread task costs a confined check run or an honest UNVERIFIED label, never a gate.
 */
export interface TaskProfile {
  readonly taskClass: TaskClass;
  /** Security-sensitive by the task inspector's own path classes or risk signals (never by a model's words). */
  readonly sensitive: boolean;
}
export interface ClassificationInput {
  readonly text: string;
  readonly paths: readonly string[];
  readonly operation: TaskOperation;
  readonly pathClasses: Readonly<Partial<Record<PathClass, readonly string[]>>>;
  readonly risk: RiskAssessment;
}
/** Normalized like the shell's intent classifier: lower case, single spaces, German umlauts transliterated. */
const normalize = (text: string): string =>
  text.toLowerCase().replace(/\s+/gu, " ").replace(/ä/gu, "ae").replace(/ö/gu, "oe").replace(/ü/gu, "ue").replace(/ß/gu, "ss");
const FIX = /\b(?:fix\w*|bug\w*|defect\w*|broken|crash\w*|regression\w*|repair\w*|incorrect\w*|wrong|failing|fails|failed|doesn'?t work|does not work|behebe?\w*|fehler\w*|kaputt|absturz\w*|repariere?\w*|korrigiere?\w*)\b/u;
const REFACTOR = /\b(?:refactor\w*|rename\w*|restructur\w*|reorgani[sz]\w*|extract\w*|simplif\w*|clean ?up|cleanup|tidy|deduplicat\w*|umbenenn\w*|umstrukturier\w*|aufraeum\w*|vereinfach\w*)\b/u;
const CONFIG_FILE = /\.(?:ya?ml|json|jsonc|json5|toml|ini|conf|cfg|properties|xml)$/iu;
const SENSITIVE_SIGNALS = new Set(["credentialHandlingRequested"]);

/** The task's class and sensitivity, deterministically. */
export function classifyTask(input: ClassificationInput): TaskProfile {
  const text = normalize(input.text);
  const sensitive = (input.pathClasses.securitySensitive?.length ?? 0) > 0 || (input.pathClasses.credentialMaterial?.length ?? 0) > 0 ||
    input.risk.signals.some(signal => SENSITIVE_SIGNALS.has(signal.code));
  const configOnly = input.paths.length > 0 && input.paths.every(path => CONFIG_FILE.test(path));
  const taskClass: TaskClass = FIX.test(text) ? (configOnly ? "configFix" : "bugFix")
    : input.operation === "refactor" || REFACTOR.test(text) ? "refactor" : "change";
  return Object.freeze({ taskClass, sensitive });
}

export interface ReliabilityPlan {
  readonly profile: TaskProfile;
  /** Run the confined checks on the unchanged baseline before the first change (a reproduction). */
  readonly reproduce: boolean;
  /** A fresh review stage is required (v0.3's rule, or v0.4's falsification rule). */
  readonly freshReview: boolean;
  /** What the fresh stage is asked to do: approve-or-report (`review`) or try to break the conclusion (`falsify`). */
  readonly objective: "review" | "falsify";
  /** Correctness obligations are safety obligations (high risk, or security-sensitive). */
  readonly strict: boolean;
  readonly obligations: readonly ObligationRequirement[];
}

/** The plan for a Writer change of this profile at this risk. `alternatives`: competing explanations a diagnosis recorded. */
export function reliabilityPlan(profile: TaskProfile, risk: RiskAssessment, options: Readonly<{ alternatives?: number }> = {}): ReliabilityPlan {
  const level = risk.level;
  const fix = profile.taskClass === "bugFix" || profile.taskClass === "configFix";
  const v03Fresh = reviewMode(level, true, risk.signals) === "fresh";
  const falsify = profile.sensitive || (fix && riskRank(level) >= riskRank("medium"));
  const freshReview = v03Fresh || falsify;
  const strict = profile.sensitive || riskRank(level) >= riskRank("high");
  const correctness: ObligationTier = strict ? "safety" : "correctness";
  const obligations: ObligationRequirement[] = [{ kind: "verificationPassed", tier: "safety" }, { kind: "scopeRespected", tier: "safety" },
    { kind: "protectedUnchanged", tier: "safety" }];
  if (freshReview) obligations.push({ kind: "freshReviewClear", tier: "safety" });
  if (fix) {
    obligations.push({ kind: "defectReproduced", tier: correctness }, { kind: "reproductionResolved", tier: correctness });
    // A configuration fix proves the invalid state and the corrected state; a bug fix also its root cause.
    if (profile.taskClass === "bugFix") obligations.push({ kind: "rootCauseSupported", tier: correctness });
    if ((options.alternatives ?? 0) > 0) obligations.push({ kind: "alternativesAddressed", tier: correctness });
  }
  if (profile.taskClass === "refactor") obligations.push({ kind: "behaviorPreserved", tier: correctness });
  return Object.freeze({ profile, reproduce: profile.taskClass !== "change", freshReview,
    objective: freshReview && (profile.taskClass !== "change" || profile.sensitive) ? "falsify" as const : "review" as const,
    strict, obligations: Object.freeze(obligations.map(o => Object.freeze(o))) });
}
