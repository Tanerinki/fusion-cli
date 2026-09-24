import type { DelegationPacket, FusionError, VerificationPlan } from "../core/domain.js";
import { FusionFailure, internalError } from "../core/errors.js";
import { escalateRisk, type RiskAssessment } from "../core/policy/risk.js";
import { RISK_TEXT_LIMITS, scanRiskText } from "../core/policy/risk-text.js";
import { inspectTask, type TaskOperation, type TaskRequest } from "../core/policy/task-inspector.js";
import { reviewMode } from "../core/review/policy.js";
import { WorkflowEngine } from "../core/workflow/engine.js";
import { packetRiskText } from "../core/workflow/packets.js";
import type { ReviewCycleRecord, WorkflowResult } from "../core/workflow/types.js";
import { EXIT_CODES } from "../cli/failure-presentation.js";
import { VerificationEngine } from "../platform/verification/engine.js";
import { EngineVerifierPort, ReadOnlyWorkspacePort } from "../platform/workflow/ports.js";
import { observeChange, resolveReviewBase } from "../platform/workspace/change.js";
import { ProcessGitClient, type GitClient } from "../platform/workspace/git.js";
import { READ_ONLY_BUILD_ROLES, REVIEW_ROLES, type CommandRequest, type ControlPlane } from "./control-plane.js";
import { requireRepository } from "./context.js";
import { failedOutcome, outcomeOf, writerBlockedOutcome, type CommandOutcome } from "./outcome.js";
import { buildCandidates, type UnavailableBinding } from "./providers.js";
import { RunRecorder, summarizeRun, type RunSummary } from "./runs.js";
import { writerReadiness, type WriterReadiness } from "./writer-gate.js";
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
  const { candidates, unavailable } = await buildCandidates(loaded.config, plane.deps.registry, plane.providerContext(root), REVIEW_ROLES);
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
    const engine = new WorkflowEngine({ roles: candidates, workspace: new ReadOnlyWorkspacePort(root, git),
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

/** The workflow Fusion would run for this risk level; a description only, never an execution. */
export function intendedWorkflow(level: string, writes: boolean, freshAtMedium: boolean): string[] {
  const doer = writes ? "read-only Worker proposal, host-applied to a private candidate" : "read-only Explorer";
  const verify = writes ? "confined Fusion verification" : "Fusion verification";
  switch (level) {
    case "low": return [doer, verify];
    case "medium": return freshAtMedium ? ["Lead plan", doer, verify, "fresh Reviewer", "Lead adjudication"]
      : ["Lead plan", doer, verify, "Lead review"];
    case "high": return ["Lead plan", doer, verify, "fresh Reviewer", "Lead adjudication",
      ...(writes ? ["at most one corrective attempt in a fresh candidate"] : [])];
    default: return ["Lead plan", "human gate before any autonomous work"];
  }
}

/**
 * `fusion build`: the full control-plane path up to the Writer gate. Task text is validated and risk-inspected, the
 * intended workflow is established, and a task that needs an autonomous Writer stops with REAL_WRITER_MODE_NOT_READY
 * (or at the human gate when critical). Nothing is written, and the primary workspace is never modified. Read-only
 * operations run the read-only workflow and keep the answered/completed distinction.
 */
export async function build(plane: ControlPlane, options: BuildOptions): Promise<BuildReport> {
  const text = validateTaskText(options.task);
  const runtime = await plane.runtime();
  const { root, git } = requireRepository(runtime);
  const loaded = await plane.config(runtime, options);
  const readOnly = READ_ONLY_OPERATIONS.has(options.operation);
  // Only the offline rehearsal seam supplies a Writer (and its confined plan); production has none.
  const rehearsal = readOnly ? undefined : plane.deps.writerRehearsal;
  const plan: VerificationPlan = rehearsal?.plan ?? loaded.config.verification;
  const paths = [...options.paths];
  const task: TaskRequest = { operation: options.operation, summary: text, paths, scopeKnown: paths.length > 0,
    expectedMutation: readOnly ? "none" : paths.length === 0 ? "unknown" : paths.length === 1 ? "singleFile" : "multiFile",
    requestedCapabilities: readOnly ? {} : { write: true },
    verification: { required: !readOnly, planProvided: plan.commands.length > 0 } };
  const packet: DelegationPacket = { task: { goal: text, constraints: [], acceptanceCriteria: [] },
    scope: { relevantFiles: paths, allowedFiles: readOnly ? [] : paths, forbiddenFiles: [] },
    architecture: { decisions: [], invariants: [] }, verification: { requiredTests: plan.commands.map(command => command.id) },
    openQuestions: [] };
  // The same inspection the engine applies: the task itself and every steering packet field.
  const inspection = inspectTask(task);
  const delegated = scanRiskText(packetRiskText(packet), "delegation").signals
    .filter(signal => !inspection.risk.signals.some(known => known.code === signal.code));
  const risk: RiskAssessment = delegated.length > 0 ? escalateRisk(inspection.risk, delegated) : inspection.risk;
  const writes = inspection.writes;
  const flow = intendedWorkflow(risk.level, writes, reviewMode(risk.level, writes, risk.signals) === "fresh" && risk.level === "medium");
  const recorder = await RunRecorder.start(root, "build", plane.redactor);
  await recorder.recordRisk(risk);
  const summary = { level: risk.level, decisive: risk.decisive };
  if (writes && (rehearsal === undefined || risk.level === "critical")) {
    const outcome: CommandOutcome = risk.level === "critical"
      ? { state: "HUMAN_GATE_REQUIRED", exitCode: EXIT_CODES.humanGateRequired, code: "humanGateRequired", pendingStage: "humanGate",
          message: "Not finished: this task is critical, so a human must approve before any autonomous work. Real Writer mode is also not ready." }
      : writerBlockedOutcome();
    await recorder.finish(outcome, { risk, details: { writerRequired: true, prerequisites: writerReadiness().prerequisites.map(p => p.id) } });
    return { runId: recorder.runId, risk: summary, writerRequired: true, intendedWorkflow: flow, writer: writerReadiness(),
      outcome, reviews: [], unavailable: [] };
  }
  if (writes && rehearsal !== undefined) {
    // OFFLINE REHEARSAL (test seam): the real workflow engine with host-controlled candidates and confined verification.
    let result: WorkflowResult | undefined, outcome: CommandOutcome;
    try {
      const isolated = await ProcessGitClient.fromPath(plane.deps.env, true);
      const workspace = rehearsal.candidatePort({ primaryRoot: root, git: isolated,
        declaredPlatform: loaded.config.verification.platformRequirement });
      const engine = new WorkflowEngine({ roles: rehearsal.roles, workspace, verifier: verifierFor(plane, git, recorder),
        events: recorder.sink() });
      result = await engine.run({ runId: recorder.runId, task, packet, verification: plan,
        timeoutMs: options.timeoutMs ?? loaded.config.limits.runTimeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
      outcome = outcomeOf(result);
    } catch (error) { outcome = failedOutcome(asFusionError(error)); }
    outcome = { ...outcome, message: `${outcome.message} (${OFFLINE_REHEARSAL_LABEL}.)` };
    const account = rehearsalSummary(result);
    await recorder.finish(outcome, { ...(result ? { result } : { risk }), details: { writerRequired: true, rehearsal: account } });
    return { runId: recorder.runId, risk: result?.risk ? { level: result.risk.level, decisive: result.risk.decisive } : summary,
      writerRequired: true, intendedWorkflow: flow, writer: writerReadiness(), outcome, reviews: result?.reviews ?? [], unavailable: [],
      rehearsal: account };
  }
  const { candidates, unavailable } = await buildCandidates(loaded.config, plane.deps.registry, plane.providerContext(root),
    READ_ONLY_BUILD_ROLES);
  let result: WorkflowResult | undefined, outcome: CommandOutcome;
  try {
    const engine = new WorkflowEngine({ roles: candidates, workspace: new ReadOnlyWorkspacePort(root, git),
      verifier: verifierFor(plane, git, recorder), events: recorder.sink() });
    result = await engine.run({ runId: recorder.runId, task, packet, verification: plan,
      timeoutMs: options.timeoutMs ?? loaded.config.limits.runTimeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
    outcome = outcomeOf(result);
  } catch (error) { outcome = failedOutcome(asFusionError(error)); }
  await recorder.finish(outcome, result ? { result } : { risk });
  return { runId: recorder.runId, risk: result?.risk ? { level: result.risk.level, decisive: result.risk.decisive } : summary,
    writerRequired: false, intendedWorkflow: flow, writer: writerReadiness(), outcome, reviews: result?.reviews ?? [], unavailable };
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
