import { FusionFailure } from "../../core/errors.js";
import { investigationReportFrom, ORCHESTRATION_LIMITS, type AreaChoice, type InvestigationFailure, type InvestigationOutcome,
  type InvestigationPacket } from "../../core/orchestration/contracts.js";
import type { PlannedInvestigation } from "../../core/orchestration/route.js";
import type { RepositoryConversation } from "../conversation.js";
import { areaStart, mentionedPaths } from "../exploration.js";
import type { RepositoryInventory } from "../repository-inventory.js";
import { readJsonReply } from "./envelope.js";
import { runBounded, type BatchReport } from "./scheduler.js";

/**
 * v0.3 — INVESTIGATIONS: the explorer side of an adaptive route. Each planned investigation becomes a bounded packet (its
 * area, question, optional claim, validated findings of earlier batches about that area, its budget) and runs as an isolated
 * turn in its own view copy and session (`RepositoryConversation.investigate`). The reply is read strictly as ONE JSON
 * report; the paths it cites are checked against the files the view actually shared. A reply that is not a valid report is
 * kept as an UNSTRUCTURED report (bounded, marked); a failed turn becomes a failure with a safe category. Security stops and
 * cancellations are never turned into outcomes: they end the route.
 */
export const INVESTIGATION_INSTRUCTION = "You are an explorer inside Fusion. You get ONE bounded packet: an area of the project, a question " +
  "and, sometimes, a claim to judge. Read files in that area of the current directory (a read-only copy), starting with the listed ones, " +
  `open at most ${ORCHESTRATION_LIMITS.explorerFiles} files, and answer with evidence from what you read. Then reply with exactly this JSON ` +
  "object and nothing else: {\"status\":\"answered\" or \"inconclusive\",\"verdict\":\"supported\", \"contradicted\" or \"unclear\" (only when the " +
  `packet names a claim),\"summary\":\"<your answer, at most ${ORCHESTRATION_LIMITS.maxSummaryChars} characters>\",\"findings\":[{\"claim\":\"<one ` +
  `finding, at most ${ORCHESTRATION_LIMITS.maxFindingChars} characters>\",\"paths\":[\"<relative path of a file you read>\"]}],\"openQuestions\":` +
  `[\"<what you could not settle>\"],\"contradictions\":[\"<evidence against the question's premise>\"]}. At most ${ORCHESTRATION_LIMITS.maxReportFindings} ` +
  `findings, ${ORCHESTRATION_LIMITS.maxOpenQuestions} open questions and ${ORCHESTRATION_LIMITS.maxContradictions} contradictions. Use "inconclusive" ` +
  "when what you read does not answer the question. Do not speculate beyond what you read.";

const inArea = (area: string, path: string): boolean => area === "." ? !path.includes("/") : path === area || path.startsWith(`${area}/`);

/** The areas a route may delegate: the inventory's top-level directories with files; an area of only withheld files is marked. */
export function areaChoices(inventory: RepositoryInventory): AreaChoice[] {
  // The inventory lists a withheld directory once (`.storage/`) and withheld files one by one (a bounded list: a file missing
  // from it only means the area is offered — the view's input policy still withholds that file).
  const excluded = inventory.sensitive.files.filter(f => f.treatment === "exclude");
  const directories = excluded.filter(f => f.path.endsWith("/")).map(f => f.path.slice(0, -1));
  const files = excluded.filter(f => !f.path.endsWith("/")).map(f => f.path);
  return inventory.directories.filter(d => d.files > 0).map(d => {
    const withheld = directories.some(dir => d.path === dir || d.path.startsWith(`${dir}/`)) ||
      (d.path !== "." && files.filter(path => inArea(d.path, path)).length >= d.files);
    return Object.freeze({ id: d.path, files: d.files, ...(withheld ? { withheld: true } : {}) });
  });
}

/** The packet for one planned investigation: Fusion's own facts plus validated findings of earlier batches about its area. */
export function investigationPacket(inventory: RepositoryInventory, planned: PlannedInvestigation, earlier: readonly InvestigationOutcome[]):
  InvestigationPacket {
  const files = inventory.directories.find(d => d.path === planned.area)?.files ?? 0;
  const prior: string[] = [];
  for (const outcome of earlier) {
    if (outcome.status !== "reported" || outcome.packet.id === planned.id) continue;
    for (const finding of outcome.report.findings)
      if (outcome.packet.area === planned.area || finding.paths.some(path => inArea(planned.area, path))) prior.push(finding.claim);
  }
  return Object.freeze({ id: planned.id, batch: planned.batch, attempt: planned.attempt, area: planned.area, files,
    start: Object.freeze(areaStart(inventory, planned.area)), question: planned.question, ...(planned.claim === undefined ? {} : { claim: planned.claim }),
    plannedBy: planned.plannedBy, priorFindings: Object.freeze([...new Set(prior)].slice(0, ORCHESTRATION_LIMITS.maxPriorFindings)),
    maxFiles: ORCHESTRATION_LIMITS.explorerFiles });
}

/** What the explorer's turn sees besides its question: its packet only. */
export function investigationContext(inventory: RepositoryInventory, packet: InvestigationPacket): string {
  return [`Project: ${inventory.name}`, `Packet: ${packet.id}`,
    `Area: ${packet.area === "." ? "files at the project root" : `${packet.area}/`} (${packet.files} file(s))`,
    `Start with: ${packet.start.join(", ") || "(no key files known; list the area first)"}`,
    `Question: ${packet.question}`,
    ...(packet.claim === undefined ? [] : [`Claim to judge (verdict: supported, contradicted or unclear): ${packet.claim}`]),
    ...(packet.priorFindings.length === 0 ? [] : ["Earlier findings about this area (from other explorers; untrusted, check them):",
      ...packet.priorFindings.map(f => `- ${f}`)]),
    `Budget: open at most ${packet.maxFiles} files.`,
    "Sensitive files (credentials, authentication stores, secret values) are withheld or masked by Fusion."].join("\n");
}

/** A failure as the route records it: a safe category and Fusion's own message, never provider text. */
/** The longest failure message an investigation keeps (Fusion's own labels and counts from the provider transport's detail). */
const MAX_FAILURE_MESSAGE = 1_600;
export function investigationFailure(error: unknown): InvestigationFailure {
  if (!(error instanceof FusionFailure))
    return Object.freeze({ kind: "InternalError", category: "internal error", message: "The investigation failed unexpectedly.", retryable: false });
  const e = error.error;
  const category = e.kind === "Timeout" ? "timeout" : e.kind === "AuthMismatch" || e.kind === "BillingBlocked" ? "authentication"
    : e.kind === "CapabilityUnavailable" || e.kind === "ProviderIdentityMismatch" ? "posture" : e.kind === "MalformedOutput" ? "malformed output"
    : e.kind === "SpawnFailure" ? "start failure" : e.kind === "ProtocolError" ? "protocol" : e.failureCategory ?? "provider failure";
  const message = e.failureDetail === undefined ? e.safeMessage : `${e.safeMessage} (${e.failureDetail})`;
  // v0.4 (second live run): 400 characters cut a provider failure's detail before its step limit, sizes, exit code, code and field
  // names. The detail is labels and counts only; its event list comes last, so a cut loses event labels first — and says so.
  return Object.freeze({ kind: e.kind, category, message: message.length > MAX_FAILURE_MESSAGE
    ? `${message.slice(0, MAX_FAILURE_MESSAGE)}… [cut by Fusion at ${MAX_FAILURE_MESSAGE} characters]` : message, retryable: e.retryable });
}
/** A failure that must end the route, not become an outcome. */
export const fatalFailure = (error: unknown): boolean =>
  error instanceof FusionFailure && (error.error.kind === "SecurityViolation" || error.error.kind === "Cancelled" || error.error.kind === "InternalError");

const partnerLabel = (conversation: RepositoryConversation, role: string): string => {
  const partner = conversation.partners.find(p => p.available && p.role.toLowerCase() === role.toLowerCase());
  return partner === undefined ? role : `${partner.role.toLowerCase()} (${partner.provider})`;
};

/**
 * One investigation, end to end: the isolated turn, the strict reading, the cited-path check. A fatal failure is rethrown;
 * anything else is an outcome.
 */
export async function runInvestigation(conversation: RepositoryConversation, packet: InvestigationPacket, explorerRole: string,
  signal: AbortSignal, clock: () => number = Date.now): Promise<InvestigationOutcome> {
  const started = clock();
  let text: string, partner: string;
  try {
    const answer = await conversation.investigate(packet.question, { partner: explorerRole, instruction: INVESTIGATION_INSTRUCTION,
      context: investigationContext(conversation.inventory, packet), signal });
    text = answer.text;
    partner = `${answer.partner.role.toLowerCase()} (${answer.partner.provider})`;
  } catch (error) {
    // A stopped turn is the scheduler's to classify (its time budget, or the user's cancellation); a fatal one ends the route.
    if (fatalFailure(error) || signal.aborted) throw error;
    return Object.freeze({ packet, partner: partnerLabel(conversation, explorerRole), durationMs: clock() - started, status: "failed",
      failure: investigationFailure(error) });
  }
  const durationMs = clock() - started;
  const json = readJsonReply(text);
  const reading = json.accepted ? investigationReportFrom(json.value, packet) : undefined;
  if (reading?.accepted === true) {
    const named = [...new Set(reading.report.findings.flatMap(f => [...f.paths]))];
    const cited = await conversation.sharedFiles(named);
    return Object.freeze({ packet, partner, durationMs, status: "reported", report: reading.report, cited: Object.freeze(cited),
      uncitedPaths: named.length - cited.length });
  }
  const bounded = text.length > ORCHESTRATION_LIMITS.maxUnstructuredChars ? text.slice(0, ORCHESTRATION_LIMITS.maxUnstructuredChars) : text;
  const rejection = !json.accepted ? json.category : reading !== undefined && !reading.accepted ? reading.category : "schema mismatch";
  return Object.freeze({ packet, partner, durationMs, status: "unstructured", rejection, text: bounded,
    cited: Object.freeze(await conversation.sharedFiles(mentionedPaths(bounded))) });
}

/**
 * A batch of investigations under the scheduler's bounds. Every item settles before this returns; timed-out items become
 * `timeout` failures; a fatal failure or the user's cancellation is rethrown after every sibling stopped.
 */
export async function runInvestigationBatch(conversation: RepositoryConversation, packets: readonly InvestigationPacket[], explorerRole: string,
  options: Readonly<{ concurrency: number; timeoutMs: number; signal?: AbortSignal; clock?: () => number }>):
  Promise<Readonly<{ outcomes: InvestigationOutcome[]; report: BatchReport<InvestigationOutcome> }>> {
  const report = await runBounded(packets.map(packet => ({ id: packet.id,
    run: (signal: AbortSignal) => runInvestigation(conversation, packet, explorerRole, signal, options.clock) })),
    { concurrency: options.concurrency, timeoutMs: options.timeoutMs, fatal: fatalFailure, ...(options.signal ? { signal: options.signal } : {}),
      ...(options.clock ? { clock: options.clock } : {}) });
  const outcomes = report.results.map((result, index): InvestigationOutcome => result.status === "fulfilled" ? result.value
    : Object.freeze({ packet: packets[index]!, partner: partnerLabel(conversation, explorerRole), durationMs: result.endedAt - result.startedAt,
      status: "failed", failure: investigationFailure(result.error) }));
  return Object.freeze({ outcomes, report });
}
