import { CLAIM_STATUSES, evidencePath, evidenceText, type ClaimStatus } from "./graph.js";

/**
 * v0.4 — THE DIAGNOSIS HANDOFF: what a claim check established about the finding a fix rests on, carried into the build as
 * host data (never as model text with authority): the claim, Fusion's status of it, the checks Fusion ran on the shared copy
 * with their outcome, competing hypotheses with their statuses, and the BASIS — a digest of the files it rests on as they
 * were in the checkout when the checks ran. The build records it in its evidence graph against that basis: if one of those
 * files changed since, the handoff's evidence is STALE and cannot satisfy the root-cause obligation. Bounded and validated.
 */
export const HANDOFF_LIMITS = Object.freeze({ maxChecks: 9, maxAlternatives: 3, maxFiles: 8, maxTextChars: 120, maxClaimChars: 400, maxBasisChars: 120 });
export interface HandoffCheck {
  readonly file: string;
  readonly text: string;
  readonly expect: "present" | "absent";
  /** What Fusion observed: the file showed the text, and whether that was the prediction. */
  readonly present: boolean;
  readonly holds: boolean;
}
export interface DiagnosisHandoff {
  /** The claim the fix rests on: the verified finding, or the leading hypothesis of a diagnosis. */
  readonly claim: string;
  readonly source: "verification" | "diagnosis";
  /** Fusion's status of it when checked. */
  readonly status: ClaimStatus;
  readonly checks: readonly HandoffCheck[];
  /** Competing hypotheses of a diagnosis, with Fusion's status of each (a verification has none). */
  readonly alternatives: readonly Readonly<{ statement: string; status: ClaimStatus }>[];
  /** Open challenges the falsifier raised that no Fusion check settled. */
  readonly openChallenges: number;
  /** The shared files it rests on. */
  readonly files: readonly string[];
  /** `files:<digest>` of `files` in the checkout when the checks ran. */
  readonly basis: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const statuses = new Set<unknown>(CLAIM_STATUSES);
const TEXT_CONTROL = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/u;

/** A handoff as the build accepts it, or undefined (anything malformed or out of bounds is dropped, never repaired). */
export function validateHandoff(value: unknown): DiagnosisHandoff | undefined {
  const L = HANDOFF_LIMITS;
  if (!isRecord(value) || typeof value.claim !== "string" || (value.source !== "verification" && value.source !== "diagnosis") ||
      !statuses.has(value.status) || !Array.isArray(value.checks) || value.checks.length > L.maxChecks || !Array.isArray(value.alternatives) ||
      value.alternatives.length > L.maxAlternatives || !Array.isArray(value.files) || value.files.length > L.maxFiles ||
      !Number.isSafeInteger(value.openChallenges) || (value.openChallenges as number) < 0 || typeof value.basis !== "string" ||
      !/^files:[0-9a-f]{64}$/u.test(value.basis)) return undefined;
  const checks: HandoffCheck[] = [];
  for (const raw of value.checks) {
    if (!isRecord(raw) || typeof raw.file !== "string" || evidencePath(raw.file) !== raw.file || typeof raw.text !== "string" || raw.text.length === 0 ||
        raw.text.length > L.maxTextChars || TEXT_CONTROL.test(raw.text) || (raw.expect !== "present" && raw.expect !== "absent") ||
        typeof raw.present !== "boolean" || typeof raw.holds !== "boolean" || raw.holds !== (raw.present === (raw.expect === "present"))) return undefined;
    checks.push(Object.freeze({ file: raw.file, text: raw.text, expect: raw.expect, present: raw.present, holds: raw.holds }));
  }
  const alternatives: Array<Readonly<{ statement: string; status: ClaimStatus }>> = [];
  for (const raw of value.alternatives) {
    if (!isRecord(raw) || typeof raw.statement !== "string" || !statuses.has(raw.status)) return undefined;
    alternatives.push(Object.freeze({ statement: evidenceText(raw.statement, L.maxClaimChars), status: raw.status as ClaimStatus }));
  }
  const files = value.files.filter((f): f is string => evidencePath(f) === f);
  if (files.length !== value.files.length) return undefined;
  return Object.freeze({ claim: evidenceText(value.claim, L.maxClaimChars), source: value.source, status: value.status as ClaimStatus,
    checks: Object.freeze(checks), alternatives: Object.freeze(alternatives), openChallenges: value.openChallenges as number,
    files: Object.freeze([...files]), basis: value.basis });
}
