/**
 * v0.3 — THE CONTRACTS OF ADAPTIVE ORCHESTRATION. Roles talk to each other only through bounded, host-validated objects,
 * never through transcripts:
 *
 *   - a ROUTING DECISION the lead proposes (answer now, delegate investigations, synthesize, stop) — a closed JSON object
 *     read strictly against the actions and areas the host allows at that moment; anything else is refused with a category;
 *   - an INVESTIGATION PACKET the host builds for one explorer (its area, question, optional claim to check, bounded prior
 *     findings, its budget) — no lead reasoning, no other explorer's output, no conversation;
 *   - an INVESTIGATION REPORT the explorer returns — a closed JSON object (status, verdict on the claim, summary, findings
 *     with the paths they rest on, open questions, contradictions), validated and bounded here; the host then checks each
 *     cited path against the view it shared;
 *   - the SYNTHESIS EVIDENCE the lead reclaims the task with — the host's rendering of the validated reports plus the host's
 *     own assessment (failed investigations, inconclusive reports, conflicting verdicts, uncited claims).
 *
 * Everything here is provider-neutral and pure. Model output is untrusted data: a value is either accepted in exactly the
 * closed shape, or refused with a structural category that never contains any of its text. No contract has a field that
 * could widen access, raise a budget or grant a write.
 */

export const ORCHESTRATION_LIMITS = Object.freeze({
  /** A question the lead asks an explorer, and a claim to check. */
  maxQuestionChars: 200,
  maxClaimChars: 300,
  /** An explorer report. */
  maxSummaryChars: 1_500,
  maxReportFindings: 8,
  maxFindingChars: 280,
  maxFindingPaths: 6,
  maxPathChars: 300,
  maxOpenQuestions: 4,
  maxContradictions: 4,
  maxNoteChars: 200,
  /** Findings of earlier batches handed to a follow-up packet. */
  maxPriorFindings: 6,
  /**
   * The files a read-only investigator (an explorer, a hypothesis, the falsifier) is told it may open in one turn. v0.4: the
   * validated read-only binding runs at most 4 model steps, every file opened spends one, and the answer needs a step of its
   * own — so 3, never 4: a turn that spends its last step on a tool call is ended as failed by the runtime itself.
   */
  explorerFiles: 3,
  /** An unstructured explorer reply as it enters the synthesis. */
  maxUnstructuredChars: 4_000,
  /** The whole evidence block the lead reclaims the task with. */
  maxEvidenceChars: 24_000,
});

// ---------------------------------------------------------------- routing decisions

export type RouteAction = "answer" | "delegate" | "synthesize" | "stop";
export const ROUTE_ACTIONS: readonly RouteAction[] = Object.freeze(["answer", "delegate", "synthesize", "stop"]);
/** An area the host offers for investigation: an inventory directory (`.` for the root files). */
export interface AreaChoice {
  readonly id: string;
  readonly files: number;
  /** Every inventoried file of the area is withheld from providers: never assignable. */
  readonly withheld?: boolean;
}
/** One investigation the lead asks for. */
export interface InvestigationRequest {
  readonly area: string;
  readonly question: string;
}
export type RoutingDecision =
  | Readonly<{ action: "answer" }>
  | Readonly<{ action: "delegate"; claim?: string; investigations: readonly InvestigationRequest[] }>
  | Readonly<{ action: "synthesize" }>
  | Readonly<{ action: "stop" }>;
/** What the host allows the lead to decide right now. */
export interface DecisionRules {
  readonly allowed: readonly RouteAction[];
  readonly areas: readonly AreaChoice[];
  /** Investigations one delegation may ask for (the batch capacity the budget leaves; 0 forbids delegation). */
  readonly maxInvestigations: number;
  /** Whether a delegation may name its own claim (a verification route supplies the claim itself). */
  readonly claimAllowed: boolean;
}
/** Why a routing decision was not accepted: a structural category only. */
export type DecisionRejection = "empty reply" | "oversized reply" | "invalid JSON" | "prose around the JSON" | "more than one JSON value or fence" |
  "malformed fence" | "schema mismatch" | "unknown action" | "action not allowed now" | "no investigations" | "too many investigations" |
  "unknown area" | "withheld area" | "duplicate area" | "question too long" | "claim too long" | "claim not allowed";
export type DecisionReading = Readonly<{ accepted: true; decision: RoutingDecision }> | Readonly<{ accepted: false; category: DecisionRejection }>;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keysExactly = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
/** Text a model wrote, as the host keeps it: control and bidi characters removed, trimmed; undefined when empty or too long. */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/gu;
const HAS_CONTROL = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u;
export function boundedModelText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length > max * 2) return undefined;
  const text = value.replace(/\r\n/gu, "\n").replace(CONTROL, "").trim();
  return text.length === 0 || text.length > max ? undefined : text;
}
/** An area id as a model may spell it: `src`, `src/`, `./src` (root: `.` or `./`). */
export function normalizeAreaId(value: string): string {
  const id = value.trim().replace(/^\.\/(?=.)/u, "").replace(/(?<=.)\/$/u, "");
  return id === "./" ? "." : id;
}

/**
 * The lead's routing decision, from an already-decoded JSON value (the caller reads the reply's envelope). Closed shapes:
 * `{"action":"answer"}`, `{"action":"synthesize"}`, `{"action":"stop"}` and
 * `{"action":"delegate","investigations":[{"area","question"}],"claim"?}` with 1..maxInvestigations entries over the
 * offered areas, each area once. Nothing is repaired but an area id's spelling.
 */
export function routingDecisionFrom(value: unknown, rules: DecisionRules): DecisionReading {
  const refuse = (category: DecisionRejection): DecisionReading => Object.freeze({ accepted: false, category });
  if (!isRecord(value) || typeof value.action !== "string") return refuse("schema mismatch");
  const action = value.action as RouteAction;
  if (!ROUTE_ACTIONS.includes(action)) return refuse("unknown action");
  if (!rules.allowed.includes(action)) return refuse("action not allowed now");
  if (action !== "delegate") return keysExactly(value, ["action"]) ? Object.freeze({ accepted: true, decision: Object.freeze({ action }) }) : refuse("schema mismatch");
  if (!keysExactly(value, ["action", "investigations"], ["claim"]) || !Array.isArray(value.investigations)) return refuse("schema mismatch");
  let claim: string | undefined;
  if (Object.hasOwn(value, "claim") && value.claim !== null) {
    if (!rules.claimAllowed) return refuse("claim not allowed");
    if (typeof value.claim !== "string") return refuse("schema mismatch");
    claim = boundedModelText(value.claim, ORCHESTRATION_LIMITS.maxClaimChars);
    if (claim === undefined) return refuse(value.claim.trim().length === 0 ? "schema mismatch" : "claim too long");
  }
  const entries = value.investigations as unknown[];
  if (entries.length === 0) return refuse("no investigations");
  if (rules.maxInvestigations < 1) return refuse("action not allowed now");
  if (entries.length > rules.maxInvestigations) return refuse("too many investigations");
  const areas = new Map(rules.areas.map(area => [area.id, area]));
  const investigations: InvestigationRequest[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !keysExactly(entry, ["area", "question"]) || typeof entry.area !== "string" || typeof entry.question !== "string")
      return refuse("schema mismatch");
    const area = areas.get(normalizeAreaId(entry.area));
    if (area === undefined) return refuse("unknown area");
    if (area.withheld === true) return refuse("withheld area");
    if (investigations.some(i => i.area === area.id)) return refuse("duplicate area");
    const question = boundedModelText(entry.question, ORCHESTRATION_LIMITS.maxQuestionChars);
    if (question === undefined) return refuse(entry.question.trim().length === 0 ? "schema mismatch" : "question too long");
    investigations.push(Object.freeze({ area: area.id, question }));
  }
  return Object.freeze({ accepted: true, decision: Object.freeze({ action: "delegate" as const, investigations: Object.freeze(investigations),
    ...(claim === undefined ? {} : { claim }) }) });
}

// ---------------------------------------------------------------- investigation packets

/** What one explorer is given: its packet only. */
export interface InvestigationPacket {
  /** `b<batch>-i<n>`: stable within a route; a repeat keeps the id. */
  readonly id: string;
  readonly batch: number;
  /** 1, or 2 for the one repeat of a failed investigation. */
  readonly attempt: number;
  readonly area: string;
  readonly files: number;
  /** Key files of the area from Fusion's inventory (a starting point, not a limit). */
  readonly start: readonly string[];
  readonly question: string;
  /** A claim the explorer judges within its area (a verification). */
  readonly claim?: string;
  readonly plannedBy: "lead" | "fusion";
  /** Bounded findings of earlier batches about this area (validated explorer findings only, never a transcript). */
  readonly priorFindings: readonly string[];
  /** The files the explorer may open in its turn. */
  readonly maxFiles: number;
}

// ---------------------------------------------------------------- investigation reports

export type InvestigationStatus = "answered" | "inconclusive";
export type ClaimVerdict = "supported" | "contradicted" | "unclear";
export interface InvestigationFinding {
  readonly claim: string;
  /** Repository paths the finding rests on, as the explorer named them (the host checks them against the shared view). */
  readonly paths: readonly string[];
}
export interface InvestigationReport {
  readonly status: InvestigationStatus;
  /** Present when the packet carried a claim. */
  readonly verdict?: ClaimVerdict;
  readonly summary: string;
  readonly findings: readonly InvestigationFinding[];
  readonly openQuestions: readonly string[];
  readonly contradictions: readonly string[];
}
export type ReportRejection = "schema mismatch" | "unknown status" | "unknown verdict" | "verdict missing" | "summary too long" |
  "too many findings" | "finding too long" | "too many paths" | "invalid path" | "too many questions" | "note too long";
export type ReportReading = Readonly<{ accepted: true; report: InvestigationReport }> | Readonly<{ accepted: false; category: ReportRejection }>;

/** A relative, `/`-separated repository path as a model may cite it; undefined for anything else (absolute, `..`, a URL). */
export function citedPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim().replace(/^\.\//u, "").replace(/[`'"]/gu, "");
  if (path.length === 0 || path.length > ORCHESTRATION_LIMITS.maxPathChars || /^[\\/]|^[A-Za-z]:|\\|^[a-z]+:\/\//iu.test(path)) return undefined;
  const segments = path.replace(/:\d+(?:-\d+)?$/u, "").split("/");
  if (segments.some(s => s === "" || s === "." || s === ".." || HAS_CONTROL.test(s))) return undefined;
  return segments.join("/");
}

const strings = (value: unknown, maxItems: number, maxChars: number): string[] | "too many" | "too long" | undefined => {
  if (!Array.isArray(value)) return undefined;
  if (value.length > maxItems) return "too many";
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const text = boundedModelText(item, maxChars);
    if (text === undefined) { if (item.trim().length === 0) continue; return "too long"; }
    out.push(text);
  }
  return out;
};

/**
 * An explorer's report, from an already-decoded JSON value. The closed shape: `status` ("answered" | "inconclusive"),
 * `summary`, `findings` [{claim, paths}], `openQuestions`, and optionally `verdict` ("supported" | "contradicted" |
 * "unclear", required when the packet carried a claim) and `contradictions`. Bounded everywhere; refused otherwise.
 */
export function investigationReportFrom(value: unknown, packet: Readonly<{ claim?: string }>): ReportReading {
  const refuse = (category: ReportRejection): ReportReading => Object.freeze({ accepted: false, category });
  const L = ORCHESTRATION_LIMITS;
  if (!isRecord(value) || !keysExactly(value, ["status", "summary", "findings", "openQuestions"], ["verdict", "contradictions"]))
    return refuse("schema mismatch");
  if (value.status !== "answered" && value.status !== "inconclusive") return refuse(typeof value.status === "string" ? "unknown status" : "schema mismatch");
  let verdict: ClaimVerdict | undefined;
  if (Object.hasOwn(value, "verdict") && value.verdict !== null) {
    if (value.verdict !== "supported" && value.verdict !== "contradicted" && value.verdict !== "unclear")
      return refuse(typeof value.verdict === "string" ? "unknown verdict" : "schema mismatch");
    verdict = value.verdict;
  }
  if (packet.claim !== undefined && verdict === undefined) return refuse("verdict missing");
  if (typeof value.summary !== "string") return refuse("schema mismatch");
  const summary = boundedModelText(value.summary, L.maxSummaryChars);
  if (summary === undefined) return refuse(value.summary.trim().length === 0 ? "schema mismatch" : "summary too long");
  if (!Array.isArray(value.findings)) return refuse("schema mismatch");
  if (value.findings.length > L.maxReportFindings) return refuse("too many findings");
  const findings: InvestigationFinding[] = [];
  for (const entry of value.findings) {
    if (!isRecord(entry) || !keysExactly(entry, ["claim", "paths"]) || typeof entry.claim !== "string" || !Array.isArray(entry.paths))
      return refuse("schema mismatch");
    const claim = boundedModelText(entry.claim, L.maxFindingChars);
    if (claim === undefined) return refuse(entry.claim.trim().length === 0 ? "schema mismatch" : "finding too long");
    if (entry.paths.length > L.maxFindingPaths) return refuse("too many paths");
    const paths: string[] = [];
    for (const raw of entry.paths) {
      const path = citedPath(raw);
      if (path === undefined) return refuse("invalid path");
      if (!paths.includes(path)) paths.push(path);
    }
    findings.push(Object.freeze({ claim, paths: Object.freeze(paths) }));
  }
  const openQuestions = strings(value.openQuestions, L.maxOpenQuestions, L.maxNoteChars);
  if (openQuestions === undefined) return refuse("schema mismatch");
  if (openQuestions === "too many") return refuse("too many questions");
  if (openQuestions === "too long") return refuse("note too long");
  let contradictions: string[] = [];
  if (Object.hasOwn(value, "contradictions") && value.contradictions !== null) {
    const read = strings(value.contradictions, L.maxContradictions, L.maxNoteChars);
    if (read === undefined) return refuse("schema mismatch");
    if (read === "too many") return refuse("too many questions");
    if (read === "too long") return refuse("note too long");
    contradictions = read;
  }
  return Object.freeze({ accepted: true, report: Object.freeze({ status: value.status, ...(verdict === undefined ? {} : { verdict }), summary,
    findings: Object.freeze(findings), openQuestions: Object.freeze(openQuestions), contradictions: Object.freeze(contradictions) }) });
}

// ---------------------------------------------------------------- outcomes and the host's assessment

/** A failed investigation, as the host records it: a safe category and message, never provider text. */
export interface InvestigationFailure {
  readonly kind: string;
  /** A safe category (`timeout`, `authentication`, `posture`, `provider failure`, …). */
  readonly category: string;
  readonly message: string;
  readonly retryable: boolean;
}
interface OutcomeBase {
  readonly packet: InvestigationPacket;
  /** `role (provider)` of the partner that served the turn. */
  readonly partner: string;
  readonly durationMs: number;
}
export type InvestigationOutcome =
  | (OutcomeBase & Readonly<{ status: "reported"; report: InvestigationReport; cited: readonly string[]; uncitedPaths: number }>)
  | (OutcomeBase & Readonly<{ status: "unstructured"; rejection: ReportRejection | DecisionRejection; text: string; cited: readonly string[] }>)
  | (OutcomeBase & Readonly<{ status: "failed"; failure: InvestigationFailure }>);

export type WeakEvidence = "failed investigations" | "inconclusive reports" | "conflicting verdicts" | "uncited reports" | "no reports";
export interface EvidenceAssessment {
  readonly sufficient: boolean;
  readonly weak: readonly WeakEvidence[];
  readonly reported: number;
  readonly inconclusive: number;
  readonly unstructured: number;
  readonly failed: number;
  /** Packet ids whose failure the host may repeat (retryable, first attempt). */
  readonly retryable: readonly string[];
  /** The packets that supported and contradicted the claim, when both exist. */
  readonly conflict?: Readonly<{ supported: readonly string[]; contradicted: readonly string[] }>;
  /** Shared files the reports cite (deduplicated). */
  readonly citedFiles: number;
}
const RETRYABLE_KINDS = new Set(["Timeout", "ProcessFailure", "ProtocolError", "MalformedOutput", "SpawnFailure"]);
/** Whether a failed investigation may be repeated: a transient failure only — never authentication, posture or security. */
export function repeatable(failure: InvestigationFailure): boolean {
  return failure.retryable && RETRYABLE_KINDS.has(failure.kind) && failure.category !== "authentication" && failure.category !== "posture";
}

/**
 * The host's own judgement of the evidence of a route so far (the latest outcome per packet). Evidence is SUFFICIENT when
 * every investigation reported, none is inconclusive, verdicts on a claim do not conflict and every report cites at least
 * one shared file. Anything else is weak, with the reasons; what to do about it is the route policy's decision.
 */
export function assessEvidence(outcomes: readonly InvestigationOutcome[]): EvidenceAssessment {
  const latest = new Map<string, InvestigationOutcome>();
  for (const outcome of outcomes) latest.set(outcome.packet.id, outcome);
  const all = [...latest.values()];
  const reported = all.filter((o): o is Extract<InvestigationOutcome, { status: "reported" }> => o.status === "reported");
  const unstructured = all.filter((o): o is Extract<InvestigationOutcome, { status: "unstructured" }> => o.status === "unstructured");
  const failed = all.filter((o): o is Extract<InvestigationOutcome, { status: "failed" }> => o.status === "failed");
  const inconclusive = reported.filter(o => o.report.status === "inconclusive").length;
  const supported = reported.filter(o => o.report.verdict === "supported").map(o => o.packet.id);
  const contradicted = reported.filter(o => o.report.verdict === "contradicted").map(o => o.packet.id);
  const answered = [...reported, ...unstructured];
  const uncited = answered.filter(o => o.cited.length === 0).length;
  const cited = new Set(answered.flatMap(o => [...o.cited]));
  const weak: WeakEvidence[] = [];
  if (all.length > 0 && reported.length + unstructured.length === 0) weak.push("no reports");
  if (failed.length > 0) weak.push("failed investigations");
  if (inconclusive > 0) weak.push("inconclusive reports");
  if (supported.length > 0 && contradicted.length > 0) weak.push("conflicting verdicts");
  if (uncited > 0) weak.push("uncited reports");
  return Object.freeze({ sufficient: all.length > 0 && weak.length === 0, weak: Object.freeze(weak), reported: reported.length, inconclusive,
    unstructured: unstructured.length, failed: failed.length,
    retryable: Object.freeze(failed.filter(o => o.packet.attempt === 1 && repeatable(o.failure)).map(o => o.packet.id)),
    ...(supported.length > 0 && contradicted.length > 0 ? { conflict: Object.freeze({ supported: Object.freeze(supported), contradicted: Object.freeze(contradicted) }) } : {}),
    citedFiles: cited.size });
}

const areaLabel = (area: string): string => area === "." ? "the root files" : `${area}/`;
const clipped = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)}\n[... cut by Fusion at ${max} characters]` : text;

/**
 * The SYNTHESIS EVIDENCE: what the lead reclaims the task with — each investigation's validated report (or its safe failure),
 * the host's assessment in plain words, and the areas no report covers. Bounded; explorer text stays marked as untrusted.
 */
export function renderEvidence(outcomes: readonly InvestigationOutcome[], assessment: EvidenceAssessment, claim?: string): string {
  const latest = new Map<string, InvestigationOutcome>();
  for (const outcome of outcomes) latest.set(outcome.packet.id, outcome);
  const blocks: string[] = [];
  if (claim !== undefined) blocks.push(`Claim under investigation (untrusted text): ${claim}`);
  for (const o of latest.values()) {
    const head = `[${o.packet.id}] ${areaLabel(o.packet.area)} — ${o.partner}`;
    if (o.status === "failed") { blocks.push(`${head}: no report (${o.failure.category}: ${o.failure.message})`); continue; }
    if (o.status === "unstructured") {
      blocks.push(`${head}: an unstructured report (untrusted model text; Fusion could not read its structure: ${o.rejection}). ` +
        `Shared files it names: ${o.cited.join(", ") || "none"}.\n${clipped(o.text, ORCHESTRATION_LIMITS.maxUnstructuredChars)}`);
      continue;
    }
    const r = o.report;
    const lines = [`${head}: ${r.status}${r.verdict ? `, verdict on the claim: ${r.verdict}` : ""}; ${o.cited.length} cited shared file(s)` +
      `${o.uncitedPaths > 0 ? `, ${o.uncitedPaths} cited path(s) not in the shared copy` : ""}`, `  Summary (untrusted): ${r.summary}`];
    for (const f of r.findings) lines.push(`  - ${f.claim}${f.paths.length > 0 ? ` [${f.paths.join(", ")}]` : " [no path]"}`);
    for (const q of r.openQuestions) lines.push(`  Open question: ${q}`);
    for (const c of r.contradictions) lines.push(`  Contradiction noted: ${c}`);
    blocks.push(lines.join("\n"));
  }
  const facts = [`Fusion's assessment: ${assessment.reported} structured report(s), ${assessment.unstructured} unstructured, ${assessment.failed} failed; ` +
    `${assessment.citedFiles} shared file(s) cited.`];
  if (assessment.conflict !== undefined)
    facts.push(`CONFLICT: ${assessment.conflict.supported.join(", ")} support the claim, ${assessment.conflict.contradicted.join(", ")} contradict it. ` +
      "Compare their cited evidence; say which side the files support, or that the conflict is unresolved. Do not invent a consensus.");
  if (!assessment.sufficient) facts.push(`The evidence is incomplete (${assessment.weak.join(", ")}). Distinguish what the reports support from what remains unknown.`);
  return clipped([...blocks, "", ...facts].join("\n\n"), ORCHESTRATION_LIMITS.maxEvidenceChars);
}
