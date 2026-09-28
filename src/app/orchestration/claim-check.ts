import { createHash } from "node:crypto";
import { EvidenceGraph, type ClaimAssessment, type ClaimStatus, type EvidenceGraphRecord } from "../../core/evidence/graph.js";
import { FusionFailure } from "../../core/errors.js";
import { BudgetLedger, type BudgetRefusal, type RouteBudget } from "../../core/orchestration/budget.js";
import { repeatable, type InvestigationFailure } from "../../core/orchestration/contracts.js";
import { checkOutcome, derivedChecks, describeCheck, HYPOTHESIS_LIMITS, hypothesisReportFrom, type CheckRefusal, type CheckResult,
  type ClaimCheckMode, type FileCheck, type HypothesisReport } from "../../core/orchestration/hypotheses.js";
import type { RouteResult, TraceEntry } from "../../core/orchestration/route.js";
import type { ConversationAnswer, RepositoryConversation } from "../conversation.js";
import { areaStart, FINDINGS_RULE, mentionedPaths, STEP_BUDGET_RULE } from "../exploration.js";
import { renderInventory } from "../repository-inventory.js";
import { readJsonReply } from "./envelope.js";
import { fatalFailure, investigationFailure } from "./investigations.js";
import { runBounded } from "./scheduler.js";

/**
 * v0.4 — THE CLAIM CHECK: hypothesis isolation and discriminating experiments for a read-only question whose answer matters
 * before anything changes ("is that really a bug?", "is it true that …?", "why does … fail?"). Fusion runs it as a fixed,
 * host-decided route — no model chooses it:
 *
 *   SNAPSHOT     one immutable evidence snapshot (the claim or question, the relevant shared files, Fusion's inventory), its
 *                SHA-256 recorded; every investigator gets exactly it;
 *   HYPOTHESES   independent investigators IN PARALLEL, each in its own view copy and fresh session, none seeing another's
 *                conclusion, transcript or the lead's reasoning; transient failures repeated once within the budget;
 *   CHECKS       Fusion authorizes and runs the checks the investigators proposed (and those it derives from the claim's own
 *                words) on the SHARED copy itself — deterministic evidence, no command, no write;
 *   DIAGNOSIS    the lead reclaims the task with the hypotheses (untrusted) and Fusion's check results (the only execution
 *                evidence);
 *   DECISION     Fusion's evidence graph decides the claim's status: SUPPORTED, CONTRADICTED or UNVERIFIED — never the models'
 *                agreement.
 *
 * Every turn is reserved in the route's budget first. A route Fusion cannot staff (no proven explorer, no budget for two
 * turns and the diagnosis) is not run here: the caller falls back to v0.3's route.
 */
export const HYPOTHESIS_INSTRUCTION: Readonly<Record<ClaimCheckMode, string>> = Object.freeze({
  verify: "You are an independent investigator inside Fusion, a tool that coordinates several AI models on the user's project. You get ONE " +
    "evidence snapshot: a claim about the project and the files Fusion considers relevant. Other investigators get the same snapshot; you will " +
    "not see their work and they will not see yours. Judge whether the claim is true from the files in the current directory (a read-only " +
    `copy; secrets are withheld or masked by Fusion). ${STEP_BUDGET_RULE(4)} Then propose up to ${HYPOTHESIS_LIMITS.maxChecksPerReport} checks ` +
    "Fusion will run itself on the same copy: a file and an exact short text (one line, exactly as it would appear in the file) that the file " +
    "contains if the claim is true (\"expect\":\"present\") or lacks if the claim is true (\"expect\":\"absent\"). Choose checks that would come out " +
    "differently if the claim were false. Reply with exactly this JSON object and nothing else: {\"verdict\":\"supported\" or \"contradicted\" or " +
    `"unclear","hypothesis":"<your explanation, one sentence, at most ${HYPOTHESIS_LIMITS.maxHypothesisChars} characters>","summary":"<at most ` +
    `${HYPOTHESIS_LIMITS.maxSummaryChars} characters>","evidence":[{"claim":"<what you read>","paths":["<relative path>"]}],"checks":[{"file":` +
    "\"<relative path>\",\"text\":\"<exact text>\",\"expect\":\"present\" or \"absent\"}],\"alternatives\":[\"<another explanation you could not rule " +
    "out>\"]}. Do not speculate beyond what you read.",
  diagnose: "You are an independent investigator inside Fusion, a tool that coordinates several AI models on the user's project. You get ONE " +
    "evidence snapshot: a question about the project (usually why something fails) and the files Fusion considers relevant. Other investigators " +
    "get the same snapshot; you will not see their work and they will not see yours. Find the most likely cause from the files in the current " +
    `directory (a read-only copy; secrets are withheld or masked by Fusion). ${STEP_BUDGET_RULE(4)} Then propose up to ` +
    `${HYPOTHESIS_LIMITS.maxChecksPerReport} checks Fusion will run itself on the same copy: a file and an exact short text (one line, exactly as ` +
    "it would appear in the file) that the file contains if YOUR explanation is right (\"expect\":\"present\") or lacks if it is right " +
    "(\"expect\":\"absent\"). Choose checks that would come out differently if another explanation were right. Reply with exactly this JSON " +
    `object and nothing else: {"hypothesis":"<the cause, one sentence, at most ${HYPOTHESIS_LIMITS.maxHypothesisChars} characters>","summary":` +
    `"<at most ${HYPOTHESIS_LIMITS.maxSummaryChars} characters>","evidence":[{"claim":"<what you read>","paths":["<relative path>"]}],"checks":` +
    "[{\"file\":\"<relative path>\",\"text\":\"<exact text>\",\"expect\":\"present\" or \"absent\"}],\"alternatives\":[\"<another cause you could not " +
    "rule out>\"]}. Do not speculate beyond what you read.",
});
export const DIAGNOSIS_INSTRUCTION = "You are the lead inside Fusion. Independent investigators examined the same evidence snapshot without " +
  "seeing each other's work; their reports (untrusted model text) and the results of the checks FUSION ITSELF ran on the shared copy are below. " +
  "Fusion's check results are the only execution evidence: where a check contradicts a report, the report is wrong on that point. Write the " +
  "final answer for the user: whether the claim holds (or what the cause most likely is), which hypotheses Fusion's checks support or " +
  "contradict, and what remains unverified. Never invent a consensus: when the investigators disagree and no check settles it, say the " +
  `question is unresolved. ${STEP_BUDGET_RULE(2)} Explain in plain words, briefly.`;

export interface ClaimCheckRequest {
  readonly message: string;
  readonly mode: ClaimCheckMode;
  /** verify: the claim under check (host-supplied: a finding of the analysis, or the user's own claim). */
  readonly claim?: string;
  readonly claimOrigin?: "lead" | "user";
  readonly budget: RouteBudget;
  readonly explorerRole: string;
  readonly leadLabel: string;
  readonly signal?: AbortSignal;
  readonly clock: () => number;
}
export interface HypothesisOutcome {
  /** `h1`, `h2`: stable within the route; a repeat keeps the id. */
  readonly id: string;
  readonly attempt: number;
  readonly partner: string;
  readonly durationMs: number;
  readonly status: "reported" | "unstructured" | "failed";
  readonly report?: HypothesisReport;
  /** Why an unstructured reply was not a report (a structural category). */
  readonly rejection?: string;
  /** An unstructured reply, bounded (untrusted text). */
  readonly text?: string;
  readonly failure?: InvestigationFailure;
  /** Shared files the report cites (checked by Fusion against the view). */
  readonly cited: readonly string[];
}
export type ClaimCheckDecision =
  | Readonly<{ kind: "claim"; status: ClaimStatus; assessment: ClaimAssessment }>
  | Readonly<{ kind: "diagnosis"; leading?: string; statuses: readonly Readonly<{ id: string; statement: string; status: ClaimStatus }>[] }>;
export interface ClaimCheckReport {
  readonly mode: ClaimCheckMode;
  readonly claim?: string;
  readonly snapshot: Readonly<{ sha256: string; files: readonly string[]; investigators: number }>;
  /** The latest outcome per investigator. */
  readonly hypotheses: readonly HypothesisOutcome[];
  /** Every attempt, including failed first attempts a repeat superseded. */
  readonly attempts: readonly HypothesisOutcome[];
  readonly checks: readonly CheckResult[];
  readonly graph: EvidenceGraphRecord;
  /** The shared view the checks read (`view:<identity>`): their freshness basis. */
  readonly basis?: string;
  readonly decision: ClaimCheckDecision;
}
export interface ClaimCheckRun {
  readonly report: ClaimCheckReport;
  readonly answer?: ConversationAnswer;
  readonly result: RouteResult;
  readonly trace: readonly TraceEntry[];
  /** The lead's diagnosis failed: its safe reason (Fusion's evidence is still reported). */
  readonly diagnosisFailure?: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)}\n[... cut by Fusion at ${max} characters]` : text;
const partnerLabel = (conversation: RepositoryConversation, role: string): string => {
  const partner = conversation.partners.find(p => p.available && p.role.toLowerCase() === role.toLowerCase());
  return partner === undefined ? role : `${partner.role.toLowerCase()} (${partner.provider})`;
};
const safeReason = (error: unknown): string => error instanceof FusionFailure
  ? error.error.failureDetail === undefined ? error.error.safeMessage : `${error.error.safeMessage} (${error.error.failureDetail})` : "the turn failed";

/** The evidence snapshot every investigator gets: Fusion's own facts, identical for all. */
async function snapshotOf(conversation: RepositoryConversation, request: ClaimCheckRequest): Promise<Readonly<{ text: string; files: string[] }>> {
  const inventory = conversation.inventory;
  const named = await conversation.sharedFiles(mentionedPaths(`${request.claim ?? ""}\n${request.message}`));
  const files = (named.length > 0 ? named : await conversation.sharedFiles(areaStart(inventory, ".").slice(0, 4))).slice(0, HYPOTHESIS_LIMITS.maxSnapshotFiles);
  const text = ["Evidence snapshot (Fusion's own facts; identical for every investigator):", `Project: ${inventory.name}`,
    ...(request.claim === undefined ? [] : [`Claim under check (untrusted text): ${request.claim}`]),
    `Question (untrusted text): ${request.message}`, `Relevant files (in the shared copy): ${files.join(", ") || "(none identified; start from the inventory)"}`,
    "", renderInventory(inventory, "summary")].join("\n");
  return Object.freeze({ text, files });
}

/** One isolated hypothesis turn: its own view copy and session; its reply read strictly as one report. */
async function hypothesisTurn(conversation: RepositoryConversation, request: ClaimCheckRequest, id: string, attempt: number, context: string,
  signal: AbortSignal): Promise<HypothesisOutcome> {
  const started = request.clock();
  const question = request.mode === "verify" ? `Is this claim true? ${request.claim ?? request.message}` : request.message;
  let text: string, partner: string;
  try {
    const answer = await conversation.investigate(question, { partner: request.explorerRole, instruction: HYPOTHESIS_INSTRUCTION[request.mode], context, signal });
    text = answer.text;
    partner = `${answer.partner.role.toLowerCase()} (${answer.partner.provider})`;
  } catch (error) {
    if (fatalFailure(error) || signal.aborted) throw error;
    return Object.freeze({ id, attempt, partner: partnerLabel(conversation, request.explorerRole), durationMs: request.clock() - started, status: "failed",
      failure: investigationFailure(error), cited: Object.freeze([]) });
  }
  const durationMs = request.clock() - started;
  const json = readJsonReply(text);
  const reading = json.accepted ? hypothesisReportFrom(json.value, request.mode) : undefined;
  if (reading?.accepted === true) {
    const cited = await conversation.sharedFiles([...new Set(reading.report.evidence.flatMap(e => [...e.paths]))]);
    return Object.freeze({ id, attempt, partner, durationMs, status: "reported", report: reading.report, cited: Object.freeze(cited) });
  }
  const bounded = text.slice(0, 4_000);
  return Object.freeze({ id, attempt, partner, durationMs, status: "unstructured", text: bounded,
    rejection: !json.accepted ? json.category : reading !== undefined && !reading.accepted ? reading.category : "schema mismatch",
    cited: Object.freeze(await conversation.sharedFiles(mentionedPaths(bounded))) });
}

/**
 * Runs one claim check to its end, or returns undefined when Fusion cannot staff it within the budget (the caller then runs
 * v0.3's route). Every turn is reserved first; the route's own deadline stops it cleanly.
 */
export async function runClaimCheck(conversation: RepositoryConversation, request: ClaimCheckRequest): Promise<ClaimCheckRun | undefined> {
  const { clock, budget } = request;
  const ledger = new BudgetLedger(budget, clock);
  const keep = { lead: 1, reviewer: 0 };
  const size = Math.min(HYPOTHESIS_LIMITS.investigators, ledger.batchCapacity(keep));
  if (size < 1 || ledger.reserveBatch(size, keep) !== undefined) return undefined;
  const trace: TraceEntry[] = [];
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), budget.routeTimeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, deadline.signal]) : deadline.signal;
  const expired = (error: unknown): boolean => deadline.signal.aborted && request.signal?.aborted !== true &&
    error instanceof FusionFailure && (error.error.kind === "Cancelled" || error.error.kind === "Timeout");
  try {
    // 1. The snapshot: one text, one digest, handed identically to every investigator.
    const snapshot = await snapshotOf(conversation, request);
    const digest = sha256(snapshot.text);
    trace.push({ stage: "snapshot", role: "fusion", count: snapshot.files.length, detail: `sha256:${digest.slice(0, 12)}` });
    const ids = Array.from({ length: size }, (_, i) => `h${i + 1}`);
    const contextOf = (id: string) => `${snapshot.text}\n\nInvestigator: ${id} (one of ${size}; you will not see the others' work)`;

    // 2. Independent hypotheses, in parallel; transient failures repeated once within the budget.
    const attempts: HypothesisOutcome[] = [];
    const batch = async (list: readonly string[], attempt: number): Promise<Readonly<{ outcomes: HypothesisOutcome[]; parallel: number; durationMs: number }>> => {
      const report = await runBounded(list.map(id => ({ id, run: (item: AbortSignal) => hypothesisTurn(conversation, request, id, attempt, contextOf(id), item) })),
        { concurrency: budget.maxConcurrentInvestigations, timeoutMs: Math.max(1_000, Math.min(budget.investigationTimeoutMs, ledger.remainingMs)),
          signal, fatal: fatalFailure, clock });
      const outcomes = report.results.map((result, index): HypothesisOutcome => result.status === "fulfilled" ? result.value
        : Object.freeze({ id: list[index]!, attempt, partner: partnerLabel(conversation, request.explorerRole), durationMs: result.endedAt - result.startedAt,
          status: "failed", failure: investigationFailure(result.error), cited: Object.freeze([]) }));
      return { outcomes, parallel: report.maxConcurrent, durationMs: report.durationMs };
    };
    let stopped: BudgetRefusal | undefined;
    try {
      const first = await batch(ids, 1);
      attempts.push(...first.outcomes);
      const failures = first.outcomes.flatMap(o => o.status === "failed" ? [o.failure!.category] : []);
      trace.push({ stage: "hypotheses", role: "explorer", status: failures.length === size ? "failed" : "completed", count: size, failed: failures.length,
        ...(failures.length > 0 ? { failures: Object.freeze(failures) } : {}), parallel: Math.max(0, Math.min(first.parallel, size)),
        cited: new Set(first.outcomes.flatMap(o => [...o.cited])).size, durationMs: first.durationMs });
      const again = first.outcomes.filter(o => o.status === "failed" && repeatable(o.failure!)).map(o => o.id)
        .slice(0, ledger.retryCapacity(keep));
      if (again.length > 0 && ledger.reserveRetries(again.length, keep) === undefined) {
        const second = await batch(again, 2);
        attempts.push(...second.outcomes);
        const failed = second.outcomes.flatMap(o => o.status === "failed" ? [o.failure!.category] : []);
        trace.push({ stage: "retry", role: "explorer", status: failed.length === again.length ? "failed" : "completed", count: again.length,
          failed: failed.length, ...(failed.length > 0 ? { failures: Object.freeze(failed) } : {}), parallel: Math.max(0, Math.min(second.parallel, again.length)),
          durationMs: second.durationMs });
      }
    } catch (error) {
      if (!expired(error)) throw error;
      stopped = "route time";
    }
    const latest = [...new Map(attempts.map(o => [o.id, o])).values()];

    // 3–4. Comparison and Fusion's own checks on the shared copy.
    const graph = new EvidenceGraph();
    const identity = conversation.viewIdentity;
    const basis = identity === undefined ? undefined : `view:${identity.slice(0, 64)}`;
    const claimId = request.mode === "verify" ? graph.addClaim({ key: "claim", kind: "finding", origin: request.claimOrigin ?? "user", ref: "session",
      subject: request.claimOrigin === "lead" ? "the finding under check" : "the claim under check", statement: request.claim ?? request.message,
      files: snapshot.files })! : undefined;
    for (const outcome of latest) {
      if (outcome.status !== "reported") {
        if (claimId !== undefined) graph.addEvidence({ claim: claimId, source: "investigator", relation: "neutral", label: outcome.id,
          detail: outcome.status === "failed" ? `no report (${outcome.failure!.category})` : `an unstructured reply (${outcome.rejection ?? "schema mismatch"})` });
        continue;
      }
      const report = outcome.report!;
      const h = graph.addClaim({ key: outcome.id, kind: "hypothesis", origin: "investigator", ref: outcome.id, subject: `hypothesis ${outcome.id}`,
        statement: report.hypothesis, files: outcome.cited, ...(claimId !== undefined && report.verdict === "contradicted" ? { challenges: claimId } : {}) });
      if (h === undefined) continue;
      if (claimId !== undefined) graph.addEvidence({ claim: claimId, source: "investigator", label: outcome.id,
        relation: report.verdict === "supported" ? "supports" : report.verdict === "contradicted" ? "contradicts" : "neutral", detail: report.summary });
      for (const file of outcome.cited) graph.addEvidence({ claim: h, source: "citation", relation: "neutral", label: outcome.id,
        detail: `cites ${file} (the file exists in the shared copy)` });
      report.alternatives.forEach((alternative, index) => graph.addClaim({ key: `${outcome.id}-a${index + 1}`, kind: "hypothesis", origin: "investigator",
        ref: outcome.id, subject: `an alternative ${outcome.id} could not rule out`, statement: alternative, challenges: claimId ?? h }));
    }
    const proposals: Array<{ check: FileCheck; target: string; by: string[] }> = [];
    const propose = (check: FileCheck, target: string, by: string): void => {
      const same = proposals.find(p => p.target === target && p.check.file === check.file && p.check.text === check.text && p.check.expect === check.expect);
      if (same !== undefined) { if (!same.by.includes(by)) same.by.push(by); } else proposals.push({ check, target, by: [by] });
    };
    if (request.mode === "verify" && request.claim !== undefined)
      for (const check of derivedChecks(request.claim, await conversation.sharedFiles(mentionedPaths(request.claim)))) propose(check, "claim", "fusion");
    for (const outcome of latest) if (outcome.status === "reported" && graph.claim(outcome.id) !== undefined)
      for (const check of outcome.report!.checks) propose(check, request.mode === "verify" ? "claim" : outcome.id, outcome.id);
    const verdicts = new Set(latest.flatMap(o => o.status === "reported" && o.report!.verdict !== "unclear" ? [o.report!.verdict] : []));
    const discriminating = request.mode === "verify" ? verdicts.size > 1 : latest.filter(o => o.status === "reported").length > 1;
    const files = new Map<string, Awaited<ReturnType<RepositoryConversation["sharedText"]>>>();
    const checks: CheckResult[] = [];
    for (const [index, proposal] of proposals.entries()) {
      const id = `k${index + 1}`;
      let outcome: CheckResult["outcome"];
      if (index >= HYPOTHESIS_LIMITS.maxChecksPerRoute) outcome = Object.freeze({ ran: false, reason: "route limit" as CheckRefusal });
      else {
        if (!files.has(proposal.check.file)) files.set(proposal.check.file, await conversation.sharedText(proposal.check.file, HYPOTHESIS_LIMITS.maxCheckFileBytes));
        const read = files.get(proposal.check.file)!;
        outcome = "text" in read ? checkOutcome(proposal.check, read.text) : Object.freeze({ ran: false, reason: read.refused });
      }
      const result: CheckResult = Object.freeze({ id, check: proposal.check, proposedBy: Object.freeze([...proposal.by]), target: proposal.target, outcome, discriminating });
      checks.push(result);
      const target = proposal.target === "claim" ? claimId! : proposal.target;
      if (graph.claim(target) === undefined) continue;
      const by = `proposed by ${proposal.by.join(", ")}`;
      graph.addEvidence({ claim: target, source: "fileCheck", label: id, ...(basis === undefined ? {} : { basis }),
        relation: !outcome.ran ? "neutral" : outcome.holds ? "supports" : "contradicts",
        detail: outcome.ran ? `${describeCheck(proposal.check)}: ${outcome.present ? "yes" : "no"} — ${outcome.holds ? "as predicted" : "not as predicted"} (${by})`
          : `${describeCheck(proposal.check)}: not run (${outcome.reason}; ${by})` });
    }
    const ran = checks.filter(c => c.outcome.ran).length, refused = checks.length - ran;
    const contradicted = checks.filter(c => c.outcome.ran && !c.outcome.holds).length;
    trace.push({ stage: "checks", role: "fusion", count: ran, ...(refused > 0 ? { failed: refused } : {}),
      ...(contradicted > 0 || refused > 0 ? { detail: [contradicted > 0 ? `${contradicted} contradicted a prediction` : "", refused > 0 ? `${refused} not run` : ""]
        .filter(Boolean).join(", ") } : {}) });

    // 5. The lead reclaims the task with the hypotheses and Fusion's check results.
    let answer: ConversationAnswer | undefined, diagnosisFailure: string | undefined;
    const refusal = stopped ?? ledger.reserveLead();
    if (refusal !== undefined) {
      trace.push({ stage: "stop", role: "fusion", detail: `budget exhausted: ${refusal}` });
      stopped = refusal;
    } else {
      const started = clock();
      try {
        answer = await conversation.ask(request.message, { purpose: "analysis", signal,
          instruction: request.mode === "diagnose" ? `${DIAGNOSIS_INSTRUCTION} ${FINDINGS_RULE}` : DIAGNOSIS_INSTRUCTION,
          context: diagnosisContext(snapshot.text, latest, checks, graph, claimId, request.mode) });
        trace.push({ stage: "diagnosis", role: "lead", partner: `${answer.partner.role.toLowerCase()} (${answer.partner.provider})`, status: "completed",
          durationMs: clock() - started });
        if (claimId !== undefined) graph.addEvidence({ claim: claimId, source: "lead", relation: "neutral", label: "diagnosis",
          detail: "the lead's final answer (model text; not evidence)" });
      } catch (error) {
        if (expired(error)) { trace.push({ stage: "stop", role: "fusion", detail: "budget exhausted: route time" }); stopped = "route time"; }
        else {
          if (fatalFailure(error)) throw error;
          diagnosisFailure = safeReason(error);
          trace.push({ stage: "diagnosis", role: "lead", partner: request.leadLabel, status: "failed", durationMs: clock() - started,
            detail: investigationFailure(error).category });
        }
      }
    }

    // 6. Fusion's decision: the graph's status rule, never the models' agreement.
    const decision: ClaimCheckDecision = claimId !== undefined
      ? Object.freeze({ kind: "claim" as const, status: graph.assess(claimId).status, assessment: graph.assess(claimId) })
      : diagnosisDecision(graph, latest);
    const settled = decision.kind === "claim" ? decision.status === "SUPPORTED" || decision.status === "CONTRADICTED" : decision.leading !== undefined;
    const result: RouteResult = stopped !== undefined ? Object.freeze({ outcome: "stopped" as const, reason: Object.freeze({ kind: "budget" as const, refusal: stopped }) })
      : diagnosisFailure !== undefined ? Object.freeze({ outcome: "failed" as const, stage: "synthesis" as const })
      : Object.freeze({ outcome: "answered" as const, evidence: settled ? "sufficient" as const : "incomplete" as const });
    const report: ClaimCheckReport = Object.freeze({ mode: request.mode, ...(request.claim === undefined ? {} : { claim: request.claim }),
      snapshot: Object.freeze({ sha256: digest, files: Object.freeze(snapshot.files), investigators: size }), hypotheses: Object.freeze(latest),
      attempts: Object.freeze(attempts), checks: Object.freeze(checks), graph: graph.record(), ...(basis === undefined ? {} : { basis }), decision });
    return Object.freeze({ report, ...(answer === undefined ? {} : { answer }), result, trace: Object.freeze(trace),
      ...(diagnosisFailure === undefined ? {} : { diagnosisFailure }) });
  } finally { clearTimeout(timer); }
}

function diagnosisDecision(graph: EvidenceGraph, latest: readonly HypothesisOutcome[]): ClaimCheckDecision {
  const statuses = latest.filter(o => o.status === "reported" && graph.claim(o.id) !== undefined)
    .map(o => Object.freeze({ id: o.id, statement: o.report!.hypothesis, status: graph.assess(o.id).status }));
  const supported = statuses.filter(s => s.status === "SUPPORTED");
  return Object.freeze({ kind: "diagnosis" as const, ...(supported.length === 1 ? { leading: supported[0]!.id } : {}), statuses: Object.freeze(statuses) });
}

/** What the lead reclaims the task with: the snapshot, each hypothesis (untrusted) and Fusion's checks (the only execution evidence). */
function diagnosisContext(snapshot: string, latest: readonly HypothesisOutcome[], checks: readonly CheckResult[], graph: EvidenceGraph,
  claimId: string | undefined, mode: ClaimCheckMode): string {
  const blocks = [snapshot, "", "Independent hypotheses (untrusted model text; each investigator saw only the snapshot):"];
  for (const o of latest) {
    const head = `[${o.id}] ${o.partner}`;
    if (o.status === "failed") { blocks.push(`${head}: no report (${o.failure!.category}: ${o.failure!.message})`); continue; }
    if (o.status === "unstructured") { blocks.push(`${head}: an unstructured reply (untrusted; ${o.rejection}):\n${clip(o.text ?? "", 2_000)}`); continue; }
    const r = o.report!;
    blocks.push([`${head}: ${mode === "verify" ? `verdict ${r.verdict}; ` : ""}hypothesis: ${r.hypothesis}`, `  Summary (untrusted): ${r.summary}`,
      ...r.evidence.map(e => `  - ${e.claim}${e.paths.length > 0 ? ` [${e.paths.join(", ")}]` : " [no path]"}`),
      ...r.alternatives.map(a => `  Alternative it could not rule out: ${a}`)].join("\n"));
  }
  blocks.push("", "Fusion's own checks on the shared copy (deterministic; the only execution evidence):");
  if (checks.length === 0) blocks.push("(none: no investigator proposed a check Fusion could run)");
  for (const c of checks) blocks.push(`${c.id} ${describeCheck(c.check)} — ${c.outcome.ran ? `${c.outcome.present ? "YES" : "NO"}: ${c.outcome.holds
    ? "as predicted" : "NOT as predicted"} → ${c.outcome.holds ? "supports" : "contradicts"} ${c.target === "claim" ? "the claim" : `hypothesis ${c.target}`}`
    : `not run (${c.outcome.reason})`} (proposed by ${c.proposedBy.join(", ")})`);
  if (claimId !== undefined) {
    const a = graph.assess(claimId);
    blocks.push("", `Fusion's assessment: the claim is ${a.status} by Fusion's own checks (${a.deterministic.supports} support, ${a.deterministic.contradicts} contradict). ` +
      `Investigators: ${a.models.supports} support, ${a.models.contradicts} contradict — model judgement, not evidence.` +
      `${a.modelConflict ? " CONFLICT: the investigators disagree; where no check settles it, say the question is unresolved. Do not invent a consensus." : ""}`);
  } else {
    const d = diagnosisDecision(graph, latest);
    blocks.push("", `Fusion's assessment: ${d.kind === "diagnosis" ? d.statuses.map(s => `${s.id} ${s.status}`).join(", ") || "no hypothesis reported" : ""}. ` +
      "A hypothesis a check contradicted is not the cause as stated.");
  }
  return clip(blocks.join("\n"), 24_000);
}
