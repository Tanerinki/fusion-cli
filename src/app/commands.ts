import type { DelegationPacket, FusionError, VerificationPlan } from "../core/domain.js";
import { assembleBuildEvidence, type BuildEvidence } from "../core/evidence/build.js";
import { classifyTask, reliabilityPlan, type ReliabilityPlan } from "../core/evidence/policy.js";
import { deliveryPathViolation } from "../core/delivery/manifest.js";
import { FusionFailure, internalError } from "../core/errors.js";
import { escalateRisk, type RiskAssessment } from "../core/policy/risk.js";
import { RISK_TEXT_LIMITS, scanRiskText } from "../core/policy/risk-text.js";
import { inspectTask, type TaskOperation, type TaskRequest } from "../core/policy/task-inspector.js";
import { reviewMode } from "../core/review/policy.js";
import { WorkflowEngine } from "../core/workflow/engine.js";
import { packetRiskText } from "../core/workflow/packets.js";
import { decisionRequestOf, type DecisionRequest } from "../core/workflow/decision.js";
import type { ReviewCycleRecord, WorkflowResult } from "../core/workflow/types.js";
import { EXIT_CODES, presentFailure } from "../cli/failure-presentation.js";
import { VerificationEngine } from "../platform/verification/engine.js";
import { EngineVerifierPort, ReadOnlyWorkspacePort } from "../platform/workflow/ports.js";
import { observeChange, resolveReviewBase } from "../platform/workspace/change.js";
import { ProcessGitClient, type GitClient } from "../platform/workspace/git.js";
import type { LoadedConfig } from "./config.js";
import { READ_ONLY_BUILD_ROLES, REVIEW_ROLES, type CommandRequest, type ControlPlane } from "./control-plane.js";
import { requireRepository } from "./context.js";
import { failedOutcome, outcomeOf, verificationUnavailableOutcome, writerBlockedOutcome, type CommandOutcome } from "./outcome.js";
import { protectedScope, protectedScopeMessage, type ProtectedScopeFile } from "./build-scope.js";
import { buildCandidates, type ProviderRuntimeContext, type UnavailableBinding } from "./providers.js";
import { RunRecorder, summarizeRun, type RunSummary } from "./runs.js";
import { composeProductionWriter, providerViewPort, type WriterComposition, type WriterRuntime } from "./writer-composition.js";
import { liveWriterAuthorization, writerReadiness, type WriterReadiness, type WriterRunAuthorization } from "./writer-gate.js";
import { prepareBuildDelivery, type BuildDelivery } from "./build-delivery.js";
import { OFFLINE_REHEARSAL_LABEL } from "./writer-rehearsal.js";

const asFusionError = (error: unknown): FusionError => error instanceof FusionFailure ? error.error
  : internalError("The command stopped unexpectedly.", error);
const READ_ONLY_OPERATIONS = new Set<TaskOperation>(["read", "analyze", "review", "test"]);

export interface ReviewOptions extends CommandRequest {
  /** Local ref whose merge base with HEAD is the review base; HEAD (uncommitted work) when absent. */
  readonly base?: string;
  /** Run the configured read-only verification plan as deterministic evidence. */
  readonly verify: boolean;
  readonly timeoutMs?: number;
}
export interface ReviewReport {
  readonly runId?: string;
  readonly base: Readonly<{ label: string; commit: string }>;
  readonly change: Readonly<{ paths: number; truncated: boolean }>;
  readonly risk?: string;
  readonly outcome: CommandOutcome;
  readonly reviews: readonly ReviewCycleRecord[];
  readonly unavailable: readonly UnavailableBinding[];
}

/**
 * Read-only repository review: the Fusion-observed change → task inspection and risk → optional read-only
 * verification → a fresh Reviewer → Lead adjudication. No delegate, no Writer, no lease; the primary workspace is
 * proven unchanged around every turn.
 */
export async function review(plane: ControlPlane, options: ReviewOptions): Promise<ReviewReport> {
  const runtime = await plane.runtime();
  const { root, git } = requireRepository(runtime);
  const loaded = await plane.config(runtime, options);
  const base = await resolveReviewBase(git, root, options.base, options.signal);
  const change = await observeChange(git, root, base.commit, options.signal);
  if (change.changedPaths.length === 0)
    return { base, change: { paths: 0, truncated: false }, reviews: [], unavailable: [], outcome: { state: "ANSWERED", exitCode: 0,
      code: "nothingToReview", message: `Nothing to review: the working tree matches ${base.label}. No run was started.` } };
  const plan: VerificationPlan = options.verify ? loaded.config.verification : { commands: [] };
  // Every Reviewer and adjudicating-Lead session runs in a Fusion-owned copy of the work under review, never the primary.
  const { candidates, unavailable } = await buildCandidates(loaded.config, plane.deps.registry, boundContext(plane, root), REVIEW_ROLES);
  const views = providerViewPort(root, await ProcessGitClient.fromPath(plane.deps.env, true), plane.deps.registry);
  const recorder = await RunRecorder.start(root, "review", plane.redactor);
  const task: TaskRequest = { operation: "review", summary: `Review the changes since ${base.label}.`, paths: change.changedPaths,
    scopeKnown: true, expectedMutation: "none", requestedCapabilities: {},
    verification: { required: false, planProvided: plan.commands.length > 0 } };
  const packet: DelegationPacket = {
    task: { goal: `Review the change since ${base.label} for defects, regressions and security or data-safety risks.`,
      constraints: ["Read-only: report findings; never propose running commands that change the repository or remotes."],
      acceptanceCriteria: ["Every material claim is backed by evidence in the change."] },
    scope: { relevantFiles: change.changedPaths.slice(0, 64), allowedFiles: [], forbiddenFiles: [] },
    architecture: { decisions: [], invariants: [] }, verification: { requiredTests: plan.commands.map(command => command.id) },
    openQuestions: [] };
  let result: WorkflowResult | undefined, outcome: CommandOutcome;
  try {
    const engine = new WorkflowEngine({ roles: candidates, workspace: readOnlyPort(root, git, loaded.config), views,
      verifier: verifierFor(plane, git, recorder), events: recorder.sink() });
    result = await engine.review({ runId: recorder.runId, task, packet, verification: plan, change,
      timeoutMs: options.timeoutMs ?? loaded.config.limits.runTimeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
    outcome = outcomeOf(result);
  } catch (error) { outcome = failedOutcome(asFusionError(error)); }
  await recorder.finish(outcome, result ? { result } : {});
  return { runId: recorder.runId, base, change: { paths: change.changedPaths.length, truncated: change.truncated },
    ...(result?.risk ? { risk: result.risk.level } : {}), outcome, reviews: result?.reviews ?? [], unavailable };
}

export interface BuildOptions extends CommandRequest {
  readonly task: string;
  readonly paths: readonly string[];
  readonly operation: TaskOperation;
  readonly timeoutMs?: number;
  /** v0.1: the human's run-scoped confirmation of exactly this build (issued by the CLI after the human typed it). */
  readonly authorization?: WriterRunAuthorization;
}
export interface BuildReport {
  readonly runId: string;
  readonly risk: Readonly<{ level: string; decisive: readonly string[] }>;
  readonly writerRequired: boolean;
  readonly intendedWorkflow: readonly string[];
  readonly writer: WriterReadiness;
  readonly outcome: CommandOutcome;
  readonly reviews: readonly ReviewCycleRecord[];
  readonly unavailable: readonly UnavailableBinding[];
  /** Present only for an offline Writer rehearsal (test seam): what ran, never file content. */
  readonly rehearsal?: WriterRehearsalSummary;
  /** v0.1: the verification and review summary of a production Writer run (labels and counts only). */
  readonly summary?: BuildSummary;
  /** v0.1: the delivery a completed, verified, review-clean build prepared (never applied). */
  readonly delivery?: BuildDelivery;
  /** v0.1: the bounded decision request a role made when the build stopped for one (DECISION_REQUIRED). */
  readonly decision?: DecisionRequest;
  /** v0.4: Fusion's evidence decision about a Writer run (obligations and their reasons); absent when no Writer ran. */
  readonly evidence?: BuildEvidence;
}
const decisionOf = (result: WorkflowResult | undefined): Readonly<{ decision?: DecisionRequest }> => {
  const decision = result === undefined ? undefined : decisionRequestOf(result);
  return decision === undefined ? {} : { decision };
};
/** What a production build reports: counts and labels, never provider text or file content. */
export interface BuildSummary {
  readonly verification: Readonly<{ passed: boolean; backendId?: string; commands: number; acceptance?: string }> | null;
  readonly review: Readonly<{ cycles: number; findings: number; outstanding: number }>;
  readonly delegateAttempts: number;
  readonly changedPaths: readonly string[];
}
/** The plan a human reads before confirming a Writer build. No provider is started to compute it. */
export interface BuildPlan {
  readonly repository: string;
  readonly task: string;
  readonly risk: Readonly<{ level: string; decisive: readonly string[] }>;
  readonly writerRequired: boolean;
  readonly intendedWorkflow: readonly string[];
  readonly roles: readonly Readonly<{ role: string; adapter: string; model: string; effort: string }>[];
  readonly verification: Readonly<{ confinedCommands: readonly string[]; platformRequirement: string; dependencies: string }>;
  /** The exact files the build may write (given with --path, or proposed by the Lead and confirmed by the human). */
  readonly paths: readonly string[];
  /** v0.2.1: files of that scope a build may never write (protected material); non-empty means the build will not start. */
  readonly protected: readonly ProtectedScopeFile[];
}
/** A bounded, content-free account of an offline Writer rehearsal. */
export interface WriterRehearsalSummary {
  readonly mode: "offlineRehearsal";
  readonly delegateAttempts: number;
  readonly corrections: number;
  readonly changedPaths: readonly string[];
  readonly operations: number;
  readonly verification?: Readonly<{ passed: boolean; backendId?: string; acceptance?: string; platformRequirement?: string;
    dependencyCacheHit?: boolean; refusal?: string }>;
  readonly cleanup?: Readonly<{ candidates: number; released: number; complete: boolean }>;
}
/** Text that can steer a role: bounded, and free of terminal/bidi control characters. */
const DISALLOWED_TEXT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u;
export function validateTaskText(task: unknown): string {
  if (typeof task !== "string" || task.trim().length === 0)
    throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "The task text is empty." });
  if (task.length > RISK_TEXT_LIMITS.maxChars)
    throw new FusionFailure({ kind: "InvalidInput", retryable: false,
      safeMessage: `The task text exceeds ${RISK_TEXT_LIMITS.maxChars} characters; it is refused, not truncated.` });
  if (DISALLOWED_TEXT.test(task))
    throw new FusionFailure({ kind: "InvalidInput", retryable: false,
      safeMessage: "The task text contains control or direction-override characters." });
  return task;
}

/**
 * The workflow Fusion would run for this risk level; a description only, never an execution. v0.4: a Writer build's
 * reliability plan adds Fusion's checks on the unchanged baseline, a fresh falsification where its policy requires one, and
 * the evidence decision that gates any delivery.
 */
export function intendedWorkflow(level: string, writes: boolean, freshAtMedium: boolean, reliability?: ReliabilityPlan): string[] {
  const doer = writes ? "read-only Worker proposal, host-applied to a private candidate" : "read-only Explorer";
  const verify = writes ? "confined Fusion verification" : "Fusion verification";
  const reproduce = reliability?.reproduce === true ? ["Fusion's checks on the unchanged baseline"] : [];
  const fresh = reliability?.freshReview === true;
  const stage = reliability?.objective === "falsify" ? "fresh falsification" : "fresh Reviewer";
  const decision = reliability === undefined ? [] : ["evidence decision (proof obligations)"];
  switch (level) {
    case "low": return fresh ? [...reproduce, doer, verify, stage, "Lead adjudication", ...decision] : [...reproduce, doer, verify, ...decision];
    case "medium": return freshAtMedium || fresh ? ["Lead plan", ...reproduce, doer, verify, stage, "Lead adjudication", ...decision]
      : ["Lead plan", ...reproduce, doer, verify, "Lead review", ...decision];
    case "high": return ["Lead plan", ...reproduce, doer, verify, stage, "Lead adjudication",
      ...(writes ? ["at most one corrective attempt in a fresh candidate"] : []), ...decision];
    default: return ["Lead plan", "human gate before any autonomous work"];
  }
}

/**
 * `fusion build`: the full control-plane path up to the Writer gate. Task text is validated and risk-inspected, the
 * intended workflow is established, and a task that needs an autonomous Writer stops with REAL_WRITER_MODE_NOT_READY
 * (or at the human gate when critical). Nothing is written, and the primary workspace is never modified. Read-only
 * operations run the read-only workflow and keep the answered/completed distinction.
 */
/** The shared assessment of a build request: validated task text, repository, configuration, request, risk and flow. */
async function assessBuild(plane: ControlPlane, options: BuildOptions) {
  const text = validateTaskText(options.task);
  const runtime = await plane.runtime();
  const { root, git } = requireRepository(runtime);
  const loaded = await plane.config(runtime, options);
  const readOnly = READ_ONLY_OPERATIONS.has(options.operation);
  // Only the offline rehearsal seam supplies a Writer (and its confined plan); production has none.
  const rehearsal = readOnly ? undefined : plane.deps.writerRehearsal;
  // v0.1: a Writer build is assessed with the confined plan it will run (the same plan the production route verifies with),
  // so the plan the human confirms and the run carry the same risk; read-only work keeps the primary verification plan.
  const plan: VerificationPlan = rehearsal?.plan ?? (readOnly ? loaded.config.verification
    : { commands: [...(loaded.config.verification.confinedCommands ?? [])] });
  const paths = [...options.paths];
  const { task, packet } = buildRequest(options.operation, text, paths, readOnly, plan);
  // The same inspection the engine applies: the task itself and every steering packet field.
  const inspection = inspectTask(task);
  const delegated = scanRiskText(packetRiskText(packet), "delegation").signals
    .filter(signal => !inspection.risk.signals.some(known => known.code === signal.code));
  const risk: RiskAssessment = delegated.length > 0 ? escalateRisk(inspection.risk, delegated) : inspection.risk;
  const writes = inspection.writes;
  // v0.4: how much proof this change needs, from the host's own facts (task text, confirmed scope, path classes, risk).
  const reliability = writes ? reliabilityPlan(classifyTask({ text, paths, operation: options.operation, pathClasses: inspection.pathClasses, risk }), risk)
    : undefined;
  const flow = intendedWorkflow(risk.level, writes, reviewMode(risk.level, writes, risk.signals) === "fresh" && risk.level === "medium", reliability);
  // v0.2.1: files a Writer may never write (protected material, or files AI models never see) stop the build before any turn.
  const protectedFiles = writes ? await protectedScope(root, paths) : [];
  return { text, root, git, loaded, readOnly, rehearsal, plan, paths, task, packet, risk, writes, flow, protectedFiles, reliability };
}

/**
 * v0.1 — what a Writer build would do, for the human to confirm: task, risk, intended workflow, the configured bindings
 * per role and the confined verification plan. Read-only: no run is recorded and no provider is started.
 */
export async function planBuild(plane: ControlPlane, options: BuildOptions): Promise<BuildPlan> {
  const a = await assessBuild(plane, options);
  const verification = a.loaded.config.verification;
  return Object.freeze({ repository: a.root, task: a.text, risk: { level: a.risk.level, decisive: [...a.risk.decisive] }, writerRequired: a.writes,
    intendedWorkflow: a.flow, roles: a.loaded.config.bindings.map(binding => ({ role: binding.role, adapter: binding.adapter, model: binding.model,
      effort: binding.effort })), verification: { confinedCommands: (verification.confinedCommands ?? []).map(command => command.id),
      platformRequirement: String(verification.platformRequirement ?? "unknown"), dependencies: verification.dependencies ?? "none" },
    paths: [...a.paths], protected: a.protectedFiles });
}

/** Why a Writer build cannot be verified in confinement here (it is then refused before any model turn), or undefined. */
function verificationRefusal(composition: WriterComposition, declared: unknown): string | undefined {
  return composition.plan.commands.length === 0
    ? "No confined verification plan is configured: set verification.confinedCommands and verification.platformRequirement in fusion.config.json (see fusion doctor)."
    : declared !== "linux-compatible" && declared !== "platform-neutral"
    ? `Verification platform ${String(declared ?? "unknown")} has no confined backend in this release (supported: linux-compatible, platform-neutral).`
    : composition.verification.acceptance === "refused"
    ? `Confined verification is not available: ${composition.verification.reasons.join(", ") || "no acceptance"} (is Docker running? fusion doctor shows the verifier).`
    : undefined;
}

/**
 * v0.1 — asked before a build spends its FIRST model turn outside the run (the Lead's scope proposal): whether Fusion can
 * verify a Writer build here at all, from the same composition the build uses. No provider is started; a refusal is
 * returned as the build's own message. (The build checks again: this is an early answer, never a permission.)
 */
export async function verificationPreflight(plane: ControlPlane, options: BuildOptions): Promise<string | undefined> {
  const { root, loaded } = await assessBuild(plane, options);
  const compose = plane.deps.writerComposition ?? composeProductionWriter;
  const composition = await compose({ root, config: loaded.config, registry: plane.deps.registry, env: plane.deps.env,
    ...(options.signal ? { signal: options.signal } : {}) });
  return verificationRefusal(composition, loaded.config.verification.platformRequirement);
}

export async function build(plane: ControlPlane, options: BuildOptions): Promise<BuildReport> {
  const { text, root, git, loaded, rehearsal, plan, paths, task, packet, risk, writes, flow, protectedFiles, reliability } = await assessBuild(plane, options);
  const recorder = await RunRecorder.start(root, "build", plane.redactor, { task: text });
  await recorder.recordRisk(risk);
  const summary = { level: risk.level, decisive: risk.decisive };
  // v0.2.1: a scope that names protected material is a human decision, before any provider, candidate or container exists.
  if (writes && protectedFiles.length > 0) {
    const outcome: CommandOutcome = { state: "DECISION_REQUIRED", exitCode: EXIT_CODES.decisionRequired, code: "protectedMaterial",
      message: protectedScopeMessage(protectedFiles) };
    await recorder.finish(outcome, { risk, details: { writerRequired: true, protectedFiles: protectedFiles.length } });
    return { runId: recorder.runId, risk: summary, writerRequired: true, intendedWorkflow: flow, writer: writerReadiness(),
      outcome, reviews: [], unavailable: [] };
  }
  // The live Writer gate is asked BEFORE any production Writer component exists: while it refuses, no adapter, view,
  // candidate or container is created for a Writer task. Only the offline rehearsal seam (tests) gets past it.
  const gate = liveWriterAuthorization({ ...(options.authorization ? { authorization: options.authorization } : {}), task: text, paths,
    repositoryRoot: root });
  if (writes && (risk.level === "critical" || (rehearsal === undefined && !gate.authorized))) {
    const outcome: CommandOutcome = risk.level === "critical"
      ? { state: "HUMAN_GATE_REQUIRED", exitCode: EXIT_CODES.humanGateRequired, code: "humanGateRequired", pendingStage: "humanGate",
          message: "Not finished: this task is critical, so a human must approve before any autonomous work. Real Writer mode is also not ready." }
      : writerBlockedOutcome();
    await recorder.finish(outcome, { risk, details: { writerRequired: true, prerequisites: writerReadiness().prerequisites.map(p => p.id) } });
    return { runId: recorder.runId, risk: summary, writerRequired: true, intendedWorkflow: flow, writer: writerReadiness(),
      outcome, reviews: [], unavailable: [] };
  }
  if (writes && rehearsal !== undefined) {
    // OFFLINE REHEARSAL (test seam): the real workflow engine with host-controlled candidates, provider views and
    // confined verification.
    let result: WorkflowResult | undefined, outcome: CommandOutcome, evidence: BuildEvidence | undefined;
    try {
      const isolated = await ProcessGitClient.fromPath(plane.deps.env, true);
      const workspace = rehearsal.candidatePort({ primaryRoot: root, git: isolated,
        declaredPlatform: loaded.config.verification.platformRequirement });
      const baseCommit = (await isolated.run(["rev-parse", "--verify", "HEAD"], { cwd: root })).stdout.trim();
      result = await runWriterWorkflow(plane, recorder, { roles: rehearsal.roles, workspace, plan,
        views: providerViewPort(root, isolated, plane.deps.registry, workspace) }, git, { task, packet }, options, loaded, reliability);
      outcome = outcomeOf(result);
      // v0.4: the evidence decision is recorded and gates exactly as in production (a rehearsal is still never delivered).
      evidence = await recordBuildEvidence(recorder, root, loaded, text, paths, reliability!, plan, result, baseCommit);
      outcome = gatedOutcome(outcome, evidence);
    } catch (error) { outcome = failedOutcome(asFusionError(error)); }
    outcome = { ...outcome, message: `${outcome.message} (${OFFLINE_REHEARSAL_LABEL}.)` };
    const account = rehearsalSummary(result);
    await recorder.finish(outcome, { ...(result ? { result } : { risk }), details: { writerRequired: true, rehearsal: account,
      ...(evidence ? { evidence: evidenceDetails(evidence) } : {}) } });
    return { runId: recorder.runId, risk: result?.risk ? { level: result.risk.level, decisive: result.risk.decisive } : summary,
      writerRequired: true, intendedWorkflow: flow, writer: writerReadiness(), outcome, reviews: result?.reviews ?? [], unavailable: [],
      rehearsal: account, ...decisionOf(result), ...(evidence ? { evidence } : {}) };
  }
  if (writes) {
    // v0.1 PRODUCTION Writer route: a human confirmed exactly this build (run-scoped authorization, checked above). Read-only
    // provider sessions in Fusion-owned views, ChangeSets validated and host-applied into private candidates, confined
    // verification, the fresh review and adjudication — ending in a prepared delivery the human must approve and apply.
    let result: WorkflowResult | undefined, outcome: CommandOutcome, unavailable: readonly UnavailableBinding[] = [];
    let delivery: BuildDelivery | undefined, rehearsed = false, evidence: BuildEvidence | undefined;
    try {
      const compose = plane.deps.writerComposition ?? composeProductionWriter;
      const composition = await compose({ root, config: loaded.config, registry: plane.deps.registry, env: plane.deps.env,
        ...(options.signal ? { signal: options.signal } : {}) });
      unavailable = composition.unavailable;
      const declared = loaded.config.verification.platformRequirement;
      // Refused before any model turn: a build Fusion cannot verify in confinement is never started (and never delivered).
      const refusal = verificationRefusal(composition, declared);
      // A TEST composition over a fake backend: the run is real but an offline rehearsal, never deliverable.
      const offline = composition.verification.acceptance === "offlineRehearsal";
      rehearsed = offline && refusal === undefined;
      if (refusal !== undefined) outcome = verificationUnavailableOutcome(refusal);
      else {
        const isolated = await ProcessGitClient.fromPath(plane.deps.env, true);
        const baseCommit = (await isolated.run(["rev-parse", "--verify", "HEAD"], { cwd: root })).stdout.trim();
        const confined = writerRequest(options, text, paths, composition.plan);
        result = await runWriterWorkflow(plane, recorder, composition, git, confined, options, loaded, reliability);
        outcome = outcomeOf(result);
        // v0.4: Fusion's evidence decision, recorded in the run's evidence BEFORE any delivery exists (the manifest binds the
        // event log's digest, so an approval covers exactly this decision), and gating whether a delivery may be prepared.
        evidence = await recordBuildEvidence(recorder, root, loaded, text, paths, reliability!, composition.plan, result, baseCommit);
        outcome = gatedOutcome(outcome, evidence);
        if (offline) outcome = { ...outcome, message: `${outcome.message} (${OFFLINE_REHEARSAL_LABEL}; an offline rehearsal is never delivered.)` };
        else if (result.state === "completed" && evidence.decision.deliverable) {
          // v0.1: the verified, review-clean result becomes a prepared delivery — the exact validated bytes, never applied here.
          try { delivery = await prepareBuildDelivery(plane, { runId: recorder.runId, task: text, result, baseCommit,
            eventLogPath: recorder.events.path, ...(options.signal ? { signal: options.signal } : {}) }); }
          catch (error) {
            const e = asFusionError(error);
            outcome = { state: "FAILED", exitCode: presentFailure(e).exitCode, code: "deliveryNotPrepared", error: e,
              message: `The build completed, but no delivery was prepared: ${e.safeMessage}` };
          }
        }
      }
    } catch (error) { outcome = failedOutcome(asFusionError(error)); }
    const evidenceDetail = evidence ? { evidence: evidenceDetails(evidence) } : {};
    await recorder.finish(outcome, { ...(result ? { result } : { risk }),
      ...(delivery ? { details: { delivery: { id: delivery.deliveryId, manifestSha256: delivery.manifestSha256 }, ...evidenceDetail } }
        : rehearsed ? { details: { offlineRehearsal: true, ...evidenceDetail } } : evidence ? { details: evidenceDetail } : {}) });
    return { runId: recorder.runId, risk: result?.risk ? { level: result.risk.level, decisive: result.risk.decisive } : summary,
      writerRequired: true, intendedWorkflow: flow, writer: writerReadiness(), outcome, reviews: result?.reviews ?? [], unavailable,
      ...(result ? { summary: buildSummary(result) } : {}), ...(delivery ? { delivery } : {}), ...decisionOf(result), ...(evidence ? { evidence } : {}) };
  }
  const { candidates, unavailable } = await buildCandidates(loaded.config, plane.deps.registry, boundContext(plane, root),
    READ_ONLY_BUILD_ROLES);
  let result: WorkflowResult | undefined, outcome: CommandOutcome;
  try {
    const engine = new WorkflowEngine({ roles: candidates, workspace: readOnlyPort(root, git, loaded.config),
      views: providerViewPort(root, await ProcessGitClient.fromPath(plane.deps.env, true), plane.deps.registry),
      verifier: verifierFor(plane, git, recorder), events: recorder.sink() });
    result = await engine.run({ runId: recorder.runId, task, packet, verification: plan,
      timeoutMs: options.timeoutMs ?? loaded.config.limits.runTimeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
    outcome = outcomeOf(result);
  } catch (error) { outcome = failedOutcome(asFusionError(error)); }
  await recorder.finish(outcome, result ? { result } : { risk });
  return { runId: recorder.runId, risk: result?.risk ? { level: result.risk.level, decisive: result.risk.decisive } : summary,
    writerRequired: false, intendedWorkflow: flow, writer: writerReadiness(), outcome, reviews: result?.reviews ?? [], unavailable,
    ...decisionOf(result) };
}

/** The task and delegation packet of a `fusion build` request, for a given verification plan. */
function buildRequest(operation: TaskOperation, text: string, paths: readonly string[], readOnly: boolean, plan: VerificationPlan):
  Readonly<{ task: TaskRequest; packet: DelegationPacket }> {
  const task: TaskRequest = { operation, summary: text, paths: [...paths], scopeKnown: paths.length > 0,
    expectedMutation: readOnly ? "none" : paths.length === 0 ? "unknown" : paths.length === 1 ? "singleFile" : "multiFile",
    requestedCapabilities: readOnly ? {} : { write: true },
    verification: { required: !readOnly, planProvided: plan.commands.length > 0 } };
  const packet: DelegationPacket = { task: { goal: text, constraints: [], acceptanceCriteria: [] },
    scope: { relevantFiles: [...paths], allowedFiles: readOnly ? [] : [...paths], forbiddenFiles: [] },
    architecture: { decisions: [], invariants: [] }, verification: { requiredTests: plan.commands.map(command => command.id) },
    openQuestions: [] };
  return { task, packet };
}
function writerRequest(options: BuildOptions, text: string, paths: readonly string[], plan: VerificationPlan) {
  return buildRequest(options.operation, text, paths, false, plan);
}

/**
 * The one Writer execution path, shared by the offline rehearsal and the (gate-closed) production route: the real
 * engine over the host-controlled candidate port and the provider view port. The primary-workspace verifier is only
 * for read-only work; a Writer candidate never reaches it.
 */
async function runWriterWorkflow(plane: ControlPlane, recorder: RunRecorder, runtime: WriterRuntime, git: GitClient,
  request: Readonly<{ task: TaskRequest; packet: DelegationPacket }>, options: BuildOptions, loaded: LoadedConfig,
  reliability: ReliabilityPlan | undefined): Promise<WorkflowResult> {
  const engine = new WorkflowEngine({ roles: runtime.roles, workspace: runtime.workspace, views: runtime.views,
    verifier: verifierFor(plane, git, recorder), events: recorder.sink() });
  return engine.run({ runId: recorder.runId, task: request.task, packet: request.packet, verification: runtime.plan,
    timeoutMs: options.timeoutMs ?? loaded.config.limits.runTimeoutMs, ...(options.signal ? { signal: options.signal } : {}),
    ...(reliability?.reproduce === true ? { reproduce: true } : {}), ...(reliability?.freshReview === true ? { requireFreshReview: true } : {}),
    ...(reliability?.freshReview === true && reliability.objective === "falsify" ? { falsify: true } : {}) });
}

/**
 * v0.4: assembles the run's evidence (the engine's result, the protected paths the host checks now), records it — the
 * decision event and the redacted evidence artifact — and returns it. Recorded before any delivery is prepared.
 */
async function recordBuildEvidence(recorder: RunRecorder, root: string, loaded: LoadedConfig, task: string, paths: readonly string[],
  reliability: ReliabilityPlan, plan: VerificationPlan, result: WorkflowResult, baseCommit: string): Promise<BuildEvidence> {
  const changed = [...(result.changedPaths ?? [])];
  const forbidden = loaded.config.protection?.ignoredPaths ?? [];
  const protectedChanged = [...new Set([...changed.filter(path => deliveryPathViolation(path, forbidden) !== undefined),
    ...(await protectedScope(root, changed)).map(file => file.path)])].sort();
  // The obligations follow the run's final (monotonic) risk: an escalation during the run can only ask for more proof.
  const final = result.risk === undefined ? reliability : reliabilityPlan(reliability.profile, result.risk);
  const planned = { ...final, reproduce: reliability.reproduce, freshReview: reliability.freshReview || final.freshReview,
    objective: reliability.freshReview ? reliability.objective : final.objective };
  const evidence = assembleBuildEvidence({ task, scope: paths, plan: planned, plannedCommands: plan.commands.length, result, protectedChanged, baseCommit });
  await recorder.recordEvidence(evidence);
  return evidence;
}

/**
 * v0.4: a completed run whose evidence does not permit a delivery stops for the human's decision, with the obligations
 * Fusion could not establish. Every other outcome is kept.
 */
export function gatedOutcome(outcome: CommandOutcome, evidence: BuildEvidence): CommandOutcome {
  if (outcome.state !== "COMPLETED" || evidence.decision.deliverable) return outcome;
  const open = evidence.decision.obligations.filter(o => o.status !== "PASS").map(o => `${o.kind}: ${o.reason}`);
  return { state: "DECISION_REQUIRED", exitCode: EXIT_CODES.decisionRequired, code: "evidenceInsufficient",
    message: `The build ran, but Fusion's evidence does not permit a delivery (${evidence.decision.decision}): ${open.join("; ")}. ` +
      "Nothing was delivered or applied." };
}
/** The outcome record's bounded evidence summary (labels and statuses; the reasons live in the evidence artifact). */
function evidenceDetails(evidence: BuildEvidence): Readonly<Record<string, unknown>> {
  return { decision: evidence.decision.decision, deliverable: evidence.decision.deliverable, taskClass: evidence.plan.profile.taskClass,
    obligations: evidence.decision.obligations.map(o => `${o.kind}:${o.status}`) };
}

/** Adapters for an engine run with provider views: every session must run in its Fusion-owned view. */
function boundContext(plane: ControlPlane, root: string): ProviderRuntimeContext {
  return { ...plane.providerContext(root), sessionWorkspaces: "required" };
}
/** The read-only primary port, with the configured protected ignored paths monitored by content. */
function readOnlyPort(root: string, git: GitClient, config: LoadedConfig["config"]): ReadOnlyWorkspacePort {
  return new ReadOnlyWorkspacePort(root, git, config.protection ? { protectedPaths: config.protection.ignoredPaths } : {});
}

/** v0.1: a production build's verification and review, in counts and labels only. */
function buildSummary(result: WorkflowResult): BuildSummary {
  const evidence = result.verification?.evidence;
  const last = result.reviews.at(-1);
  return { verification: result.verification === undefined ? null : { passed: result.verification.passed, commands: result.verification.commandsRun,
      ...(evidence ? { backendId: evidence.backendId, acceptance: evidence.acceptance } : {}) },
    review: { cycles: result.reviews.length, findings: result.reviews.reduce((sum, cycle) => sum + cycle.findings.length, 0),
      outstanding: last === undefined || last.outcome === "clean" ? 0 : last.findings.length },
    delegateAttempts: result.delegateAttempts ?? 0, changedPaths: [...(result.changedPaths ?? [])].slice(0, 64) };
}

/** Counts, labels and repository-relative paths only: never ChangeSet content. */
function rehearsalSummary(result: WorkflowResult | undefined): WriterRehearsalSummary {
  const evidence = result?.verification?.evidence;
  return { mode: "offlineRehearsal", delegateAttempts: result?.delegateAttempts ?? 0,
    corrections: result?.reviews.filter(cycle => cycle.outcome === "correction").length ?? 0,
    changedPaths: [...(result?.changedPaths ?? [])].slice(0, 64), operations: result?.applied?.length ?? 0,
    ...(result?.verification === undefined ? {} : { verification: { passed: result.verification.passed,
      ...(evidence ? { backendId: evidence.backendId, acceptance: evidence.acceptance, platformRequirement: evidence.platformRequirement,
        ...(evidence.dependencies ? { dependencyCacheHit: evidence.dependencies.cacheHit } : {}) } : {}),
      ...(result.verification.refusal ? { refusal: result.verification.refusal } : {}) } }),
    ...(result?.cleanup === undefined ? {} : { cleanup: result.cleanup }) };
}

function verifierFor(plane: ControlPlane, git: GitClient, recorder: RunRecorder): EngineVerifierPort {
  return new EngineVerifierPort(plane.deps.verification ?? new VerificationEngine(),
    { git, env: plane.deps.env, events: recorder.events, artifacts: recorder.artifacts });
}

/** `fusion show <run-id>`: a bounded summary of persisted evidence. */
export async function show(plane: ControlPlane, runId: string): Promise<RunSummary> {
  const runtime = await plane.runtime();
  const { root } = requireRepository(runtime);
  if (!/^r-[0-9a-z]{10}-[0-9a-f]{32}$/u.test(runId))
    throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "That is not a Fusion run ID." });
  return summarizeRun(root, runId, plane.redactor);
}
