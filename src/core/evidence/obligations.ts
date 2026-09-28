import type { ClaimAssessment } from "./graph.js";

/**
 * v0.4 — PROOF OBLIGATIONS: what must hold before Fusion may call a change verified, or prepare it for delivery. They are
 * host-owned: the set is chosen from the task's class, its sensitivity and its risk (`policy.ts`), and every obligation is
 * evaluated MECHANICALLY from what Fusion itself observed (`BuildFacts`) — its own verification runs on the unchanged
 * baseline and on the change, the changed paths it observed, the protected-material state it checked, the fresh review it
 * ran, and the statuses of the evidence graph. No model output is an input: a model saying "tests pass" is not a test that
 * passed. An obligation Fusion cannot establish is UNKNOWN, with the reason, and UNKNOWN never becomes PASS.
 *
 * The decision follows from the obligations alone:
 *   - BLOCKED    any obligation FAILED (deterministic evidence contradicts it);
 *   - UNVERIFIED no obligation failed, but at least one is UNKNOWN (or the evidence graph overflowed);
 *   - VERIFIED   every required obligation PASSED.
 * Several agreeing models never turn a missing obligation into VERIFIED. Whether a change may be prepared for delivery is a
 * separate, stricter question: never when BLOCKED, never when a SAFETY obligation is not PASS; a correctness gap (for
 * example a defect Fusion's checks could not reproduce) is delivered only as UNVERIFIED, for the human to decide — and at
 * high risk or for security-sensitive work the correctness obligations are safety obligations.
 */
export const TASK_CLASSES = ["bugFix", "configFix", "refactor", "change"] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];
export const OBLIGATION_KINDS = ["verificationPassed", "scopeRespected", "protectedUnchanged", "freshReviewClear", "defectReproduced",
  "reproductionResolved", "rootCauseSupported", "alternativesAddressed", "behaviorPreserved"] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];
/** `safety`: must PASS for any delivery. `correctness`: ties the change to its claim; a gap is shown, never hidden. */
export type ObligationTier = "safety" | "correctness";
export const OBLIGATION_STATUSES = ["PASS", "FAIL", "UNKNOWN"] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];
export interface ObligationRequirement { readonly kind: ObligationKind; readonly tier: ObligationTier }
export interface ObligationResult extends ObligationRequirement {
  readonly status: ObligationStatus;
  /** Fusion's own account of why (never model text). */
  readonly reason: string;
}
export const DECISIONS = ["VERIFIED", "UNVERIFIED", "BLOCKED"] as const;
export type Decision = (typeof DECISIONS)[number];
export interface EvidenceDecision {
  readonly decision: Decision;
  /** Whether a delivery may be prepared at all (the human still approves it). */
  readonly deliverable: boolean;
  readonly obligations: readonly ObligationResult[];
  readonly overflowed: boolean;
}

/** One verification command as Fusion observed it. */
export interface CommandOutcome { readonly id: string; readonly passed: boolean }
/**
 * What Fusion observed of one Writer run: the only input to the obligations. Every field is a host observation or a status
 * the evidence graph derived; none is a model's report.
 */
export interface BuildFacts {
  /** The final change's confined verification; absent when none ran. `complete`: every planned command ran. */
  readonly verification?: Readonly<{ passed: boolean; complete: boolean; commands: readonly CommandOutcome[]; refusal?: string }>;
  /** The same checks on the unchanged baseline (the reproduction), or why they did not run. */
  readonly reproduction?: Readonly<{ ran: true; commands: readonly CommandOutcome[] }> | Readonly<{ ran: false; reason: string }>;
  /** Paths Fusion observed changed in the final change (empty when nothing was applied). */
  readonly changedPaths: readonly string[];
  readonly allowedScope: readonly string[];
  /** The run stopped because the change reached outside its confirmed scope. */
  readonly scopeViolation: boolean;
  /** Changed paths that are protected or never deliverable (must be empty). */
  readonly protectedChanged: readonly string[];
  /** The fresh review or falsification stage, when the obligation set requires one. */
  readonly freshReview?: Readonly<{ ran: boolean; clean: boolean; outstanding: number; objective: "review" | "falsify"; reason?: string }>;
  /** The assessment of the build's own root-cause claim (the defect lies within the confirmed scope), from the evidence graph. */
  readonly rootCause?: ClaimAssessment;
  /**
   * v0.4: the checked finding a fix rests on (a claim check's handoff), assessed on the claim check's evidence ONLY — the build
   * never adds its own verification to it, so a build that passes can never promote it. Either claim can establish the root
   * cause; either one contradicted fails it.
   */
  readonly finding?: ClaimAssessment;
  /** Competing explanations recorded for it, from the evidence graph. */
  readonly alternatives?: readonly ClaimAssessment[];
}

const key = (path: string): string => path.replace(/\\/gu, "/").toLowerCase();
const ids = (list: readonly string[], max = 3): string => `${list.slice(0, max).join(", ")}${list.length > max ? `, +${list.length - max}` : ""}`;
const result = (req: ObligationRequirement, status: ObligationStatus, reason: string): ObligationResult =>
  Object.freeze({ kind: req.kind, tier: req.tier, status, reason });

/** Evaluates each required obligation from host facts only. The order of `required` is kept. */
export function evaluateObligations(required: readonly ObligationRequirement[], facts: BuildFacts): readonly ObligationResult[] {
  const verification = facts.verification;
  const reproduction = facts.reproduction;
  const baselineFailing = reproduction?.ran === true ? reproduction.commands.filter(c => !c.passed).map(c => c.id) : [];
  const baselinePassing = reproduction?.ran === true ? reproduction.commands.filter(c => c.passed).map(c => c.id) : [];
  const after = new Map((verification?.refusal === undefined ? verification?.commands ?? [] : []).map(c => [c.id, c.passed]));
  const noVerification = verification === undefined ? "no confined verification of the final change ran"
    : verification.refusal !== undefined ? `the confined verification could not start (${verification.refusal})` : undefined;
  const noReproduction = reproduction === undefined ? "Fusion did not run its checks on the unchanged baseline"
    : reproduction.ran === false ? `Fusion's checks could not run on the unchanged baseline (${reproduction.reason})` : undefined;
  return Object.freeze(required.map(req => {
    switch (req.kind) {
      case "verificationPassed": {
        if (noVerification !== undefined) return result(req, "UNKNOWN", noVerification);
        if (verification!.passed && verification!.complete)
          return result(req, "PASS", `every configured check passed on the final change (${verification!.commands.length})`);
        const failing = verification!.commands.filter(c => !c.passed).map(c => c.id);
        return result(req, "FAIL", failing.length > 0 ? `check ${ids(failing)} did not pass on the final change` : "not every configured check ran");
      }
      case "scopeRespected": {
        if (facts.scopeViolation) return result(req, "FAIL", "the change reached outside its confirmed scope");
        if (facts.changedPaths.length === 0) return result(req, "UNKNOWN", "no change was applied");
        const allowed = new Set(facts.allowedScope.map(key));
        const outside = facts.changedPaths.filter(p => !allowed.has(key(p)));
        return outside.length > 0 ? result(req, "FAIL", `${outside.length} changed file(s) are outside the confirmed scope`)
          : result(req, "PASS", `${facts.changedPaths.length} changed file(s), all within the confirmed scope`);
      }
      case "protectedUnchanged":
        if (facts.protectedChanged.length > 0) return result(req, "FAIL", `${facts.protectedChanged.length} protected file(s) changed`);
        if (facts.changedPaths.length === 0) return result(req, "UNKNOWN", "no change was applied");
        return result(req, "PASS", "no protected, credential or never-deliverable file changed");
      case "freshReviewClear": {
        const review = facts.freshReview, what = review?.objective === "falsify" ? "falsification" : "review";
        if (review === undefined || !review.ran) return result(req, "UNKNOWN", review?.reason ?? `the required fresh ${what} did not run`);
        if (review.outstanding > 0 || !review.clean)
          return result(req, "FAIL", `the fresh ${what} left ${review.outstanding} outstanding finding(s)`);
        return result(req, "PASS", `the fresh ${what} left no outstanding finding`);
      }
      case "defectReproduced":
        if (noReproduction !== undefined) return result(req, "UNKNOWN", noReproduction);
        if (baselineFailing.length > 0) return result(req, "PASS", `check ${ids(baselineFailing)} fails on the unchanged baseline`);
        return result(req, "UNKNOWN", "every configured check passes on the unchanged baseline, so Fusion's checks do not reproduce the defect");
      case "reproductionResolved": {
        if (noReproduction !== undefined || baselineFailing.length === 0) return result(req, "UNKNOWN", "nothing was reproduced for the change to resolve");
        if (noVerification !== undefined) return result(req, "UNKNOWN", noVerification);
        const still = baselineFailing.filter(id => after.get(id) === false);
        if (still.length > 0) return result(req, "FAIL", `check ${ids(still)} still fails after the change`);
        const unrun = baselineFailing.filter(id => !after.has(id));
        if (unrun.length > 0) return result(req, "UNKNOWN", `check ${ids(unrun)} did not run on the final change`);
        return result(req, "PASS", `check ${ids(baselineFailing)} failed before the change and passes after it`);
      }
      case "rootCauseSupported": {
        const own = facts.rootCause, finding = facts.finding;
        const claims = [own, finding].filter((c): c is ClaimAssessment => c !== undefined);
        if (claims.length === 0) return result(req, "UNKNOWN", "no root-cause claim was recorded");
        const which = (claim: ClaimAssessment): string => claim === finding && own !== undefined ? "the checked finding: " : "";
        const contradicted = claims.find(c => c.status === "CONTRADICTED");
        if (contradicted !== undefined) return result(req, "FAIL", `${which(contradicted)}Fusion's own evidence contradicts it (${contradicted.deterministic.contradicts} observation(s))`);
        const supported = claims.find(c => c.status === "SUPPORTED");
        if (supported !== undefined) return result(req, "PASS", `${which(supported)}Fusion's own evidence supports it (${supported.deterministic.supports} observation(s))`);
        if (claims.some(c => c.status === "STALE")) return result(req, "UNKNOWN", "its evidence is stale: the repository changed after it was observed");
        const models = Math.max(...claims.map(c => c.models.supports));
        return result(req, "UNKNOWN", `no deterministic evidence supports it${models > 0 ? ` (${models} model judgement(s) agree, which is not evidence)` : ""}`);
      }
      case "alternativesAddressed": {
        const alternatives = facts.alternatives ?? [];
        if (alternatives.length === 0) return result(req, "UNKNOWN", "the competing explanations were not available to assess");
        if (alternatives.some(a => a.status === "SUPPORTED")) return result(req, "FAIL", "a competing explanation is supported by Fusion's own evidence");
        const open = alternatives.filter(a => a.status !== "CONTRADICTED").length;
        return open > 0 ? result(req, "UNKNOWN", `${open} competing explanation(s) remain untested`)
          : result(req, "PASS", `every competing explanation (${alternatives.length}) is contradicted by Fusion's own evidence`);
      }
      case "behaviorPreserved": {
        if (noReproduction !== undefined) return result(req, "UNKNOWN", noReproduction);
        if (baselinePassing.length === 0) return result(req, "UNKNOWN", "no configured check passes on the unchanged baseline, so nothing demonstrates the behavior");
        if (noVerification !== undefined) return result(req, "UNKNOWN", noVerification);
        const broken = baselinePassing.filter(id => after.get(id) === false);
        if (broken.length > 0) return result(req, "FAIL", `check ${ids(broken)} passed before the change and fails after it`);
        const unrun = baselinePassing.filter(id => !after.has(id));
        if (unrun.length > 0) return result(req, "UNKNOWN", `check ${ids(unrun)} did not run on the final change`);
        return result(req, "PASS", `every check that passed before the change still passes (${baselinePassing.length})`);
      }
    }
  }));
}

/** The decision and the delivery permission, from the obligation results alone. No obligations establish nothing. */
export function decide(results: readonly ObligationResult[], options: Readonly<{ overflowed?: boolean }> = {}): EvidenceDecision {
  const overflowed = options.overflowed === true;
  const failed = results.some(r => r.status === "FAIL");
  const unknown = results.length === 0 || results.some(r => r.status === "UNKNOWN");
  const decision: Decision = failed ? "BLOCKED" : unknown || overflowed ? "UNVERIFIED" : "VERIFIED";
  const deliverable = results.length > 0 && !failed && !overflowed && results.filter(r => r.tier === "safety").every(r => r.status === "PASS");
  return Object.freeze({ decision, deliverable, obligations: Object.freeze([...results]), overflowed });
}

// ---------------------------------------------------------------- presentation vocabulary (pure data)

/** The obligation's name for a human, per task class. */
export function obligationLabel(kind: ObligationKind, taskClass: TaskClass, objective: "review" | "falsify" = "falsify"): string {
  const config = taskClass === "configFix";
  switch (kind) {
    case "verificationPassed": return "regression checks";
    case "scopeRespected": return "confirmed scope";
    case "protectedUnchanged": return "protected files";
    case "freshReviewClear": return objective === "falsify" ? "fresh falsification" : "fresh review";
    case "defectReproduced": return config ? "invalid state shown" : "reproduced defect";
    case "reproductionResolved": return config ? "corrected state shown" : "defect resolved";
    case "rootCauseSupported": return "root cause";
    case "alternativesAddressed": return "alternative causes";
    case "behaviorPreserved": return "behavior preserved";
  }
}
/** The word a human reads next to the obligation (the example of the spec: `protected files ... UNCHANGED`). */
export function obligationWord(kind: ObligationKind, status: ObligationStatus): string {
  if (status === "UNKNOWN") return kind === "defectReproduced" ? "NOT REPRODUCED" : kind === "freshReviewClear" ? "NOT RUN"
    : kind === "alternativesAddressed" ? "OPEN" : kind === "rootCauseSupported" ? "UNVERIFIED" : "UNKNOWN";
  const pass = status === "PASS";
  switch (kind) {
    case "protectedUnchanged": return pass ? "UNCHANGED" : "CHANGED";
    case "scopeRespected": return pass ? "WITHIN SCOPE" : "EXCEEDED";
    case "freshReviewClear": return pass ? "NO BLOCKER" : "BLOCKER";
    case "rootCauseSupported": return pass ? "SUPPORTED" : "CONTRADICTED";
    case "alternativesAddressed": return pass ? "CONTRADICTED" : "SUPPORTED";
    default: return pass ? "PASS" : "FAIL";
  }
}
