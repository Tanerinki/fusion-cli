import { writerChangeScope } from "../../core/change/contract.js";
import type { BuildEvidence } from "../../core/evidence/build.js";
import type { ObligationRequirement } from "../../core/evidence/obligations.js";
import { FusionFailure } from "../../core/errors.js";
import { advance, independenceOf, TOURNAMENT_LIMITS, type CandidateId, type CandidateState, type Independence,
  type TournamentOutcome } from "../../core/tournament/contracts.js";
import { candidateManifest, contractSha256, patchSha256, proposalSha256, snapshotSha256, tournamentManifest, type CandidateManifest,
  type ContractInput } from "../../core/tournament/manifest.js";
import { meshVerdict, type MeshNode } from "../../core/tournament/mesh.js";
import type { MutationPlan } from "../../core/tournament/mutation.js";
import { freezeProfile, type ExperimentSpecs, type FrozenProfile } from "../../core/tournament/profile.js";
import { TOURNAMENT_POLICY_VERSION, TournamentBudgetRefused } from "../../core/tournament/route.js";
import { selectCandidate, type CandidateFacts, type Selection } from "../../core/tournament/selection.js";
import { candidatePacket, STRATEGY_BRIEFS } from "../../core/tournament/strategies.js";
import { WorkflowEngine } from "../../core/workflow/engine.js";
import type { CleanupReport, EventSink, VerificationObservation, WorkflowConfig, WorkflowRequest, WorkflowResult,
  WorkspacePort } from "../../core/workflow/types.js";
import type { EventScope, TournamentCandidateRecord, TournamentDecidedRecord, TournamentStartedRecord } from "../../platform/events/types.js";
import { DEPENDENCY_CONTROL_FILES } from "../../platform/verification/dependency-policy.js";
import { fatalPrecedence, runBounded, type BatchReport } from "../orchestration/scheduler.js";
import { baselinePaths, baselineVerdict, changedLinesOf, mutationsFrom, readBaselineTexts, revalidateCandidate, runBaselineProbes,
  runCandidateExperiments, runMutations, type MaterializedTarget, type Reproducer } from "./experiments.js";

/**
 * v0.5 — THE TOURNAMENT. Several candidates for one frozen task, each generated independently by the unchanged v0.4 engine in
 * its own private candidate; Fusion freezes the verification profile before any exists, materializes and verifies them, runs
 * its own experiments, selects by its own evidence (or reports a tie, or that nothing was verified) and revalidates the selected
 * candidate freshly, exactly once. Models propose; nothing here reads a model's opinion of a candidate.
 *
 * Every candidate's events are bound to it EXPLICITLY (its scope: tournament, candidate, revision) — candidates run
 * concurrently and their events interleave, so no consumer may infer a candidate from an event's position. The decision event
 * binds the selected candidate, its revision and the event id of the evidence decision that permits its delivery.
 */
export interface TournamentInput {
  /** The tournament's id (`t-…`), fixed by the caller before anything runs. */
  readonly tournamentId: string;
  /** From the route: 1–3. */
  readonly candidates: number;
  readonly source: "policy" | "human" | "advice";
  readonly maxParallel?: number;
  /** One candidate's v0.4 request; its run id, packet and signal are Fusion's per candidate. */
  readonly request: WorkflowRequest;
  readonly contract: ContractInput;
  readonly obligations: readonly ObligationRequirement[];
  readonly falsification: "required" | "optional";
  readonly experiments: ExperimentSpecs;
  readonly handoffBasis?: string;
}
export interface TournamentRuntime {
  /** Fusion's own candidate port: the frozen baseline, experiments, mutations and the revalidation. */
  readonly workspace: WorkspacePort;
  /** A fresh engine configuration for one candidate, whose events go to `events`. */
  engine(candidate: CandidateId, events: EventSink): WorkflowConfig;
  /** The provider and model that author a candidate (independence is stated from these, never assumed). */
  binding(candidate: CandidateId): Readonly<{ provider: string; model: string }>;
  /** The v0.4 evidence decision of a result whose verification covers `plannedCommands` checks. */
  evaluate(result: WorkflowResult, plannedCommands: number): BuildEvidence;
}
/** What a tournament records; RunRecorder implements it. */
export interface TournamentRecorder {
  sink(scope: EventScope): EventSink;
  recordTournamentStart(tournamentId: string, record: TournamentStartedRecord): Promise<void>;
  recordEvidence(evidence: BuildEvidence, scope: EventScope): Promise<string>;
  recordTournamentCandidate(scope: Readonly<{ tournamentId: string; candidate: CandidateId; revision: string }>, record: TournamentCandidateRecord): Promise<void>;
  recordTournamentDecision(tournamentId: string, record: Omit<TournamentDecidedRecord, "artifactRef">, artifact: unknown): Promise<string>;
}
/** A tie, shown to a human: the tied candidates and Fusion's host-observed differences. Never a model's choice. */
export interface TieChoice {
  readonly tournamentId: string;
  readonly candidates: readonly CandidateId[];
  readonly differences: readonly string[];
  readonly inconclusive: boolean;
}
export interface TournamentOptions {
  /** A HUMAN's choice among tied candidates (the interactive shell); absent or undefined: the tie is the outcome. */
  readonly chooseTie?: (tie: TieChoice) => Promise<CandidateId | undefined>;
}
export type CandidateFailure = "provider" | "materialization" | "budget" | "cancelled";
export interface CandidateSummary {
  readonly id: CandidateId;
  readonly strategy: string;
  readonly state: CandidateState;
  readonly failure?: CandidateFailure;
  readonly detail: string;
  readonly revision?: string;
  readonly manifest?: CandidateManifest;
  readonly decision?: string;
  readonly deliverable: boolean;
  readonly nodes: readonly MeshNode[];
  readonly notMutated: MutationPlan["notMutated"];
  readonly facts: CandidateFacts;
  readonly evidenceDecisionId?: string;
}
export interface TournamentReport {
  readonly tournamentId: string;
  readonly outcome: TournamentOutcome;
  readonly detail: string;
  readonly profile: FrozenProfile;
  readonly contractSha256: string;
  readonly snapshotSha256: string;
  readonly independence: Independence;
  readonly candidates: readonly CandidateSummary[];
  readonly selection?: Selection;
  readonly differences: readonly string[];
  readonly selected?: Readonly<{ id: CandidateId; revision: string; chosenBy: "fusion" | "human" }>;
  readonly tied?: readonly CandidateId[];
  readonly revalidation?: Readonly<{ passed: boolean; detail: string; patchSha256: string | null }>;
  /** Only for DELIVERY_ELIGIBLE: the revalidated result for the unchanged v0.4 delivery, and the decision that permits it. */
  readonly delivery?: Readonly<{ result: WorkflowResult; evidence: BuildEvidence; evidenceDecisionId: string; proposalSha256: string }>;
  readonly manifestSha256: string;
  readonly decisionEventId: string;
  readonly primaryUnchanged: boolean;
  readonly cleanup: Readonly<{ materializations: number; complete: boolean }>;
}

interface Run {
  readonly id: CandidateId;
  state: CandidateState;
  failure?: CandidateFailure;
  detail: string;
  result?: WorkflowResult;
  manifest?: Readonly<{ manifest: CandidateManifest; sha256: string }>;
  target?: MaterializedTarget;
  proposal?: string;
  evidence?: BuildEvidence;
  evidenceDecisionId?: string;
  nodes: MeshNode[];
  notMutated: MutationPlan["notMutated"];
  reproducers: Reproducer[];
  facts: CandidateFacts;
}
const DEFAULT_RUN_MS = 30 * 60_000;
/** The scheduler's backstop beyond the engine's own deadline, which ends a candidate first. */
const BACKSTOP_MS = 60_000;
const DEPENDENCY_FILES = new Set(DEPENDENCY_CONTROL_FILES.map(name => name.toLowerCase()));

function failedFacts(id: CandidateId): CandidateFacts {
  return { id, revision: "", patchSha256: "", failed: true, securityViolation: false, deliverable: false, failedObligations: [], contradictions: [],
    profileComplete: false, falsification: "notRequired", mutation: { run: 0, survived: 0 }, newDependency: false, changedFiles: 0, changedLines: null };
}
function failureOf(result: WorkflowResult | undefined, timedOut: boolean, error: unknown): CandidateFailure {
  const kind = result?.error?.kind ?? (error instanceof FusionFailure ? error.error.kind : undefined);
  if (timedOut || kind === "Timeout") return "budget";
  if (kind === "Cancelled") return "cancelled";
  if (kind === "WorkspaceConflict") return "materialization";
  return "provider";
}

export async function runTournament(input: TournamentInput, runtime: TournamentRuntime, recorder: TournamentRecorder,
  options: TournamentOptions = {}): Promise<TournamentReport> {
  const { request, tournamentId: tid } = input;
  if (!Number.isSafeInteger(input.candidates) || input.candidates < 1 || input.candidates > TOURNAMENT_LIMITS.maxCandidates)
    throw new TournamentBudgetRefused(input.candidates);
  const port = runtime.workspace, signal = request.signal, runId = request.runId;
  const ids = TOURNAMENT_LIMITS.candidateIds.slice(0, input.candidates);
  const cleanup: CleanupReport[] = [];
  const primaryBefore = await port.fingerprint(undefined, signal);

  // 1. THE FROZEN BASELINE — before any candidate exists: Fusion's checks on the unchanged baseline, and its probes' reference.
  let violation: string | undefined;
  let reproduction: Readonly<{ ran: boolean; commands: readonly Readonly<{ id: string; passed: boolean }>[] }> = { ran: false, commands: [] };
  if (request.reproduce === true && request.verification.commands.length > 0) {
    const base = await baselineVerdict(port, `${runId}.baseline`, request.verification, signal);
    cleanup.push(...base.cleanup);
    violation = base.violation;
    const verdict = base.value;
    if (verdict !== undefined && verdict.refusal === undefined && verdict.commandsRun > 0)
      reproduction = { ran: true, commands: (verdict.evidence?.commands ?? []).map(c => ({ id: c.id, passed: c.status === "passed" })) };
  }
  let reference: ReadonlyMap<string, VerificationObservation | undefined> = new Map();
  if (violation === undefined) {
    const probes = await runBaselineProbes(port, `${runId}.baseline-probes`, input.experiments, signal);
    cleanup.push(...probes.cleanup);
    violation = probes.violation;
    reference = probes.observations;
  }
  const profile = freezeProfile({ policyVersion: TOURNAMENT_POLICY_VERSION, commands: request.verification.commands,
    baseline: { reproduced: reproduction.ran, failing: reproduction.commands.filter(c => !c.passed).map(c => c.id) },
    obligations: input.obligations, falsification: input.falsification, experiments: input.experiments });
  const contract = contractSha256(input.contract);
  const snapshot = snapshotSha256({ baseCommit: input.contract.baseCommit, reproduction,
    ...(input.handoffBasis === undefined ? {} : { handoffBasis: input.handoffBasis }) });
  const independence = independenceOf(ids.map(id => runtime.binding(id)));
  await recorder.recordTournamentStart(tid, { policyVersion: TOURNAMENT_POLICY_VERSION, candidates: ids.length, source: input.source, independence,
    profileSha256: profile.sha256, contractSha256: contract, snapshotSha256: snapshot, reproduced: reproduction.ran });

  const runs: Run[] = ids.map(id => ({ id, state: "proposed", detail: "", nodes: [], notMutated: [], reproducers: [], facts: failedFacts(id) }));
  const byId = new Map(runs.map(r => [r.id, r]));
  const planned = request.verification.commands.length;

  // 2. INDEPENDENT CANDIDATES — the unchanged v0.4 engine, each with its own brief, sessions, views and private candidate.
  const results = new Map<CandidateId, WorkflowResult>();
  let batch: BatchReport<WorkflowResult> | undefined, fatal: unknown;
  if (violation === undefined) {
    try {
      batch = await runBounded(ids.map(id => ({ id, run: async (own: AbortSignal) => {
        const engine = new WorkflowEngine(runtime.engine(id, recorder.sink({ tournamentId: tid, candidate: id })));
        const result = await engine.run({ ...request, runId: `${runId}.${id}`, packet: candidatePacket(request.packet, id), signal: own });
        results.set(id, result);
        // A candidate's security violation stops the whole tournament, its siblings included.
        if (result.error?.kind === "SecurityViolation") throw new FusionFailure(result.error);
        return result;
      } })), { concurrency: Math.min(input.maxParallel ?? TOURNAMENT_LIMITS.maxParallel, TOURNAMENT_LIMITS.maxParallel),
        timeoutMs: (request.timeoutMs ?? DEFAULT_RUN_MS) + BACKSTOP_MS, ...(signal === undefined ? {} : { signal }),
        fatal: error => fatalPrecedence(error) === 3 });
    } catch (error) { fatal = error; }
  }
  const security = (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === "SecurityViolation";
  if (security(fatal)) violation = "a candidate's run was stopped for a security violation";
  const cancelled = fatal instanceof FusionFailure && fatal.error.kind === "Cancelled";
  if (fatal !== undefined && !security(fatal) && !cancelled) throw fatal;

  // 3. EVALUATION under the frozen profile: the v0.4 decision, then Fusion's experiments and mutations, then the decision again.
  for (const run of runs) {
    const item = batch?.results.find(r => r.id === run.id);
    const result = results.get(run.id);
    if (result !== undefined) run.result = result;
    // A candidate its deadline or a cancellation stopped is not judged, even if it had applied a change.
    const stopped = result?.error?.kind === "Timeout" || result?.error?.kind === "Cancelled";
    if (result?.changeSet === undefined || result.applied === undefined || stopped) {
      run.failure = failureOf(result, item?.status === "rejected" && item.timedOut, item?.status === "rejected" ? item.error : fatal);
      run.detail = result === undefined ? "its run did not finish" : stopped ? `its run was stopped (${result.error!.kind})`
        : `its run ended ${result.state} without a change (${result.error?.kind ?? "no proposal"})`;
      run.state = advance(run.state, "failed");
    } else run.state = advance(run.state, "materialized");
  }
  const judged = violation === undefined && !cancelled ? runs.filter(r => r.state === "materialized") : [];
  const pre = new Map<CandidateId, BuildEvidence>();
  for (const run of judged) {
    const result = run.result!, changes = result.changeSet!;
    run.proposal = proposalSha256(changes);
    const patch = patchSha256(result.applied!);
    run.manifest = candidateManifest({ tournamentId: tid, candidate: run.id, strategy: STRATEGY_BRIEFS[run.id].id, contractSha256: contract,
      snapshotSha256: snapshot, profileSha256: profile.sha256, proposalSha256: run.proposal, patchSha256: patch,
      changedPaths: result.changedPaths ?? [], policyVersion: TOURNAMENT_POLICY_VERSION });
    run.target = { candidate: run.id, revision: run.manifest.sha256, changes, scope: writerChangeScope(candidatePacket(request.packet, run.id)),
      patchSha256: patch };
    pre.set(run.id, runtime.evaluate(result, planned));
  }
  // Experiments only for candidates the v0.4 decision already lets through: no budget is spent on the rest.
  const contenders = judged.filter(r => r.result!.state === "completed" && pre.get(r.id)!.decision.deliverable);
  let texts: ReadonlyMap<string, string | null | "tooLarge"> | undefined;
  if (contenders.length > 0) {
    const read = await readBaselineTexts(port, `${runId}.baseline-texts`, contenders.flatMap(r => baselinePaths(r.result!.changeSet!)), signal);
    cleanup.push(...read.cleanup);
    violation ??= read.violation;
    texts = read.value;
  }
  for (const run of contenders) {
    if (violation !== undefined) break;
    const experiments = await runCandidateExperiments(port, `${runId}.${run.id}.x`, run.target!, input.experiments, profile.sha256, reference, signal);
    cleanup.push(...experiments.cleanup);
    run.nodes.push(...experiments.nodes);
    run.reproducers.push(...experiments.reproducers.map(r => ({ ...r, excerpt: r.excerpt.slice(-TOURNAMENT_LIMITS.reproducerChars) })));
    violation ??= experiments.violation;
    if (violation !== undefined || !input.experiments.mutation.enabled) continue;
    const plan = mutationsFrom(run.id, run.result!.changeSet!, texts, input.experiments.mutation.maxPerCandidate);
    run.notMutated = plan.notMutated;
    const mutated = await runMutations(port, `${runId}.${run.id}.m`, run.target!, plan.mutations, request.verification, signal);
    cleanup.push(...mutated.cleanup);
    run.nodes.push(...mutated.nodes);
    violation ??= mutated.violation;
  }
  const contending = new Set(contenders.map(r => r.id));
  for (const run of judged) {
    if (violation !== undefined) break;
    const result = run.result!, revision = run.manifest!.sha256;
    const meshed = meshVerdict(result.verification, profile.profile, run.nodes);
    const final = contending.has(run.id) ? runtime.evaluate({ ...result, ...(meshed.verdict === undefined ? {} : { verification: meshed.verdict }) }, meshed.planned)
      : pre.get(run.id)!;
    run.evidence = final;
    run.evidenceDecisionId = await recorder.recordEvidence(final, { tournamentId: tid, candidate: run.id, revision, stage: "candidate" });
    const own = result.reproduction?.ran === true ? new Map((result.reproduction.verdict.evidence?.commands ?? []).map(c => [c.id, c.status === "passed"])) : undefined;
    // A candidate's own reproduction that disagrees with the frozen baseline: the baseline is not deterministic, so the
    // profile does not hold for it.
    const baselineAgrees = !reproduction.ran || own === undefined || reproduction.commands.every(c => !own.has(c.id) || own.get(c.id) === c.passed);
    const verificationComplete = contending.has(run.id) ? meshed.verdict?.commandsRun === meshed.planned
      : result.verification?.refusal === undefined && result.verification?.commandsRun === planned;
    const contradictions = run.nodes.filter(n => n.source === "configured" && n.authority === "deterministic" && n.result === "fail").map(n => n.id);
    const mutations = run.nodes.filter(n => n.kind === "mutation");
    const deliverable = final.decision.deliverable && result.state === "completed";
    const freshReview = final.decision.obligations.find(o => o.kind === "freshReviewClear");
    run.facts = { id: run.id, revision, patchSha256: run.target!.patchSha256, failed: false, securityViolation: false, decision: final.decision.decision,
      deliverable, failedObligations: final.decision.obligations.filter(o => o.status === "FAIL" && o.tier === "safety").map(o => o.kind),
      contradictions, profileComplete: verificationComplete && baselineAgrees,
      falsification: input.falsification === "required" ? freshReview?.status === "PASS" ? "clean" : "failed" : "notRequired",
      mutation: { run: mutations.filter(n => n.result !== "notRun").length, survived: mutations.filter(n => n.result === "fail").length },
      newDependency: (result.changedPaths ?? []).some(path => DEPENDENCY_FILES.has(path.split("/").pop()!.toLowerCase())),
      changedFiles: (result.changedPaths ?? []).length, changedLines: contending.has(run.id) ? changedLinesOf(result.changeSet!, texts) : null };
    run.state = advance(run.state, deliverable && final.decision.decision === "VERIFIED" ? "verified"
      : final.decision.decision === "BLOCKED" || contradictions.length > 0 ? "rejected" : "unverified");
    run.detail = !baselineAgrees ? "its own baseline reproduction disagrees with the frozen profile" : `${final.decision.decision}`;
    await recorder.recordTournamentCandidate({ tournamentId: tid, candidate: run.id, revision }, { state: run.state,
      decision: final.decision.decision, deliverable, profileComplete: run.facts.profileComplete, contradictions: contradictions.length,
      mutationsRun: run.facts.mutation.run, mutationsSurvived: run.facts.mutation.survived, evidenceDecisionId: run.evidenceDecisionId });
  }

  // 4. SELECTION by Fusion's evidence — or a tie, or none.
  let outcome: TournamentOutcome = "NO_VERIFIED_CANDIDATE", detail = "", selection: Selection | undefined, differences: readonly string[] = [];
  let selected: TournamentReport["selected"], tied: readonly CandidateId[] | undefined, revalidationDecisionId: string | undefined;
  let revalidation: TournamentReport["revalidation"], delivery: TournamentReport["delivery"];
  const primaryAfter = await port.fingerprint(undefined, signal).catch(() => undefined);
  const primaryUnchanged = primaryAfter === primaryBefore;
  if (!primaryUnchanged) violation ??= "the primary checkout changed during the tournament";
  if (violation !== undefined) {
    outcome = "CANDIDATE_SECURITY_VIOLATION";
    detail = `The tournament stopped: ${violation}.`;
  } else if (cancelled) {
    outcome = "CANCELLED";
    detail = "The tournament was cancelled.";
  } else {
    selection = selectCandidate(runs.map(r => r.facts));
    for (const run of runs) if (run.state === "verified")
      run.state = advance(run.state, selection.eliminated.some(e => e.id === run.id) ? "rejected" : "survivor");
    if (selection.kind === "none") {
      const failures = runs.map(r => r.failure);
      const allFailed = failures.every(f => f !== undefined);
      outcome = !allFailed ? selection.outcome : failures.every(f => f === "cancelled") ? "CANCELLED"
        : failures.includes("budget") ? "TOURNAMENT_BUDGET_EXHAUSTED" : failures.every(f => f === "materialization") ? "CANDIDATE_MATERIALIZATION_FAILED"
        : "PROVIDER_FAILURE";
      detail = `No candidate can be delivered: ${selection.eliminated.map(e => `${e.id} — ${e.reason}`).join("; ") || "none was judged"}.`;
    } else {
      let winner: CandidateId | undefined, chosenBy: "fusion" | "human" = "fusion";
      if (selection.kind === "selected") {
        winner = selection.winner;
        for (const run of runs) if (run.state === "survivor") run.state = advance(run.state, run.id === winner ? "selected" : "notSelected");
        differences = selection.reasons;
      } else {
        const tiedIds = selection.candidates;
        for (const run of runs) if (run.state === "survivor") run.state = advance(run.state, tiedIds.includes(run.id) ? "tied" : "notSelected");
        const discriminating = differential(tiedIds.map(id => byId.get(id)!));
        differences = [...selection.differences, ...discriminating.differences];
        const inconclusive = discriminating.inconclusive || (input.experiments.mutation.enabled &&
          tiedIds.some(id => byId.get(id)!.facts.mutation.run === 0));
        const choice = options.chooseTie === undefined ? undefined
          : await options.chooseTie({ tournamentId: tid, candidates: tiedIds, differences, inconclusive });
        if (choice !== undefined && tiedIds.includes(choice)) { winner = choice; chosenBy = "human"; }
        // Without a choice the tie stands: the tied candidates stay tied.
        if (winner !== undefined) for (const run of runs) if (run.state === "tied") run.state = advance(run.state, run.id === winner ? "selected" : "notSelected");
        if (winner === undefined) {
          tied = tiedIds;
          outcome = inconclusive ? "DISCRIMINATOR_INCONCLUSIVE" : "MULTIPLE_VERIFIED_CANDIDATES";
          detail = `${tiedIds.join(", ")} are verified and Fusion's evidence does not separate them${inconclusive ? " (a discriminating experiment did not complete)" : ""}: a human decision.`;
        }
      }
      if (winner !== undefined) {
        // 5. THE FRESH REVALIDATION — exactly once, never retried until it passes.
        const run = byId.get(winner)!, revision = run.manifest!.sha256;
        selected = { id: winner, revision, chosenBy };
        const fresh = await revalidateCandidate(port, `${runId}.revalidate`, run.target!, request.verification, signal);
        cleanup.push(...fresh.cleanup);
        const again = await port.fingerprint(undefined, signal).catch(() => undefined);
        if (fresh.violation !== undefined || again !== primaryBefore) {
          run.state = advance(run.state, "rejected");
          outcome = "CANDIDATE_SECURITY_VIOLATION";
          detail = `The revalidation stopped the tournament: ${fresh.violation ?? "the primary checkout changed"}.`;
          revalidation = { passed: false, detail, patchSha256: null };
        } else if (fresh.value === undefined) {
          run.state = advance(run.state, "rejected");
          outcome = "CANDIDATE_MATERIALIZATION_FAILED";
          detail = `The selected candidate ${winner} could not be materialized again: ${fresh.unavailable ?? "unknown"}.`;
          revalidation = { passed: false, detail, patchSha256: null };
        } else {
          const meshed = meshVerdict(fresh.value, profile.profile, run.nodes);
          const result: WorkflowResult = { ...run.result!, ...(meshed.verdict === undefined ? {} : { verification: meshed.verdict }) };
          const evidence = runtime.evaluate(result, meshed.planned);
          const evidenceDecisionId = await recorder.recordEvidence(evidence, { tournamentId: tid, candidate: winner, revision, stage: "revalidation" });
          const passed = fresh.value.refusal === undefined && fresh.value.passed && evidence.decision.deliverable;
          revalidation = { passed, patchSha256: run.target!.patchSha256,
            detail: passed ? "a fresh candidate with the same tree passed the common profile again" : "the fresh revalidation did not pass the common profile" };
          if (passed) {
            run.state = advance(advance(run.state, "revalidated"), "deliveryEligible");
            outcome = "DELIVERY_ELIGIBLE";
            detail = `${winner} was selected (${chosenBy === "human" ? "your choice among tied candidates" : "by Fusion's evidence"}) and revalidated freshly.`;
            delivery = { result, evidence, evidenceDecisionId, proposalSha256: run.proposal! };
          } else {
            run.state = advance(run.state, "rejected");
            outcome = "REVALIDATION_MISMATCH";
            detail = `${winner} did not pass its fresh revalidation; nothing is delivered and it is not retried.`;
          }
          run.evidenceDecisionId = revalidationDecisionId = evidenceDecisionId;
        }
      }
    }
  }

  // 6. THE RECORD — the manifest binds every candidate's revision, the outcome, the selection and the revalidation.
  const manifest = tournamentManifest({ tournamentId: tid, runId, baseCommit: input.contract.baseCommit, contractSha256: contract,
    snapshotSha256: snapshot, profileSha256: profile.sha256, independence,
    candidates: runs.map(r => ({ id: r.id, state: r.state, manifestSha256: r.manifest?.sha256 ?? null })), outcome,
    selected: selected?.id ?? null, revalidation: revalidation === undefined ? null : { passed: revalidation.passed, patchSha256: revalidation.patchSha256 } });
  const summaries: CandidateSummary[] = runs.map(r => Object.freeze({ id: r.id, strategy: STRATEGY_BRIEFS[r.id].id, state: r.state,
    ...(r.failure === undefined ? {} : { failure: r.failure }), detail: r.detail,
    ...(r.manifest === undefined ? {} : { revision: r.manifest.sha256, manifest: r.manifest.manifest }),
    ...(r.evidence === undefined ? {} : { decision: r.evidence.decision.decision }), deliverable: r.facts.deliverable, nodes: Object.freeze([...r.nodes]),
    notMutated: r.notMutated, facts: r.facts, ...(r.evidenceDecisionId === undefined ? {} : { evidenceDecisionId: r.evidenceDecisionId }) }));
  // The decision binds only the selected candidate's REVALIDATION decision — never a candidate-stage one.
  const decisionEventId = await recorder.recordTournamentDecision(tid, { outcome,
    ...(selected === undefined ? {} : { selected: selected.id, selectedRevision: selected.revision, chosenBy: selected.chosenBy }),
    ...(tied === undefined ? {} : { tied }), ...(revalidationDecisionId === undefined ? {} : { evidenceDecisionId: revalidationDecisionId }),
    manifestSha256: manifest.sha256 }, {
    format: "fusion.tournament", version: 1, manifest: manifest.manifest, profile: profile.profile,
    candidates: summaries.map(s => ({ id: s.id, strategy: s.strategy, state: s.state, failure: s.failure ?? null, detail: s.detail,
      manifest: s.manifest ?? null, facts: s.facts, notMutated: s.notMutated,
      nodes: s.nodes.map(n => ({ id: n.id, kind: n.kind, source: n.source, authority: n.authority, result: n.result, detail: n.detail,
        exitCode: n.exitCode ?? null, outputSha256: n.outputSha256 ?? null, complete: n.complete ?? null, obligation: n.obligation ?? null })),
      reproducers: byId.get(s.id)!.reproducers })),
    selection: selection ?? null, differences, revalidation: revalidation ?? null });
  const complete = cleanup.every(c => c.complete) && [...results.values()].every(r => r.cleanup?.complete !== false);
  return Object.freeze({ tournamentId: tid, outcome, detail, profile, contractSha256: contract, snapshotSha256: snapshot, independence,
    candidates: Object.freeze(summaries), ...(selection === undefined ? {} : { selection }), differences: Object.freeze([...differences]),
    ...(selected === undefined ? {} : { selected }), ...(tied === undefined ? {} : { tied }), ...(revalidation === undefined ? {} : { revalidation }),
    ...(delivery === undefined ? {} : { delivery }), manifestSha256: manifest.sha256, decisionEventId, primaryUnchanged,
    cleanup: Object.freeze({ materializations: cleanup.length, complete }) });
}

/**
 * DIFFERENTIAL TESTING among tied candidates: the compare probes' output digests, compared only when completely retained. A
 * difference discriminates (a human sees it) but eliminates no one — there is no oracle. A compare probe without a complete
 * observation for every tied candidate leaves the comparison inconclusive.
 */
function differential(tied: readonly Run[]): Readonly<{ differences: readonly string[]; inconclusive: boolean }> {
  const differences: string[] = [];
  let inconclusive = false;
  const probes = new Set(tied.flatMap(r => r.nodes.filter(n => n.kind === "probe" && n.source === "configured").map(n => n.id)));
  for (const id of [...probes].sort()) {
    const observed = tied.map(r => r.nodes.find(n => n.id === id));
    if (!observed.every(n => n?.result === "observed" && n.complete === true && n.outputSha256 !== undefined)) {
      if (observed.some(n => n?.result === "notRun" || n === undefined)) inconclusive = true;
      continue;
    }
    const groups = new Map<string, CandidateId[]>();
    observed.forEach((n, i) => groups.set(`${n!.exitCode}:${n!.outputSha256}`, [...(groups.get(`${n!.exitCode}:${n!.outputSha256}`) ?? []), tied[i]!.id]));
    if (groups.size > 1) differences.push(`${id}: the candidates behave differently (${[...groups.values()].map(g => g.join("=")).join(" ≠ ")})`);
  }
  return Object.freeze({ differences: Object.freeze(differences), inconclusive });
}
