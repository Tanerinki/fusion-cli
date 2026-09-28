import { boundedModelText, citedPath } from "./contracts.js";

/**
 * v0.4 — THE CONTRACTS OF A CLAIM CHECK (hypothesis isolation and discriminating experiments). For a question whose answer
 * matters before anything is changed — "is that really a bug?", "is it true that …?", "why does … fail?" — Fusion does not ask
 * one model for an answer:
 *
 *   - it builds ONE immutable EVIDENCE SNAPSHOT (the claim or question, the relevant files, Fusion's inventory facts) and
 *     gives it, identically, to independent investigators — each in its own view copy and fresh session, none seeing another's
 *     conclusion;
 *   - each returns a closed HYPOTHESIS REPORT with CHECKS: a shared file and an exact text it must contain (or lack) if the
 *     claim — or, for a diagnosis, the investigator's own explanation — is true;
 *   - Fusion authorizes and runs the checks ITSELF on the shared copy (`evaluateCheck`): a check whose result matches its
 *     prediction supports what it tests, one that does not contradicts it. Models propose experiments; Fusion decides and runs.
 *
 * Pure and provider-neutral. A report is either accepted in exactly this shape or refused with a structural category; nothing
 * in it can widen a view, add a partner, raise a budget, run a command or write.
 */
export const HYPOTHESIS_LIMITS = Object.freeze({
  /** Independent investigators of one claim check (never more than the route's concurrency). */
  investigators: 2,
  maxHypothesisChars: 300,
  maxSummaryChars: 1_200,
  maxEvidenceItems: 6,
  maxEvidenceChars: 280,
  maxEvidencePaths: 4,
  maxAlternatives: 3,
  maxAlternativeChars: 200,
  /** Checks one report may propose, and Fusion runs in one route. */
  maxChecksPerReport: 3,
  maxChecksPerRoute: 6,
  maxCheckTextChars: 120,
  /** A file a check reads (the shared copy's bytes). */
  maxCheckFileBytes: 1024 * 1024,
  /** Files the snapshot names. */
  maxSnapshotFiles: 8,
});

/** What a claim check decides: a claim the host supplied (a finding, the user's claim), or the explanation of a question. */
export type ClaimCheckMode = "verify" | "diagnose";
export type HypothesisVerdict = "supported" | "contradicted" | "unclear";
/**
 * A check Fusion can run itself: `file` (a shared, repository-relative path) contains `text` (`expect: "present"`) or lacks it
 * (`"absent"`) — IF what it tests is true. Exact, case-sensitive, one line.
 */
export interface FileCheck { readonly file: string; readonly text: string; readonly expect: "present" | "absent" }
export interface HypothesisReport {
  /** The investigator's verdict on the claim (verify), or `unclear` (a diagnosis has no claim to judge). */
  readonly verdict: HypothesisVerdict;
  /** Its explanation in one sentence (its hypothesis). */
  readonly hypothesis: string;
  readonly summary: string;
  readonly evidence: readonly Readonly<{ claim: string; paths: readonly string[] }>[];
  readonly checks: readonly FileCheck[];
  readonly alternatives: readonly string[];
}
export type HypothesisRejection = "schema mismatch" | "unknown verdict" | "verdict missing" | "hypothesis too long" | "summary too long" |
  "too many evidence items" | "evidence too long" | "too many paths" | "invalid path" | "too many checks" | "invalid check" | "too many alternatives" |
  "alternative too long";
export type HypothesisReading = Readonly<{ accepted: true; report: HypothesisReport }> | Readonly<{ accepted: false; category: HypothesisRejection }>;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keysExactly = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const CHECK_TEXT_CONTROL = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/u;

/** One proposed check as the host keeps it, or undefined (an invalid path, empty or multi-line text, an unknown expectation). */
export function fileCheckFrom(value: unknown): FileCheck | undefined {
  if (!isRecord(value) || !keysExactly(value, ["file", "text", "expect"])) return undefined;
  const file = citedPath(value.file);
  const text = value.text;
  if (file === undefined || typeof text !== "string" || text.length === 0 || text.length > HYPOTHESIS_LIMITS.maxCheckTextChars ||
      CHECK_TEXT_CONTROL.test(text) || text.trim().length === 0 || (value.expect !== "present" && value.expect !== "absent")) return undefined;
  return Object.freeze({ file, text, expect: value.expect });
}
const checkKey = (check: FileCheck): string => `${check.file}\u0000${check.text}`;

/**
 * An investigator's hypothesis report from an already-decoded JSON value. The closed shape: `verdict` (required in `verify`),
 * `hypothesis`, `summary`, `evidence` [{claim, paths}], `checks` [{file, text, expect}], `alternatives`. Bounded everywhere.
 */
export function hypothesisReportFrom(value: unknown, mode: ClaimCheckMode): HypothesisReading {
  const refuse = (category: HypothesisRejection): HypothesisReading => Object.freeze({ accepted: false, category });
  const L = HYPOTHESIS_LIMITS;
  if (!isRecord(value) || !keysExactly(value, ["hypothesis", "summary", "evidence", "checks"], ["verdict", "alternatives"])) return refuse("schema mismatch");
  let verdict: HypothesisVerdict = "unclear";
  if (Object.hasOwn(value, "verdict") && value.verdict !== null) {
    if (value.verdict !== "supported" && value.verdict !== "contradicted" && value.verdict !== "unclear")
      return refuse(typeof value.verdict === "string" ? "unknown verdict" : "schema mismatch");
    verdict = value.verdict;
  } else if (mode === "verify") return refuse("verdict missing");
  if (typeof value.hypothesis !== "string" || typeof value.summary !== "string") return refuse("schema mismatch");
  const hypothesis = boundedModelText(value.hypothesis, L.maxHypothesisChars);
  if (hypothesis === undefined) return refuse(value.hypothesis.trim().length === 0 ? "schema mismatch" : "hypothesis too long");
  const summary = boundedModelText(value.summary, L.maxSummaryChars);
  if (summary === undefined) return refuse(value.summary.trim().length === 0 ? "schema mismatch" : "summary too long");
  if (!Array.isArray(value.evidence) || !Array.isArray(value.checks)) return refuse("schema mismatch");
  if (value.evidence.length > L.maxEvidenceItems) return refuse("too many evidence items");
  const evidence: Array<Readonly<{ claim: string; paths: readonly string[] }>> = [];
  for (const entry of value.evidence) {
    if (!isRecord(entry) || !keysExactly(entry, ["claim", "paths"]) || typeof entry.claim !== "string" || !Array.isArray(entry.paths)) return refuse("schema mismatch");
    const claim = boundedModelText(entry.claim, L.maxEvidenceChars);
    if (claim === undefined) return refuse(entry.claim.trim().length === 0 ? "schema mismatch" : "evidence too long");
    if (entry.paths.length > L.maxEvidencePaths) return refuse("too many paths");
    const paths: string[] = [];
    for (const raw of entry.paths) {
      const path = citedPath(raw);
      if (path === undefined) return refuse("invalid path");
      if (!paths.includes(path)) paths.push(path);
    }
    evidence.push(Object.freeze({ claim, paths: Object.freeze(paths) }));
  }
  if (value.checks.length > L.maxChecksPerReport) return refuse("too many checks");
  const checks: FileCheck[] = [];
  for (const raw of value.checks) {
    const check = fileCheckFrom(raw);
    if (check === undefined) return refuse("invalid check");
    if (!checks.some(c => checkKey(c) === checkKey(check))) checks.push(check);
  }
  let alternatives: string[] = [];
  if (Object.hasOwn(value, "alternatives") && value.alternatives !== null) {
    if (!Array.isArray(value.alternatives)) return refuse("schema mismatch");
    if (value.alternatives.length > L.maxAlternatives) return refuse("too many alternatives");
    for (const raw of value.alternatives) {
      if (typeof raw !== "string") return refuse("schema mismatch");
      const text = boundedModelText(raw, L.maxAlternativeChars);
      if (text === undefined) { if (raw.trim().length === 0) continue; return refuse("alternative too long"); }
      alternatives.push(text);
    }
    alternatives = [...new Set(alternatives)];
  }
  return Object.freeze({ accepted: true, report: Object.freeze({ verdict, hypothesis, summary, evidence: Object.freeze(evidence),
    checks: Object.freeze(checks), alternatives: Object.freeze(alternatives) }) });
}

// ---------------------------------------------------------------- the falsifier's report

/**
 * v0.4: what a FALSIFIER returns — a fresh reviewer that saw only Fusion's facts and tried to BREAK the current conclusion.
 * `checks` are what a file must contain or lack IF THE CONCLUSION IS RIGHT, chosen to fail if it is wrong; Fusion runs them.
 * Counterexamples and missing evidence are untrusted challenges: they are recorded and adjudicated, never evidence by themselves.
 */
export interface FalsificationReport {
  readonly verdict: "holds" | "broken" | "unclear";
  readonly counterexamples: readonly Readonly<{ claim: string; paths: readonly string[] }>[];
  readonly missingEvidence: readonly string[];
  readonly checks: readonly FileCheck[];
}
export const FALSIFICATION_LIMITS = Object.freeze({ maxCounterexamples: 4, maxCounterexampleChars: 280, maxPaths: 4, maxMissing: 4, maxMissingChars: 200,
  maxChecks: 3 });
export type FalsificationReading = Readonly<{ accepted: true; report: FalsificationReport }> | Readonly<{ accepted: false; category: HypothesisRejection }>;
/**
 * v0.4 (third live run): the falsification report as a JSON Schema, for a transport that constrains its final answer natively.
 * It is never looser than `falsificationReportFrom`, which still decides: every field required (the strict wire form), closed
 * objects, the same enums and bounds. It uses only keywords the validated structured review turn already sends.
 */
export const FALSIFICATION_REPORT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object", additionalProperties: false, required: ["verdict", "counterexamples", "missingEvidence", "checks"],
  properties: {
    verdict: { type: "string", enum: ["holds", "broken", "unclear"] },
    counterexamples: { type: "array", maxItems: FALSIFICATION_LIMITS.maxCounterexamples, items: { type: "object", additionalProperties: false,
      required: ["claim", "paths"], properties: { claim: { type: "string", minLength: 1, maxLength: FALSIFICATION_LIMITS.maxCounterexampleChars },
        paths: { type: "array", maxItems: FALSIFICATION_LIMITS.maxPaths, items: { type: "string", minLength: 1, maxLength: 300 } } } } },
    missingEvidence: { type: "array", maxItems: FALSIFICATION_LIMITS.maxMissing, items: { type: "string", minLength: 1, maxLength: FALSIFICATION_LIMITS.maxMissingChars } },
    checks: { type: "array", maxItems: FALSIFICATION_LIMITS.maxChecks, items: { type: "object", additionalProperties: false, required: ["file", "text", "expect"],
      properties: { file: { type: "string", minLength: 1, maxLength: 300 }, text: { type: "string", minLength: 1, maxLength: HYPOTHESIS_LIMITS.maxCheckTextChars },
        expect: { type: "string", enum: ["present", "absent"] } } } },
  },
});
/** A falsifier's report from an already-decoded JSON value: `verdict`, `counterexamples`, `missingEvidence`, `checks`; bounded. */
export function falsificationReportFrom(value: unknown): FalsificationReading {
  const refuse = (category: HypothesisRejection): FalsificationReading => Object.freeze({ accepted: false, category });
  const L = FALSIFICATION_LIMITS;
  if (!isRecord(value) || !keysExactly(value, ["verdict", "counterexamples", "checks"], ["missingEvidence"])) return refuse("schema mismatch");
  if (value.verdict !== "holds" && value.verdict !== "broken" && value.verdict !== "unclear")
    return refuse(typeof value.verdict === "string" ? "unknown verdict" : "schema mismatch");
  if (!Array.isArray(value.counterexamples) || !Array.isArray(value.checks)) return refuse("schema mismatch");
  if (value.counterexamples.length > L.maxCounterexamples) return refuse("too many evidence items");
  const counterexamples: Array<Readonly<{ claim: string; paths: readonly string[] }>> = [];
  for (const entry of value.counterexamples) {
    if (!isRecord(entry) || !keysExactly(entry, ["claim", "paths"]) || typeof entry.claim !== "string" || !Array.isArray(entry.paths)) return refuse("schema mismatch");
    const claim = boundedModelText(entry.claim, L.maxCounterexampleChars);
    if (claim === undefined) return refuse(entry.claim.trim().length === 0 ? "schema mismatch" : "evidence too long");
    if (entry.paths.length > L.maxPaths) return refuse("too many paths");
    const paths: string[] = [];
    for (const raw of entry.paths) {
      const path = citedPath(raw);
      if (path === undefined) return refuse("invalid path");
      if (!paths.includes(path)) paths.push(path);
    }
    counterexamples.push(Object.freeze({ claim, paths: Object.freeze(paths) }));
  }
  let missingEvidence: string[] = [];
  if (Object.hasOwn(value, "missingEvidence") && value.missingEvidence !== null) {
    if (!Array.isArray(value.missingEvidence)) return refuse("schema mismatch");
    if (value.missingEvidence.length > L.maxMissing) return refuse("too many alternatives");
    for (const raw of value.missingEvidence) {
      if (typeof raw !== "string") return refuse("schema mismatch");
      const text = boundedModelText(raw, L.maxMissingChars);
      if (text === undefined) { if (raw.trim().length === 0) continue; return refuse("alternative too long"); }
      missingEvidence.push(text);
    }
    missingEvidence = [...new Set(missingEvidence)];
  }
  if (value.checks.length > L.maxChecks) return refuse("too many checks");
  const checks: FileCheck[] = [];
  for (const raw of value.checks) {
    const check = fileCheckFrom(raw);
    if (check === undefined) return refuse("invalid check");
    if (!checks.some(c => checkKey(c) === checkKey(check))) checks.push(check);
  }
  return Object.freeze({ accepted: true, report: Object.freeze({ verdict: value.verdict, counterexamples: Object.freeze(counterexamples),
    missingEvidence: Object.freeze(missingEvidence), checks: Object.freeze(checks) }) });
}

// ---------------------------------------------------------------- checks Fusion derives and runs

const NEGATION = /\b(?:not|no|never|none|without|missing|lacks?|lacking|absent|isn'?t|aren'?t|doesn'?t|don'?t|won'?t|cannot|can'?t|fails? to|nicht|kein\w*|ohne|fehlt|fehlen)\b/iu;
const LITERAL = /`([^`\r\n]{1,120})`/gu;
/**
 * The checks Fusion derives from a claim's own words — conservatively: only for a claim with no negation, exactly one named
 * file (among `files`, the shared files it mentions) and backtick-quoted literals: "configuration.yaml already sets
 * `trusted_proxies`" predicts that configuration.yaml contains `trusted_proxies`. Anything less clear derives nothing.
 */
export function derivedChecks(claim: string, files: readonly string[]): readonly FileCheck[] {
  if (NEGATION.test(claim) || files.length !== 1) return Object.freeze([]);
  const literals = [...new Set([...claim.matchAll(LITERAL)].map(m => m[1]!).filter(text => text.trim().length > 0 && !CHECK_TEXT_CONTROL.test(text)))];
  // The file's own name quoted is not a prediction about its content.
  const file = files[0]!;
  return Object.freeze(literals.filter(text => text !== file && !file.endsWith(`/${text}`)).slice(0, 2)
    .map(text => Object.freeze({ file, text, expect: "present" as const })));
}

/** One check as Fusion ran it on the shared copy. `holds`: what it tests is consistent with the file; undefined: it did not run. */
export interface CheckResult {
  readonly id: string;
  readonly check: FileCheck;
  /** Who proposed it: investigator ids (`h1`), `falsifier`, or `fusion` (derived from the claim's words). */
  readonly proposedBy: readonly string[];
  /** What it tests: the claim under check, or a hypothesis id. */
  readonly target: string;
  readonly outcome: Readonly<{ ran: true; present: boolean; holds: boolean }> | Readonly<{ ran: false; reason: CheckRefusal }>;
  /** Several investigators disagreed about what it tests: it discriminates between them. */
  readonly discriminating: boolean;
}
/** Why Fusion did not run a proposed check. */
export type CheckRefusal = "not shared" | "too large" | "not a text file" | "route limit";
/** The result of a check that ran: the file shows `text` (present) or not, and whether that is what the prediction said. */
export function checkOutcome(check: FileCheck, content: string): Readonly<{ ran: true; present: boolean; holds: boolean }> {
  const present = content.includes(check.text);
  return Object.freeze({ ran: true, present, holds: present === (check.expect === "present") });
}
/** A check in plain words: `configuration.yaml contains "trusted_proxies"`. */
export function describeCheck(check: FileCheck): string {
  return `${check.file} ${check.expect === "present" ? "contains" : "lacks"} "${check.text}"`;
}
