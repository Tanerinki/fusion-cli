import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BuildEvidence } from "../core/evidence/build.js";
import type { Decision, ObligationKind, ObligationStatus, TaskClass } from "../core/evidence/obligations.js";
import { decisionRequestOf, parseDecisionRequest, type DecisionRequest } from "../core/workflow/decision.js";
import type { WorkflowResult } from "../core/workflow/types.js";
import type { DiagnosticRedactor } from "../core/policy/redaction.js";
import type { RiskAssessment } from "../core/policy/risk.js";
import type { ArtifactStore } from "../platform/events/artifact-store.js";
import { EventStore } from "../platform/events/event-store.js";
import { RunStore } from "../platform/events/run-store.js";
import type { CandidateId, TournamentOutcome } from "../core/tournament/contracts.js";
import type { EventScope, EvidenceDecisionEventRecord, RouteDecidedRecord, RunStatus, StoredEvent, TournamentCandidateRecord, TournamentDecidedRecord,
  TournamentStartedRecord } from "../platform/events/types.js";
import { EventStoreWorkflowSink } from "../platform/workflow/ports.js";
import { UNFINISHED_STATES, type CommandOutcome, type DisplayState } from "./outcome.js";

const MANIFEST_STATUS: Readonly<Record<DisplayState, RunStatus>> = {
  COMPLETED: "completed", ANSWERED: "completed", REVIEW_REQUIRED: "pending", DECISION_REQUIRED: "pending",
  HUMAN_GATE_REQUIRED: "pending", CANCELLED: "cancelled", FAILED: "failed", TIMED_OUT: "failed", BLOCKED: "failed",
};
const TERMINATION: Readonly<Partial<Record<DisplayState, "completed" | "failed" | "cancelled" | "timeout">>> = {
  COMPLETED: "completed", ANSWERED: "completed", CANCELLED: "cancelled", FAILED: "failed", TIMED_OUT: "timeout", BLOCKED: "failed",
};

/**
 * Persistence for one command run. The outcome is written (artifact, closing event, manifest status) before the command
 * returns, so nothing is reported that is not recorded. Unfinished runs are `pending`, never `completed`.
 */
export class RunRecorder {
  private constructor(readonly store: RunStore, readonly events: EventStore, readonly artifacts: ArtifactStore) {}
  get runId(): string { return this.store.runId; }

  static async start(repositoryRoot: string, command: "review" | "build", redactor: DiagnosticRedactor,
    options: Readonly<{ task?: string }> = {}): Promise<RunRecorder> {
    const store = await RunStore.create(repositoryRoot, { workflowId: command }, redactor);
    const events = await store.openEvents(), artifacts = await store.openArtifacts();
    await events.append({ type: "RunStarted", source: "runtime", payload: { workflowId: command } });
    // v0.1: the HUMAN's task, recorded first (so even an interrupted run says what it was for): a bounded, redacted summary
    // and the digest of the full text. Never provider text.
    if (options.task !== undefined) await artifacts.storeJson(taskRecord(options.task), TASK_PRODUCER);
    return new RunRecorder(store, events, artifacts);
  }
  /** `scope` (v0.5): the sink of one tournament candidate — every event it records names that candidate explicitly. */
  sink(scope?: EventScope): EventStoreWorkflowSink { return new EventStoreWorkflowSink(this.events, this.artifacts, scope); }

  /**
   * v0.4: Fusion's evidence decision about the run: the redacted evidence record (the graph, every obligation with its reason)
   * as an artifact, then the decision event (labels and statuses only) that points to it. Recorded before any delivery.
   */
  async recordEvidence(evidence: BuildEvidence, scope?: EventScope): Promise<string> {
    const plan = evidence.plan, decision = evidence.decision;
    const artifact = await this.artifacts.storeJson({ format: BUILD_EVIDENCE_FORMAT, version: 1, taskClass: plan.profile.taskClass,
      sensitive: plan.profile.sensitive, reproduce: plan.reproduce, freshReview: plan.freshReview, objective: plan.objective, strict: plan.strict,
      decision: decision.decision, deliverable: decision.deliverable, overflowed: decision.overflowed,
      obligations: decision.obligations.map(o => ({ kind: o.kind, tier: o.tier, status: o.status, reason: o.reason })), graph: evidence.graph },
    EVIDENCE_PRODUCER);
    const event = await this.events.append({ type: "EvidenceDecisionRecorded", source: "policy", ...(scope === undefined ? {} : { scope }), payload: { decision: decision.decision,
      deliverable: decision.deliverable, taskClass: plan.profile.taskClass, sensitive: plan.profile.sensitive,
      ...(plan.freshReview ? { objective: plan.objective } : {}),
      obligations: decision.obligations.map(o => ({ kind: o.kind, tier: o.tier, status: o.status })), claims: evidence.graph.claims.length,
      evidence: evidence.graph.evidence.length, overflowed: decision.overflowed, artifactRef: artifact.artifactId } });
    // v0.5: the decision's identity, which a tournament's decision binds explicitly.
    return event.eventId;
  }

  /** v0.5: how a Writer build was routed (host facts and decision; labels and counts only), before any model turn. */
  async recordRoute(record: RouteDecidedRecord): Promise<void> {
    await this.events.append({ type: "RouteDecided", source: "policy", payload: record });
  }
  /** v0.5: a tournament begins — its frozen profile, contract and snapshot digests — before any candidate exists. */
  async recordTournamentStart(tournamentId: string, record: TournamentStartedRecord): Promise<void> {
    await this.events.append({ type: "TournamentStarted", source: "policy", scope: { tournamentId }, payload: record });
  }
  /** v0.5: one candidate's evaluation, bound to the candidate and its exact revision. */
  async recordTournamentCandidate(scope: Readonly<{ tournamentId: string; candidate: CandidateId; revision: string }>,
    record: TournamentCandidateRecord): Promise<void> {
    await this.events.append({ type: "TournamentCandidateEvaluated", source: "policy", scope, payload: record });
  }
  /**
   * v0.5: how the tournament ended — the redacted tournament record as an artifact (manifests, mesh, selection, revalidation,
   * bounded reproducers), then the decision event binding the selected candidate, its revision and its evidence decision.
   */
  async recordTournamentDecision(tournamentId: string, record: Omit<TournamentDecidedRecord, "artifactRef">, artifact: unknown): Promise<string> {
    const stored = await this.artifacts.storeJson(artifact, TOURNAMENT_PRODUCER);
    const event = await this.events.append({ type: "TournamentDecided", source: "policy", scope: { tournamentId },
      payload: { ...record, artifactRef: stored.artifactId } });
    return event.eventId;
  }

  /** Risk assessed by the control plane itself (build requests that never reach the workflow engine). */
  async recordRisk(risk: RiskAssessment): Promise<void> {
    await this.events.append({ type: "RiskAssessed", source: "policy",
      payload: { level: risk.level, decisive: risk.decisive.slice(0, 32), revision: risk.revision } });
  }

  async finish(outcome: CommandOutcome, extras: Readonly<{ result?: WorkflowResult; risk?: RiskAssessment;
    details?: Readonly<Record<string, unknown>> }> = {}): Promise<void> {
    // v0.1: a decision a role requested is kept as its bounded, structured request (never the packet or any other text).
    const decision = extras.result === undefined ? undefined : decisionRequestOf(extras.result);
    const record = { state: outcome.state, code: outcome.code, message: outcome.message, ...(decision === undefined ? {} : { decision }),
      ...(outcome.pendingStage === undefined ? {} : { pendingStage: outcome.pendingStage }),
      ...(outcome.error === undefined ? {} : { error: { kind: outcome.error.kind, message: outcome.error.safeMessage } }),
      ...(extras.result === undefined ? {} : { workflowState: extras.result.state, delegateAttempts: extras.result.delegateAttempts,
        reviewCycles: extras.result.reviews.map(cycle => ({ cycle: cycle.cycle, outcome: cycle.outcome, findings: cycle.findings.length })) }),
      ...(extras.details === undefined ? {} : { details: extras.details }) };
    const artifact = await this.artifacts.storeJson(record, "fusion:outcome");
    if (outcome.state === "COMPLETED" || outcome.state === "ANSWERED")
      await this.events.append({ type: "RunCompleted", source: "runtime", payload: {} });
    else if (!UNFINISHED_STATES.has(outcome.state))
      await this.events.append({ type: "RunFailed", source: "runtime", payload: { errorKind: outcome.error?.kind ?? "CapabilityUnavailable" } });
    const risk = extras.result?.risk ?? extras.risk;
    const termination = TERMINATION[outcome.state];
    await this.store.updateManifest({ status: MANIFEST_STATUS[outcome.state],
      ...(MANIFEST_STATUS[outcome.state] === "pending" ? {} : { completedAt: new Date().toISOString() }),
      ...(risk === undefined ? {} : { risk: risk.level }), artifactRefs: [artifact.artifactId],
      ...(termination === undefined ? {} : { termination: { reason: termination } }) });
  }
}

export const TASK_PRODUCER = "fusion:task";
/** v0.4: the redacted evidence record of a Writer run. */
export const EVIDENCE_PRODUCER = "fusion:evidence";
/** v0.5: the redacted tournament record. */
export const TOURNAMENT_PRODUCER = "fusion:tournament";
export const BUILD_EVIDENCE_FORMAT = "fusion.buildEvidence";
export const TASK_SUMMARY_CHARS = 200;
export interface RunTask { readonly summary: string; readonly truncated: boolean; readonly sha256: string }
function taskRecord(task: string): RunTask {
  const flat = task.replace(/\s+/gu, " ").trim();
  return { summary: flat.length > TASK_SUMMARY_CHARS ? `${flat.slice(0, TASK_SUMMARY_CHARS - 1)}…` : flat, truncated: flat.length > TASK_SUMMARY_CHARS,
    sha256: createHash("sha256").update(task, "utf8").digest("hex") };
}

export interface RunSummary {
  readonly runId: string;
  readonly command: string;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly risk?: string;
  readonly outcome?: Readonly<Record<string, unknown>>;
  readonly finalWorkflowState?: string;
  readonly transitions: number;
  /** v0.1: the provider model turns the run's evidence records (structured and agent turns; conversation turns are not runs). */
  readonly modelTurns: number;
  /** Findings with their adjudication; in a tournament, each bound to the candidate whose review raised it. */
  readonly findings: readonly Readonly<{ id: string; severity: string; title: string; verdict?: string; candidate?: CandidateId }>[];
  readonly eventLog: "complete" | "truncated";
  /** v0.1: the human's task as recorded at the start (bounded, redacted), when the run recorded one. */
  readonly task?: RunTask;
  /** v0.1: the delivery the run prepared (its id), or that it was an offline rehearsal (never delivered). */
  readonly deliveryId?: string;
  readonly offlineRehearsal?: boolean;
  /** v0.1: the bounded decision request a role made, when the run stopped for one. */
  readonly decision?: DecisionRequest;
  /**
   * v0.4: Fusion's evidence decision, when the run recorded one (v0.3 runs have none). In a tournament: the SELECTED candidate's
   * revalidation decision, resolved only through the tournament's explicit binding — never another candidate's.
   */
  readonly evidence?: Readonly<{ decision: Decision; deliverable: boolean; taskClass: TaskClass;
    obligations: readonly Readonly<{ kind: ObligationKind; status: ObligationStatus }>[] }>;
  /** v0.5: the tournament the run held, as its decision event binds it. `resolved: false`: the binding does not hold (fail closed). */
  readonly tournament?: TournamentSummary;
}
export type TournamentSummary = Readonly<{ id: string; resolved: boolean; reason?: string; outcome?: TournamentOutcome;
  selected?: CandidateId; revision?: string; chosenBy?: "fusion" | "human"; tied?: readonly CandidateId[] }>;

const evidenceSummary = (p: EvidenceDecisionEventRecord): NonNullable<RunSummary["evidence"]> => ({ decision: p.decision, deliverable: p.deliverable,
  taskClass: p.taskClass, obligations: p.obligations.map(o => ({ kind: o.kind, status: o.status })) });
type ScopedDecision = Readonly<{ record: EvidenceDecisionEventRecord; scope?: EventScope }>;

/**
 * v0.5 — a tournament's decision, resolved through its explicit binding and nothing else: exactly one tournament and one
 * decision event; the selected candidate, its revision and the evidence decision's event id as that event binds them; and an
 * evidence decision whose own scope is that candidate's revalidation at that revision. The order of the events plays no part:
 * candidates run concurrently and their events interleave. Anything that does not bind is unresolved — no evidence is shown.
 */
function resolveTournament(tournaments: ReadonlySet<string>, decided: readonly StoredEvent[], decisions: ReadonlyMap<string, ScopedDecision>,
  finals: ReadonlyMap<string, string>): Readonly<{ tournament: TournamentSummary; evidence?: RunSummary["evidence"]; finalState?: string }> {
  const id = [...tournaments][0] ?? "unknown";
  const unresolved = (reason: string) => ({ tournament: Object.freeze({ id, resolved: false, reason }) });
  if (tournaments.size !== 1) return unresolved("the run's events name more than one tournament");
  if (decided.length === 0) return unresolved("the tournament recorded no decision");
  if (decided.length > 1) return unresolved("the tournament recorded more than one decision");
  const event = decided[0]!, p = event.payload as TournamentDecidedRecord;
  if (event.scope?.tournamentId !== id) return unresolved("the decision belongs to another tournament");
  const base = { id, outcome: p.outcome, ...(p.tied === undefined ? {} : { tied: p.tied }) };
  if (p.selected === undefined) return { tournament: Object.freeze({ ...base, resolved: true }) };
  const selected = { ...base, selected: p.selected, revision: p.selectedRevision!, chosenBy: p.chosenBy! };
  const finalState = finals.get(`${id}:${p.selected}`);
  if (p.evidenceDecisionId === undefined) {
    if (p.outcome === "DELIVERY_ELIGIBLE") return unresolved("a deliverable selection binds no evidence decision");
    return { tournament: Object.freeze({ ...selected, resolved: true }), ...(finalState === undefined ? {} : { finalState }) };
  }
  const bound = decisions.get(p.evidenceDecisionId);
  if (bound === undefined) return unresolved("the bound evidence decision is not in the run's events");
  const s = bound.scope;
  if (s?.tournamentId !== id || s.candidate !== p.selected || s.revision !== p.selectedRevision || s.stage !== "revalidation")
    return unresolved("the bound evidence decision is not the selected candidate's revalidation");
  // A later stop (a security violation) may overrule a deliverable decision; nothing may make an undeliverable one eligible.
  if (p.outcome === "DELIVERY_ELIGIBLE" && !bound.record.deliverable)
    return unresolved("the tournament's outcome and the bound evidence decision disagree");
  return { tournament: Object.freeze({ ...selected, resolved: true }), evidence: evidenceSummary(bound.record),
    ...(finalState === undefined ? {} : { finalState }) };
}
/** A bounded, redacted run summary from persisted evidence. Raw artifacts are never printed. */
export async function summarizeRun(repositoryRoot: string, runId: string, redactor: DiagnosticRedactor): Promise<RunSummary> {
  const store = await RunStore.open(repositoryRoot, runId, redactor);
  const manifest = await store.readManifest();
  const findings = new Map<string, { id: string; severity: string; title: string; verdict?: string; candidate?: CandidateId }>();
  let finalState: string | undefined, transitions = 0, truncated = false, count = 0, modelTurns = 0;
  let evidence: RunSummary["evidence"], tournament: TournamentSummary | undefined;
  // v0.5: what binds a tournament's events — collected whatever their order, resolved after the whole log is read.
  const tournaments = new Set<string>(), decided: StoredEvent[] = [];
  const decisions = new Map<string, ScopedDecision>(), finals = new Map<string, string>();
  // A finding is one candidate's: the same finding id in two candidates' reviews is two findings.
  const findingKey = (scope: EventScope | undefined, id: unknown): string => `${scope?.tournamentId ?? ""}:${scope?.candidate ?? ""}:${String(id)}`;
  // Read through the validating reader (never the appender), so a truncated log is summarized, not refused.
  for await (const item of EventStore.read(store.directory, runId)) {
    if ("diagnostic" in item) { truncated = true; break; }
    if (++count > 10_000) break;
    const event: StoredEvent = item.event;
    const payload = event.payload as Record<string, unknown>;
    const scope = event.scope;
    if (scope !== undefined) tournaments.add(scope.tournamentId);
    if (event.type === "WorkflowTransition") {
      transitions++;
      // One candidate's engine appends its own events in order; only ACROSS candidates do events interleave.
      if (scope === undefined) finalState = String(payload.to);
      else if (scope.candidate !== undefined) finals.set(`${scope.tournamentId}:${scope.candidate}`, String(payload.to));
    }
    if (event.type === "StructuredTurnObserved" || event.type === "AgentTurnObserved") modelTurns++;
    if (event.type === "FindingRecorded")
      findings.set(findingKey(scope, payload.findingId), { id: String(payload.findingId), severity: String(payload.severity), title: String(payload.title),
        ...(scope?.candidate === undefined ? {} : { candidate: scope.candidate }) });
    if (event.type === "EvidenceDecisionRecorded") {
      const p = event.payload as EvidenceDecisionEventRecord;
      decisions.set(event.eventId, Object.freeze({ record: p, ...(scope === undefined ? {} : { scope }) }));
      if (scope === undefined) evidence = evidenceSummary(p);
    }
    if (event.type === "TournamentDecided") decided.push(event);
    if (event.type === "AdjudicationRecorded") {
      const entry = findings.get(findingKey(scope, payload.findingId));
      if (entry) entry.verdict = String(payload.verdict);
    }
  }
  if (tournaments.size > 0) {
    // A tournament run: its decision and final state come from the binding only — never from whichever event came last.
    const resolved = resolveTournament(tournaments, decided, decisions, finals);
    tournament = resolved.tournament;
    evidence = resolved.evidence;
    finalState = resolved.finalState;
  }
  let outcome: Record<string, unknown> | undefined, task: RunTask | undefined;
  const ref = manifest.artifactRefs?.[0];
  const artifacts = await store.openArtifacts();
  if (ref !== undefined) {
    try { outcome = JSON.parse(await readFile(await artifacts.getArtifactPath(ref), "utf8")) as Record<string, unknown>; }
    catch { outcome = undefined; }
  }
  try {
    const recorded = (await artifacts.listMetadata(64)).find(entry => entry.producer === TASK_PRODUCER && entry.kind === "json" && entry.byteSize <= 4096);
    if (recorded !== undefined) {
      const value = JSON.parse(await readFile(await artifacts.getArtifactPath(recorded.artifactId), "utf8")) as Record<string, unknown>;
      if (typeof value.summary === "string" && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.sha256))
        task = { summary: value.summary.slice(0, TASK_SUMMARY_CHARS), truncated: value.truncated === true, sha256: value.sha256 };
    }
  } catch { task = undefined; }
  const details = (outcome?.details ?? {}) as Record<string, unknown>;
  const delivery = details.delivery as Record<string, unknown> | undefined;
  const deliveryId = typeof delivery?.id === "string" && /^d-[0-9a-f]{24}$/u.test(delivery.id) ? delivery.id : undefined;
  const decision = parseDecisionRequest(outcome?.decision);
  return { runId, command: manifest.workflowId ?? "unknown", status: manifest.status, createdAt: manifest.createdAt,
    ...(manifest.completedAt === undefined ? {} : { completedAt: manifest.completedAt }),
    ...(manifest.risk === undefined ? {} : { risk: manifest.risk }), ...(outcome === undefined ? {} : { outcome }),
    ...(finalState === undefined ? {} : { finalWorkflowState: finalState }), transitions, modelTurns,
    findings: [...findings.values()], eventLog: truncated ? "truncated" : "complete", ...(task === undefined ? {} : { task }),
    ...(deliveryId === undefined ? {} : { deliveryId }), ...(details.offlineRehearsal === true ? { offlineRehearsal: true } : {}),
    ...(decision === undefined ? {} : { decision }), ...(evidence === undefined ? {} : { evidence }),
    ...(tournament === undefined ? {} : { tournament }) };
}
