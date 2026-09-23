import { ADJUDICATION_VERDICTS, FINDING_CONFIDENCES, FINDING_SEVERITIES, REQUIRED_ACTIONS, type AdjudicatedFinding,
  type AdjudicationReport, type AgentRole, type Finding, type FindingAdjudication, type FindingFact, type FindingSeverity,
  type ReviewerFinding, type RunId, type SessionId } from "../domain.js";
import { failWith } from "../errors.js";
import { scopeKey } from "../policy/task-inspector.js";

/** Bounds on everything a Reviewer or Lead can hand back. Larger output is malformed, never truncated into validity. */
export const REVIEW_LIMITS = Object.freeze({
  maxFindings: 32, maxTitleChars: 200, maxCategoryChars: 64, maxPathChars: 512, maxEvidenceItems: 8,
  maxEvidenceChars: 1_000, maxScenarioChars: 2_000, maxFixChars: 2_000, maxFacts: 8, maxSummaryChars: 4_000,
  maxRationaleChars: 1_000, maxLine: 10_000_000,
});
/** Severities that block an automatic success until resolved. */
export const MATERIAL_SEVERITIES: ReadonlySet<FindingSeverity> = new Set(["BLOCKER", "HIGH", "MEDIUM"]);

const FINDING_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u;
const CATEGORY = /^[A-Za-z][A-Za-z0-9 _./-]*$/u;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const severities = new Set<unknown>(FINDING_SEVERITIES), confidences = new Set<unknown>(FINDING_CONFIDENCES);
const verdicts = new Set<unknown>(ADJUDICATION_VERDICTS), actions = new Set<unknown>(REQUIRED_ACTIONS);

const malformed = (what: string): never => failWith("MalformedOutput", `The ${what} is invalid.`);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keysWithin = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const text = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0) && !value.includes("\0");
/** Labels that become event fields are single-line. */
const label = (value: unknown, max: number): value is string => text(value, max) && !/[\x00-\x1f\x7f]/u.test(value);
/** Detaches untrusted output from its producer: no getters, proxies or later mutation reach the validator. */
function detach(value: unknown, what: string): unknown {
  try { return structuredClone(value); } catch { return malformed(what); }
}
function repositoryPath(value: unknown): value is string {
  if (!label(value, REVIEW_LIMITS.maxPathChars)) return false;
  const unified = value.replace(/\\/gu, "/");
  return !/^(?:[a-z]:|\/)/iu.test(unified) && !unified.split("/").includes("..") && scopeKey(unified).length > 0;
}

function validateFact(value: unknown): FindingFact {
  if (!isRecord(value)) return malformed("finding fact");
  if (value.kind === "verificationCommand" && keysWithin(value, ["kind", "commandId"]) &&
      typeof value.commandId === "string" && COMMAND_ID.test(value.commandId))
    return { kind: "verificationCommand", commandId: value.commandId };
  if (value.kind === "outOfScopeChange" && keysWithin(value, ["kind", "path"]) && repositoryPath(value.path))
    return { kind: "outOfScopeChange", path: value.path };
  if (value.kind === "unrunClaim" && keysWithin(value, ["kind", "test"]) && text(value.test, REVIEW_LIMITS.maxTitleChars))
    return { kind: "unrunClaim", test: value.test };
  return malformed("finding fact");
}

function validateReviewerFinding(value: unknown): ReviewerFinding {
  if (!isRecord(value) || !keysWithin(value, ["id", "severity", "confidence", "category", "title", "evidence", "failureScenario"],
    ["file", "lines", "suggestedFix", "facts"]))
    return malformed("review finding");
  const { id, severity, confidence, category, title, evidence, failureScenario, file, lines, suggestedFix, facts } = value;
  if (typeof id !== "string" || !FINDING_KEY.test(id) || !severities.has(severity) || !confidences.has(confidence) ||
      !label(category, REVIEW_LIMITS.maxCategoryChars) || !CATEGORY.test(category) || !label(title, REVIEW_LIMITS.maxTitleChars) ||
      !Array.isArray(evidence) || evidence.length === 0 || evidence.length > REVIEW_LIMITS.maxEvidenceItems ||
      !evidence.every(item => text(item, REVIEW_LIMITS.maxEvidenceChars)) || !text(failureScenario, REVIEW_LIMITS.maxScenarioChars) ||
      (file !== undefined && !repositoryPath(file)) ||
      (suggestedFix !== undefined && !text(suggestedFix, REVIEW_LIMITS.maxFixChars)) ||
      (facts !== undefined && (!Array.isArray(facts) || facts.length > REVIEW_LIMITS.maxFacts)))
    return malformed("review finding");
  let range: { start: number; end: number } | undefined;
  if (lines !== undefined) {
    if (!isRecord(lines) || !keysWithin(lines, ["start", "end"]) || !Number.isSafeInteger(lines.start) ||
        !Number.isSafeInteger(lines.end) || (lines.start as number) < 1 || (lines.end as number) < (lines.start as number) ||
        (lines.end as number) > REVIEW_LIMITS.maxLine || file === undefined)
      return malformed("review finding");
    range = { start: lines.start as number, end: lines.end as number };
  }
  return { id, severity: severity as ReviewerFinding["severity"], confidence: confidence as ReviewerFinding["confidence"],
    category, title, evidence: [...(evidence as string[])], failureScenario,
    ...(file === undefined ? {} : { file: file as string }), ...(range ? { lines: range } : {}),
    ...(suggestedFix === undefined ? {} : { suggestedFix: suggestedFix as string }),
    ...(facts === undefined ? {} : { facts: (facts as unknown[]).map(validateFact) }) };
}

export interface FindingProvenance {
  readonly cycle: number;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly role: AgentRole;
}
/**
 * Validates a Reviewer's structured report and assigns canonical, deterministic identity (`r<cycle>-<key>`) and
 * provenance. A report without a valid findings array is not a review, whatever its prose says.
 */
export function validateReviewReport(raw: unknown, provenance: FindingProvenance): readonly Finding[] {
  const value = detach(raw, "review report");
  if (!isRecord(value) || !keysWithin(value, ["findings", "summary"]) || !Array.isArray(value.findings) ||
      value.findings.length > REVIEW_LIMITS.maxFindings || !text(value.summary, REVIEW_LIMITS.maxSummaryChars, true))
    return malformed("review report");
  const drafts = value.findings.map(validateReviewerFinding);
  const keys = new Set<string>();
  for (const draft of drafts) {
    const key = draft.id.toLowerCase();
    if (keys.has(key)) return malformed("review report (duplicate finding ID)");
    keys.add(key);
  }
  return Object.freeze(drafts.map(({ id, facts, ...rest }) => Object.freeze({ ...rest, id: `r${provenance.cycle}-${id}`,
    facts: Object.freeze([...(facts ?? [])]), source: Object.freeze({ role: provenance.role, runId: provenance.runId,
      sessionId: provenance.sessionId, cycle: provenance.cycle }) })));
}

/**
 * Validates a Lead's adjudication against exactly the finding set it was given: one verdict per finding, no
 * unknown, missing or repeated IDs, and a required action consistent with the verdict and the severity.
 */
export function validateAdjudicationReport(raw: unknown, findings: readonly Finding[]): AdjudicationReport {
  const value = detach(raw, "adjudication report");
  if (!isRecord(value) || !keysWithin(value, ["adjudications", "summary"]) || !Array.isArray(value.adjudications) ||
      value.adjudications.length > REVIEW_LIMITS.maxFindings || !text(value.summary, REVIEW_LIMITS.maxSummaryChars, true))
    return malformed("adjudication report");
  const byId = new Map(findings.map(finding => [finding.id, finding]));
  const seen = new Set<string>();
  const adjudications: FindingAdjudication[] = [];
  for (const entry of value.adjudications) {
    if (!isRecord(entry) || !keysWithin(entry, ["findingId", "verdict", "rationale", "requiredAction"]) ||
        typeof entry.findingId !== "string" || !verdicts.has(entry.verdict) || !actions.has(entry.requiredAction) ||
        !text(entry.rationale, REVIEW_LIMITS.maxRationaleChars))
      return malformed("adjudication");
    const finding = byId.get(entry.findingId);
    if (finding === undefined || seen.has(entry.findingId)) return malformed("adjudication finding set");
    seen.add(entry.findingId);
    const verdict = entry.verdict as FindingAdjudication["verdict"], action = entry.requiredAction as FindingAdjudication["requiredAction"];
    const material = MATERIAL_SEVERITIES.has(finding.severity);
    const consistent = verdict === "REJECTED" ? action === "none"
      : verdict === "UNVERIFIABLE" ? action === "none" || action === "humanDecision"
      : material ? action === "fix" || action === "humanDecision" : true;
    if (!consistent) return malformed("adjudication (required action contradicts the verdict)");
    adjudications.push({ findingId: entry.findingId, verdict, rationale: entry.rationale, requiredAction: action });
  }
  if (seen.size !== findings.length) return malformed("adjudication finding set (missing verdict)");
  return { adjudications, summary: value.summary as string };
}

/** What Fusion itself observed; the only authority for a finding's checkable facts. */
export interface ObservedState {
  readonly verification: ReadonlyMap<string, boolean>;
  readonly changedPaths: readonly string[];
  readonly allowedScope: readonly string[];
  /** Checks the implementer reported having run. */
  readonly claimedTests: readonly string[];
}
export function evaluateFacts(finding: Finding, observed: ObservedState): { supported: FindingFact[]; contradicted: FindingFact[] } {
  const changed = new Set(observed.changedPaths.map(scopeKey)), allowed = new Set(observed.allowedScope.map(scopeKey));
  const claimed = new Set(observed.claimedTests.map(test => test.trim().toLowerCase()));
  const supported: FindingFact[] = [], contradicted: FindingFact[] = [];
  for (const fact of finding.facts) {
    let holds: boolean | undefined;
    if (fact.kind === "verificationCommand") {
      const passed = observed.verification.get(fact.commandId);
      holds = passed === undefined ? undefined : !passed;
    } else if (fact.kind === "outOfScopeChange") {
      const key = scopeKey(fact.path);
      holds = changed.has(key) && !allowed.has(key);
    } else {
      const test = fact.test.trim().toLowerCase();
      holds = claimed.has(test) && !observed.verification.has(fact.test);
    }
    if (holds === true) supported.push(fact);
    else if (holds === false) contradicted.push(fact);
  }
  return { supported, contradicted };
}

/**
 * Joins validated verdicts to their findings. Fusion's deterministic evidence outranks the Lead: a finding with a
 * supported fact cannot be REJECTED or left UNVERIFIABLE; it is recorded as CONFIRMED from `fusionEvidence`.
 */
export function adjudicate(findings: readonly Finding[], report: AdjudicationReport,
  facts: ReadonlyMap<string, readonly FindingFact[]>): readonly AdjudicatedFinding[] {
  const verdictFor = new Map(report.adjudications.map(entry => [entry.findingId, entry]));
  return Object.freeze(findings.map(finding => {
    const entry = verdictFor.get(finding.id) ?? malformed("adjudication finding set");
    const supportedFacts = [...(facts.get(finding.id) ?? [])];
    const overridden = supportedFacts.length > 0 && (entry.verdict === "REJECTED" || entry.verdict === "UNVERIFIABLE");
    return Object.freeze(overridden
      ? { finding, verdict: "CONFIRMED" as const, rationale: entry.rationale,
          requiredAction: MATERIAL_SEVERITIES.has(finding.severity) ? "fix" as const : "followUp" as const,
          verdictSource: "fusionEvidence" as const, supportedFacts: Object.freeze(supportedFacts) }
      : { finding, verdict: entry.verdict, rationale: entry.rationale, requiredAction: entry.requiredAction,
          verdictSource: "lead" as const, supportedFacts: Object.freeze(supportedFacts) });
  }));
}
