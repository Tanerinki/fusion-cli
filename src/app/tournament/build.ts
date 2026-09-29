import type { BuildEvidence } from "../../core/evidence/build.js";
import type { ReliabilityPlan } from "../../core/evidence/policy.js";
import type { FusionError } from "../../core/domain.js";
import type { CandidateId, Independence, TournamentOutcome } from "../../core/tournament/contracts.js";
import type { ContractInput } from "../../core/tournament/manifest.js";
import type { ExperimentSpecs } from "../../core/tournament/profile.js";
import type { TournamentRoute } from "../../core/tournament/route.js";
import { proposalSha256 } from "../../core/tournament/manifest.js";
import { FusionFailure } from "../../core/errors.js";
import type { RoleCandidate } from "../../core/policy/routing.js";
import type { EventSink, ProviderViewPort, VerifierPort, WorkflowRequest, WorkflowResult, WorkspacePort } from "../../core/workflow/types.js";
import { EXIT_CODES } from "../../cli/failure-presentation.js";
import { failedOutcome, type CommandOutcome } from "../outcome.js";
import type { RunRecorder } from "../runs.js";
import { runTournament, type TieChoice, type TournamentReport } from "./run.js";

/**
 * v0.5 — a `fusion build` as a TOURNAMENT: the build's own composition (roles, candidate port, provider views, confined plan)
 * for every candidate, the build's reliability plan as the frozen obligations, and the build's evidence decision as the
 * judge. What comes out is a tournament report, a user-visible outcome and a bounded summary; a delivery is prepared by the
 * build, from the revalidated result only.
 */
export interface BuildTournamentInput {
  readonly tournamentId: string;
  readonly recorder: RunRecorder;
  readonly roles: readonly RoleCandidate[];
  readonly workspace: WorkspacePort;
  readonly views: ProviderViewPort;
  readonly verifier: VerifierPort;
  readonly route: TournamentRoute;
  /** One candidate's v0.4 request, exactly as the build would run it alone. */
  readonly request: WorkflowRequest;
  readonly contract: ContractInput;
  readonly reliability: ReliabilityPlan;
  readonly experiments: ExperimentSpecs;
  readonly handoffBasis?: string;
  readonly evaluate: (result: WorkflowResult, plannedCommands: number) => Promise<BuildEvidence>;
  readonly chooseTie?: (tie: TieChoice) => Promise<CandidateId | undefined>;
}

export async function runBuildTournament(input: BuildTournamentInput): Promise<TournamentReport> {
  const worker = input.roles.find(role => role.binding.role === "Worker")?.binding;
  return runTournament({ tournamentId: input.tournamentId, candidates: input.route.candidates, source: input.route.source, request: input.request,
    contract: input.contract, obligations: input.reliability.obligations,
    falsification: input.reliability.freshReview && input.reliability.objective === "falsify" ? "required" : "optional",
    experiments: input.experiments, ...(input.handoffBasis === undefined ? {} : { handoffBasis: input.handoffBasis }) }, {
    workspace: input.workspace,
    engine: (_candidate, events: EventSink) => ({ roles: input.roles, workspace: input.workspace, views: input.views, verifier: input.verifier, events }),
    // Every candidate is authored by the configured Worker binding: separate contexts, never claimed as model diversity.
    binding: () => ({ provider: worker?.provider ?? "unknown", model: worker?.model.id ?? "unknown" }),
    evaluate: input.evaluate,
  }, input.recorder, input.chooseTie === undefined ? {} : { chooseTie: input.chooseTie });
}

/**
 * The ONLY way a tournament reaches a delivery: its outcome is DELIVERY_ELIGIBLE, and the revalidated result carries exactly the
 * ChangeSet the selected candidate's manifest binds. Anything else is a defect — refused as a security violation, never delivered.
 */
export function selectedDelivery(report: TournamentReport): Readonly<{ result: WorkflowResult; evidence: BuildEvidence }> | undefined {
  if (report.outcome !== "DELIVERY_ELIGIBLE") return undefined;
  const eligible = report.delivery, selected = report.candidates.find(c => c.id === report.selected?.id);
  if (eligible === undefined || eligible.result.changeSet === undefined || selected?.state !== "deliveryEligible" ||
      proposalSha256(eligible.result.changeSet) !== eligible.proposalSha256 || selected.manifest?.proposalSha256 !== eligible.proposalSha256 ||
      selected.revision !== report.selected?.revision || !eligible.evidence.decision.deliverable)
    throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
      safeMessage: "The change to deliver is not the selected candidate's revalidated change." });
  return Object.freeze({ result: eligible.result, evidence: eligible.evidence });
}

const failure = (kind: FusionError["kind"], safeMessage: string): FusionError => ({ kind, retryable: false, safeMessage });
/** One user-visible outcome per tournament outcome; nothing is collapsed into a generic failure. */
export function tournamentOutcome(report: TournamentReport): CommandOutcome {
  const message = report.detail;
  const decision = (code: TournamentOutcome): CommandOutcome => ({ state: "DECISION_REQUIRED", exitCode: EXIT_CODES.decisionRequired, code,
    message: `${message} Nothing was delivered or applied.` });
  switch (report.outcome) {
    case "DELIVERY_ELIGIBLE":
      return { state: "COMPLETED", exitCode: EXIT_CODES.success, code: "completed", message: `Completed: ${message}` };
    case "MULTIPLE_VERIFIED_CANDIDATES": case "DISCRIMINATOR_INCONCLUSIVE": case "NO_VERIFIED_CANDIDATE": case "VERIFICATION_PROFILE_FAILED":
    case "FALSIFICATION_REQUIRED_FAILED": case "REVALIDATION_MISMATCH":
      return decision(report.outcome);
    case "TOURNAMENT_BUDGET_EXHAUSTED":
      return { ...failedOutcome(failure("Timeout", message)), code: report.outcome };
    case "CANCELLED":
      return { ...failedOutcome(failure("Cancelled", message)), code: report.outcome };
    case "CANDIDATE_SECURITY_VIOLATION":
      return { ...failedOutcome(failure("SecurityViolation", message)), code: report.outcome };
    case "CANDIDATE_MATERIALIZATION_FAILED":
      return { ...failedOutcome(failure("WorkspaceConflict", message)), code: report.outcome };
    case "PROVIDER_FAILURE":
      return { ...failedOutcome(failure("ProcessFailure", message)), code: report.outcome };
    case "DECISION_REQUESTED":
      return { state: "DECISION_REQUIRED", exitCode: EXIT_CODES.decisionRequired, code: report.outcome,
        message: `${message} Nothing was delivered or applied.` };
    case "HUMAN_GATE_REQUIRED":
      return { state: "HUMAN_GATE_REQUIRED", exitCode: EXIT_CODES.humanGateRequired, code: report.outcome, pendingStage: "humanGate",
        message: `${message} A human must approve before any autonomous work continues.` };
  }
}

/** A bounded, content-free account of a tournament for the build report (labels, states, counts and digests). */
export interface BuildTournamentSummary {
  readonly outcome: TournamentOutcome;
  readonly detail: string;
  readonly route: Readonly<{ candidates: number; source: "policy" | "human" | "advice"; reasons: readonly string[] }>;
  readonly independence: Independence;
  readonly profileSha256: string;
  readonly manifestSha256: string;
  readonly candidates: readonly Readonly<{ id: CandidateId; strategy: string; state: string; decision?: string; failure?: string; detail: string;
    contradictions: readonly string[]; mutations: Readonly<{ run: number; survived: number }>; changedFiles: number; changedLines: number | null }>[];
  readonly selected?: Readonly<{ id: CandidateId; revision: string; chosenBy: "fusion" | "human" }>;
  /** CONVERGED: the candidates that made the identical change; `selected` is its canonical representative, not a winner. */
  readonly converged?: readonly CandidateId[];
  readonly tied?: readonly CandidateId[];
  readonly reasons: readonly string[];
  readonly revalidation?: Readonly<{ passed: boolean; detail: string }>;
}
export function tournamentSummary(report: TournamentReport, route: TournamentRoute): BuildTournamentSummary {
  return Object.freeze({ outcome: report.outcome, detail: report.detail,
    route: { candidates: route.candidates, source: route.source, reasons: [...route.reasons] }, independence: report.independence,
    profileSha256: report.profile.sha256, manifestSha256: report.manifestSha256,
    candidates: report.candidates.map(c => Object.freeze({ id: c.id, strategy: c.strategy, state: c.state, ...(c.decision === undefined ? {} : { decision: c.decision }),
      ...(c.failure === undefined ? {} : { failure: c.failure }), detail: c.detail, contradictions: [...c.facts.contradictions],
      mutations: { run: c.facts.mutation.run, survived: c.facts.mutation.survived }, changedFiles: c.facts.changedFiles, changedLines: c.facts.changedLines })),
    ...(report.selected === undefined ? {} : { selected: report.selected }), ...(report.converged === undefined ? {} : { converged: report.converged }),
    ...(report.tied === undefined ? {} : { tied: report.tied }),
    reasons: [...(report.selection?.kind === "none" ? report.selection.eliminated.map(e => `${e.id} eliminated: ${e.reason}`) : []), ...report.differences],
    ...(report.revalidation === undefined ? {} : { revalidation: { passed: report.revalidation.passed, detail: report.revalidation.detail } }) });
}
