import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { raceAbort } from "../cancellation.js";
import { canonicalChangePath, proposedPaths, validateChangeSet, writerChangeScope } from "../change/contract.js";
import type { AdjudicatedFinding, AgentRole, ChangeScope, ChangeSet, DelegationPacket, Finding, FusionError, FusionErrorKind,
  ResultPacket, Session, StructuredTurnRequest, VerificationPlan } from "../domain.js";
import { FusionFailure, failWith, internalError } from "../errors.js";
import { escalateRisk, riskRank, type RiskAssessment, type RiskLevel, type RiskSignal } from "../policy/risk.js";
import { scanRiskText } from "../policy/risk-text.js";
import { NO_EXTRA_CAPABILITIES, resolveRole, type ResolvedRole, type RoleNeeds, type TaskCapabilitySurface } from "../policy/routing.js";
import { inspectTask, scopeKey, unexpectedScopeSignals, verificationFailureSignal, verificationPlanReferences,
  verificationReferenceSignals } from "../policy/task-inspector.js";
import { adjudicate, evaluateFacts, REVIEW_LIMITS, validateAdjudicationReport, validateReviewReport,
  type ObservedState } from "../review/findings.js";
import { isOutstanding, REVIEW_CYCLE_LIMIT, reviewEvidence, reviewMode, reviewOutcome } from "../review/policy.js";
import { delegatePacket, packetRiskText, reviewPacket, validateDelegationPacket, validateStructuredTurnResult,
  validateTurnResult } from "./packets.js";
import { REVIEW_EVIDENCE_LIMITS } from "../review/policy.js";
import { PRIMARY_WORKSPACE, TERMINAL_STATES, VERIFICATION_REFUSALS, type AppliedOperation, type ApplicationOutcome,
  type CleanupReport, type PendingStage, type ProviderViewHandle, type ProviderViewRequest, type RepositoryReviewRequest,
  type ReviewCycleRecord, type TerminalState, type Transition, type TransitionReason, type TurnProvenance,
  type VerificationEvidenceSummary, type VerificationRefusal, type VerificationVerdict, type WorkflowConfig, type WorkflowEvent,
  type WorkflowRequest, type WorkflowResult, type WorkflowState, type WorkspaceHandle } from "./types.js";

export const WORKFLOW_LIMITS = Object.freeze({
  /** Targeted delegate retries after the first attempt, for flows with a Lead. Low-risk flows get none. */
  delegateRetries: 1,
  maxTimeoutMs: 24 * 60 * 60 * 1000,
  /** Bound on best-effort session cancel/close so cleanup can never hang a finished workflow. */
  cleanupWaitMs: 5_000,
  maxChangedPaths: 10_000,
  /** Bound on discarding one private candidate (the port first lets Fusion's own in-flight work on it settle). */
  candidateReleaseWaitMs: 120_000,
  /** Bound on removing one provider view. */
  viewReleaseWaitMs: 60_000,
});
const VIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const TERMINAL = new Set<WorkflowState>(TERMINAL_STATES);
/** Every non-terminal state may additionally end as failed, cancelled or decisionRequired. */
const NEXT: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  received: ["inspected"],
  inspected: ["routed"],
  routed: ["planning", "leased", "delegating", "verifying", "reviewing", "humanGateRequired"],
  planning: ["exploring", "leased", "delegating", "humanGateRequired"],
  exploring: ["leased", "humanGateRequired"],
  leased: ["delegating"],
  delegating: ["verifying", "retrying", "reviewing", "completed", "answered", "reviewRequired", "humanGateRequired"],
  // A read-only delegate retries directly; a Writer's retry starts in a fresh private candidate.
  retrying: ["leased", "delegating", "humanGateRequired"],
  verifying: ["retrying", "reviewing", "completed", "reviewRequired", "humanGateRequired"],
  reviewing: ["adjudicating", "completed", "answered", "humanGateRequired"],
  adjudicating: ["retrying", "completed", "answered", "humanGateRequired"],
  completed: [], answered: [], failed: [], cancelled: [], decisionRequired: [], reviewRequired: [], humanGateRequired: [],
};
const ALWAYS = new Set<WorkflowState>(["failed", "cancelled", "decisionRequired"]);
const FAILURE_REASON: Readonly<Record<FusionErrorKind, TransitionReason>> = {
  InvalidInput: "invalidRequest", CapabilityUnavailable: "policyFailure", BillingBlocked: "policyFailure",
  AuthMismatch: "policyFailure", ProviderIdentityMismatch: "providerFailure", SecurityViolation: "securityViolation",
  SpawnFailure: "providerFailure", Timeout: "timedOut", Cancelled: "providerFailure", ProcessFailure: "providerFailure",
  ProtocolError: "providerFailure", MalformedOutput: "malformedResult", VerificationFailure: "verificationFailed",
  WorkspaceConflict: "workspaceFailure", InternalError: "internalFailure",
};
/** A confined verification that could not start ends here; no role can turn these facts into anything else. */
const REFUSAL_OUTCOME: Readonly<Record<VerificationRefusal, readonly [TerminalState, TransitionReason]>> = {
  backendUnavailable: ["failed", "verifierUnavailable"],
  platformIncompatible: ["failed", "platformIncompatible"],
  dependencyApprovalRequired: ["humanGateRequired", "dependencyApprovalRequired"],
  dependencyLaneFailure: ["failed", "dependencyLaneFailure"],
  confinementNotAccepted: ["failed", "confinementNotAccepted"],
};
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/u;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A failure attributed to a specific workflow stage, so it is recorded with that stage's reason. */
class StageFailure extends FusionFailure {
  constructor(error: FusionError, readonly reason: TransitionReason) { super(error); }
}
/** Typed failures keep their kind; a stage `reason` re-attributes them, except security, cancellation and timeouts. */
function stageError(error: unknown, reason?: TransitionReason): FusionFailure {
  if (error instanceof StageFailure) return error;
  if (error instanceof FusionFailure) {
    const kind = error.error.kind;
    return reason === undefined || kind === "SecurityViolation" || kind === "Cancelled" || kind === "Timeout"
      ? error : new StageFailure(error.error, reason);
  }
  return new StageFailure(internalError("A workflow stage failed unexpectedly.", error), reason ?? "internalFailure");
}
const isFusionError = (value: unknown): value is FusionError => value !== null && typeof value === "object" &&
  Object.hasOwn(FAILURE_REASON, (value as FusionError).kind) && typeof (value as FusionError).safeMessage === "string" &&
  typeof (value as FusionError).retryable === "boolean";

/**
 * Writer candidates bound to a running workflow, process-wide. A candidate (by ID or by path) can back at most one
 * autonomous writer at a time, whatever the workspace port returns.
 */
const activeLeases = new Map<string, symbol>();
function leaseKeys(handle: WorkspaceHandle): string[] {
  const path = resolve(handle.path);
  return [`id:${handle.leaseId}`, `path:${process.platform === "win32" ? path.toLowerCase() : path}`];
}
function samePath(a: string, b: string): boolean {
  const x = resolve(a), y = resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}
/** True when `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function bounded(work: () => Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([Promise.resolve().then(work).catch(() => undefined),
      new Promise<void>(done => { timer = setTimeout(done, ms); timer.unref(); })]);
  } finally { if (timer) clearTimeout(timer); }
}
/** Like `bounded`, but keeps the result: `undefined` when the work failed or did not settle in time. */
async function settled<T>(work: () => Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([Promise.resolve().then(work).catch(() => undefined),
      new Promise<undefined>(done => { timer = setTimeout(() => done(undefined), ms); timer.unref(); })]);
  } finally { if (timer) clearTimeout(timer); }
}

const proceeds = (packet: ResultPacket): boolean => packet.result.status === "completed" && packet.needsLeadDecision.length === 0;
const approves = (packet: ResultPacket): boolean => proceeds(packet) && packet.failures.length === 0;

/**
 * The delegate result of a Writer attempt, written by Fusion from what it applied: no model self-report exists to
 * forward, so a Lead reviewing the attempt sees Fusion's observations only.
 */
function hostAppliedPacket(files: readonly string[], operations: number): ResultPacket {
  return { result: { status: "completed" }, changes: { files: [...files],
    summary: `Fusion host-applied ${operations} operation(s) to ${files.length} file(s) in a fresh private candidate.` },
  verification: { testsRun: [], results: [] }, uncertainties: [], failures: [], needsLeadDecision: [] };
}

/** Risk facts of a proposal Fusion refused: it reached outside its scope, or named no canonical repository file. */
function proposalRiskSignals(paths: readonly string[], scope: ChangeScope): RiskSignal[] {
  const canonical: string[] = [];
  let invalid = 0;
  for (const path of paths) {
    try { canonical.push(canonicalChangePath(path)); } catch { invalid++; }
  }
  const signals = unexpectedScopeSignals(scope.allowedPaths, canonical);
  if (invalid > 0) signals.push({ code: "proposalPathViolation", level: "critical", source: "diff",
    evidence: `${invalid} proposed path(s) are not canonical repository file paths` });
  return signals;
}

/** A port's verification evidence, reduced to bounded labels; anything else is refused as a malformed verdict. */
function evidenceSummary(value: unknown, plan: VerificationPlan): VerificationEvidenceSummary {
  const record = value as Partial<VerificationEvidenceSummary> | null;
  const label = (item: unknown): item is string => typeof item === "string" && LABEL.test(item);
  const deps = record?.dependencies;
  const planned = new Set(plan.commands.map(command => command.id));
  if (record === null || typeof record !== "object" || !label(record.backendId) || !label(record.confinement) ||
      !label(record.platformRequirement) || (record.acceptance !== "granted" && record.acceptance !== "offlineRehearsal") ||
      !Array.isArray(record.commands) || record.commands.length > plan.commands.length ||
      record.commands.some(entry => entry === null || typeof entry !== "object" || !planned.has(entry.id) || !label(entry.status) ||
        !(entry.exitCode === null || Number.isSafeInteger(entry.exitCode))) ||
      (deps !== undefined && (deps === null || typeof deps !== "object" || !label(deps.kind) || !label(deps.key) ||
        typeof deps.prepared !== "boolean" || typeof deps.cacheHit !== "boolean")))
    throw new StageFailure({ kind: "InternalError", retryable: false, safeMessage: "The candidate verifier returned invalid evidence." },
      "verifierFailure");
  return Object.freeze({ backendId: record.backendId, confinement: record.confinement, platformRequirement: record.platformRequirement,
    acceptance: record.acceptance, ...(deps === undefined ? {} : { dependencies: Object.freeze({ kind: deps.kind, key: deps.key,
      prepared: deps.prepared, cacheHit: deps.cacheHit }) }),
    commands: Object.freeze(record.commands.map(entry => Object.freeze({ id: entry.id, status: entry.status, exitCode: entry.exitCode }))) });
}

/**
 * Provider-neutral orchestration state machine. It connects task inspection, monotonic risk, capability-driven
 * routing, private Writer candidates and Fusion verification. Roles are resolved from configuration; nothing here
 * depends on which provider or model fills a role.
 *
 * The Writer is host-controlled: a read-only Change Author proposes a ChangeSet, Fusion validates it against the scope
 * it derived from the delegation packet, applies it into a fresh private candidate through the workspace port and
 * verifies that candidate in confinement. No provider ever holds a writable workspace, and no attempt inherits another
 * attempt's candidate.
 */
export class WorkflowEngine {
  constructor(private readonly config: WorkflowConfig) {}
  run(request: WorkflowRequest): Promise<WorkflowResult> { return new WorkflowRun(this.config, request).execute(); }
  /**
   * A fresh review and Lead adjudication of an existing change, with optional read-only verification of the primary
   * workspace. No delegate, no Writer, no correction: outstanding findings stop at a decision or the human gate.
   */
  review(request: RepositoryReviewRequest): Promise<WorkflowResult> {
    const { change, ...rest } = request;
    return new WorkflowRun(this.config, rest, change).execute();
  }
}

type Extras = Partial<{ role: AgentRole; attempt: number; pendingStage: PendingStage; error: FusionError }>;
/** What `conclude` decided: a terminal result, or confirmed findings for the single corrective attempt. */
type Conclusion = Readonly<{ result: WorkflowResult }> | Readonly<{ correction: readonly Finding[] }>;
type ReviewRoles = Readonly<{ reviewer: ResolvedRole; adjudicator: ResolvedRole }>;
/** A provider view this run opened, with the fingerprint Fusion took right after it was created. */
type BoundView = { readonly handle: ProviderViewHandle; identity: string; live: boolean };
/**
 * Which view a session reads. `source`: what the task starts from (the committed baseline for a Writer, the primary's
 * current work for a read-only flow). `change`: the change under review (the current candidate for a Writer).
 */
type ViewPurpose = "source" | "change";
/** One host-controlled Writer attempt up to (not including) verification. */
type WriterStep =
  | Readonly<{ kind: "applied"; packet: ResultPacket }>
  | Readonly<{ kind: "stale"; paths: readonly string[]; error: FusionError }>
  | Readonly<{ kind: "stop"; result: WorkflowResult }>;
type RetryContext = Parameters<typeof delegatePacket>[2];

class WorkflowRun {
  #state: WorkflowState = "received";
  readonly #transitions: Transition[] = [];
  readonly #token = Symbol("workflow");
  readonly #claimed: string[] = [];
  #risk?: RiskAssessment;
  #tier: RiskLevel = "low";
  #writes = false;
  /** The current (or last) private Writer candidate. */
  #lease?: WorkspaceHandle;
  /** The current candidate has not been released yet. */
  #live = false;
  #candidates = 0;
  #released = 0;
  #cleanupComplete = true;
  #changeSet: ChangeSet | undefined;
  #applied: readonly AppliedOperation[] | undefined;
  #plan?: ResultPacket;
  #result?: ResultPacket;
  #changed: readonly string[] | undefined;
  #verdict?: VerificationVerdict;
  #verifiedAttempt = 0;
  #verifiedState: string | undefined;
  #allowedScope: readonly string[] = [];
  #reviewRoles: ReviewRoles | undefined;
  readonly #reviews: ReviewCycleRecord[] = [];
  /**
   * Session IDs each adapter instance has issued in this run. IDs are opaque per adapter; one it hands out twice
   * means its state could carry over between turns.
   */
  readonly #sessionIds = new Map<object, Set<string>>();
  #attempts = 0;
  /** Provider views by purpose key (`baseline`, `workingTree`, `candidate:<leaseId>`). */
  readonly #views = new Map<string, BoundView>();
  readonly #viewIds = new Set<string>();
  #viewsCreated = 0;
  #viewsReleased = 0;
  #viewsComplete = true;
  /** Private roots of every candidate this run held: no view may lie inside or around one. */
  readonly #candidateRoots: string[] = [];
  /** The primary's fingerprint at the run's first observation; every later observation must equal it. */
  #primaryAnchor: string | undefined;
  #eventsBroken = false;
  #deadline: AbortSignal | undefined;
  #deadlineTimer: NodeJS.Timeout | undefined;
  #signal: AbortSignal | undefined;

  constructor(private readonly config: WorkflowConfig, private readonly request: WorkflowRequest,
    private readonly reviewChange?: RepositoryReviewRequest["change"]) {}

  async execute(): Promise<WorkflowResult> {
    try { return await (this.reviewChange === undefined ? this.flow() : this.reviewFlow(this.reviewChange)); }
    catch (error) { return await this.fail(error); }
    finally {
      if (this.#deadlineTimer) clearTimeout(this.#deadlineTimer);
      for (const key of this.#claimed) if (activeLeases.get(key) === this.#token) activeLeases.delete(key);
    }
  }

  private async flow(): Promise<WorkflowResult> {
    const request = this.request;
    const packet = this.validateRequest();
    const inspection = inspectTask(request.task);
    this.#risk = inspection.risk;
    const plan = request.verification, writes = inspection.writes;
    this.#writes = writes;
    if (request.task.verification.planProvided !== plan.commands.length > 0)
      failWith("InvalidInput", "The verification plan does not match the task's verification declaration.");
    if ((writes || request.task.verification.required) && plan.commands.length === 0)
      failWith("InvalidInput", "This task requires a Fusion verification plan.");
    if (plan.commands.some(command => command.mutationPolicy !== "readOnly"))
      failWith("InvalidInput", writes ? "A Writer candidate is verified read-only in confinement; the plan must not mutate it."
        : "Verification of the primary workspace must be read-only.");
    if (writes && unexpectedScopeSignals(inspection.paths, packet.scope.allowedFiles).length > 0)
      failWith("InvalidInput", "The delegated scope exceeds the inspected task scope.");
    // No provider of a Writer workflow ever runs in the primary checkout or in the candidate Fusion applies into.
    if (writes && this.config.views === undefined)
      failWith("InvalidInput", "A Writer workflow requires Fusion-owned provider views; no provider may run in the primary checkout.");
    // Fusion derives the exact file scope a ChangeSet is validated against before any role runs.
    const changeScope = writes ? writerChangeScope(packet) : undefined;
    // Everything that can steer a role is inspected before the flow is chosen: all delegated packet text (one
    // canonical, bounded scan) and task paths the verification plan itself runs or reads.
    const delegated = scanRiskText(packetRiskText(packet), "delegation").signals;
    const referenced = writes ? verificationReferenceSignals(inspection.paths, verificationPlanReferences(plan.commands)) : [];
    await this.move("inspected", "taskInspected");
    await this.emitRisk();
    const extra = this.freshSignals([...delegated, ...referenced]);
    if (extra.length > 0) await this.escalate(extra);
    this.#tier = this.#risk.level;

    // Policy eligibility: every role the flow needs is resolved before any turn runs or any candidate exists.
    const tier = this.#tier;
    const surface: TaskCapabilitySurface = { shell: request.task.requestedCapabilities.shell === true,
      network: request.task.requestedCapabilities.network === true };
    const needed: AgentRole[] = tier === "low" ? [] : ["Lead"];
    if (tier !== "critical") {
      if (writes && tier === "high" && request.explore === true) needed.push("Explorer");
      needed.push(writes ? "Worker" : "Explorer");
    }
    // The Worker is always a read-only Change Author: no role is ever routed with a writable posture. With provider views,
    // every role must bind its sessions to the view it is given.
    const bindViews = this.config.views !== undefined;
    const needs = (role: AgentRole): RoleNeeds => ({ ...(role === "Worker" ? { changeProposal: true } : {}),
      ...(bindViews ? { workspaceBinding: true } : {}) });
    const roles = new Map<AgentRole, ResolvedRole>();
    for (const role of needed) if (!roles.has(role))
      roles.set(role, await raceAbort(resolveRole(role, this.config.roles, surface, needs(role)), this.#signal, () => this.cancelled())
        .catch(error => { throw stageError(error, "policyFailure"); }));
    // A flow that will need a fresh Reviewer and an adjudicating Lead routes them now, before any work runs.
    if (tier !== "critical" && reviewMode(tier, writes, this.#risk.signals) === "fresh")
      await this.reviewRoles().catch(error => { throw stageError(error, "policyFailure"); });
    const bound = (role: AgentRole): ResolvedRole => roles.get(role) ?? failWith("InternalError", "A workflow role was not routed.");
    await this.move("routed", "bindingsResolved");

    let exploration: ResultPacket | undefined;
    if (tier !== "low") {
      await this.move("planning", "planRequested", { role: "Lead" });
      this.#plan = await this.readOnlyTurn(bound("Lead"), packet, undefined, "plan", 1);
      if (!proceeds(this.#plan)) return this.finish("decisionRequired", "decisionRequested", { role: "Lead" });
      if (tier === "critical")
        return this.finish("humanGateRequired", "humanGateRequiredForRisk", { pendingStage: "humanGate" });
      if (writes && tier === "high" && request.explore === true) {
        const explorerPacket = delegatePacket(packet, { plan: this.#plan });
        if (await this.outgoingIsCritical(explorerPacket))
          return this.finish("humanGateRequired", "humanGateRequiredForRisk", { pendingStage: "humanGate" });
        await this.move("exploring", "explorationRequested", { role: "Explorer" });
        exploration = await this.readOnlyTurn(bound("Explorer"), explorerPacket, undefined, "exploration", 1);
        if (!proceeds(exploration)) return this.finish("decisionRequired", "decisionRequested", { role: "Explorer" });
      }
    }

    const delegateRole: AgentRole = writes ? "Worker" : "Explorer";
    const delegate = bound(delegateRole);
    const contributions = { ...(this.#plan ? { plan: this.#plan } : {}), ...(exploration ? { exploration } : {}) };
    const firstPacket = delegatePacket(packet, contributions);
    // Forwarded Lead/Explorer text is scanned as sent; critical intent stops at the human gate before any candidate.
    if (await this.outgoingIsCritical(firstPacket))
      return this.finish("humanGateRequired", "humanGateRequiredForRisk", { pendingStage: "humanGate" });
    const forbidden = new Set(packet.scope.forbiddenFiles.map(scopeKey));
    this.#allowedScope = changeScope?.allowedPaths ?? packet.scope.allowedFiles.filter(path => !forbidden.has(scopeKey(path)));
    // One budget for all implementer attempts: an O3 retry and an O4 corrective attempt draw from the same two.
    const limit = tier === "low" ? 1 : 1 + WORKFLOW_LIMITS.delegateRetries;
    let retry: RetryContext;
    for (let attempt = 1; ; attempt++) {
      const turnPacket = attempt === 1 ? firstPacket : delegatePacket(packet, contributions, retry);
      if (attempt > 1 && await this.outgoingIsCritical(turnPacket))
        return this.finish("humanGateRequired", "humanGateRequiredForRisk", { pendingStage: "humanGate" });
      if (writes) {
        // One candidate at a time: the superseded candidate is discarded before a fresh one exists.
        if (!await this.releaseCandidate(false))
          throw new StageFailure({ kind: "WorkspaceConflict", retryable: false,
            safeMessage: "A superseded Writer candidate could not be removed completely." }, "cleanupIncomplete");
        await this.acquireCandidate(attempt);
        await this.move("leased", "leaseAcquired", { attempt });
      }
      await this.move("delegating", "delegated", { role: delegateRole, attempt });
      this.#attempts = attempt;
      if (writes) {
        const step = await this.writerAttempt(delegate, turnPacket, attempt, changeScope!);
        if (step.kind === "stop") return step.result;
        if (step.kind === "stale") {
          if (attempt < limit) {
            await this.move("retrying", "applicationRejected", { role: delegateRole, attempt });
            retry = { attempt: attempt + 1, limit, freshCandidate: true, reason: `the proposed file hashes did not match the ` +
              `committed baseline for ${step.paths.length} file(s): ${step.paths.slice(0, 8).join(", ")}.` };
            continue;
          }
          return this.finish("decisionRequired", limit > 1 ? "retryExhausted" : "applicationRejected",
            { role: delegateRole, attempt, error: step.error });
        }
        this.#result = step.packet;
      } else {
        const output = await this.readOnlyTurn(delegate, turnPacket, undefined, "delegate", attempt);
        this.#result = output;
        if (output.needsLeadDecision.length > 0 || output.result.status === "blocked")
          return this.finish("decisionRequired", "decisionRequested", { role: delegateRole, attempt });
        if (output.result.status !== "completed") {
          if (attempt < limit) {
            await this.move("retrying", "delegateUnsuccessful", { role: delegateRole, attempt });
            retry = { attempt: attempt + 1, limit, reason: `the previous attempt reported status ${output.result.status}.`, previous: output };
            continue;
          }
          return this.finish("decisionRequired", limit > 1 ? "retryExhausted" : "delegateUnsuccessful", { role: delegateRole, attempt });
        }
      }
      let scoped: string | undefined;
      if (writes) {
        // The candidate must hold exactly the host-applied ChangeSet: Fusion observes it rather than trusting the applier.
        const changed = await this.changedPaths();
        const applied = [...new Set(this.#applied!.map(op => op.path))].sort();
        if (JSON.stringify(changed) !== JSON.stringify(applied))
          failWith("SecurityViolation", "The candidate differs from the host-applied ChangeSet.");
        const scope = unexpectedScopeSignals(this.#allowedScope, changed);
        if (scope.length > 0) {
          await this.escalate(scope);
          return this.finish("decisionRequired", "unexpectedScope", { attempt });
        }
        scoped = await this.fingerprint(this.#lease, this.#signal);
      }
      if (plan.commands.length > 0) {
        await this.move("verifying", "verificationStarted", { attempt });
        // Verification runs untrusted content; the primary is proven unchanged around it. A Writer's candidate is only
        // ever verified through the workspace port's confined backend, never by the primary-workspace verifier.
        const verdict = writes ? await this.unchanged(undefined, () => this.verifyCandidate(plan))
          : await this.unchanged(undefined, () => this.verify(plan, this.config.workspace.primaryRoot));
        this.#verdict = verdict;
        if (writes) await this.emit({ type: "verification", attempt, passed: verdict.passed, commandsRun: verdict.commandsRun,
          ...(verdict.refusal === undefined ? {} : { refusal: verdict.refusal }),
          ...(verdict.evidence === undefined ? {} : { evidence: verdict.evidence }) }, false);
        if (verdict.refusal !== undefined) return this.refused(verdict.refusal, verdict.failure!, attempt);
        if (!verdict.passed) {
          const failedCommand = verdict.failedCommand ?? "unidentified";
          await this.escalate([verificationFailureSignal(failedCommand)]);
          const error: FusionError = verdict.failure ?? { kind: "VerificationFailure", retryable: false,
            safeMessage: "Fusion verification did not pass." };
          if (attempt < limit) {
            await this.move("retrying", "verificationFailed", { attempt });
            retry = { attempt: attempt + 1, limit, reason: `Fusion verification command ${failedCommand} did not pass.`,
              ...(writes ? { freshCandidate: true } : {}) };
            continue;
          }
          return limit > 1 ? this.finish("decisionRequired", "retryExhausted", { attempt, error })
            : this.finish("failed", "verificationFailed", { attempt, error });
        }
        if (writes) {
          // What was verified is what the scope check saw and what review will see.
          this.#verifiedState = await this.fingerprint(this.#lease, this.#signal);
          if (this.#verifiedState !== scoped) this.leaseChanged();
        }
        this.#verifiedAttempt = attempt;
      }
      const next = await this.conclude(bound, packet, plan, writes && attempt < limit);
      if ("result" in next) return next.result;
      // Confirmed, fixable findings: the single corrective attempt, in a fresh candidate, then verification and a fresh review.
      await this.move("retrying", "reviewFindingsConfirmed", { role: "Worker", attempt });
      retry = { attempt: attempt + 1, limit, freshCandidate: true,
        reason: `Fusion review confirmed ${next.correction.length} finding(s) to fix.`, findings: next.correction };
    }
  }

  /**
   * The host-controlled Writer delegate for one attempt, up to verification: a read-only Change Author proposes, Fusion
   * validates the ChangeSet against the scope it derived, and the workspace port applies it into the fresh candidate.
   * The model never mutates anything; a refused proposal changes nothing.
   */
  private async writerAttempt(role: ResolvedRole, packet: DelegationPacket, attempt: number, scope: ChangeScope): Promise<WriterStep> {
    const handle = this.#lease!;
    // The Change Author reads the committed baseline in its own view: never the candidate Fusion applies into.
    const view = await this.sessionView("source");
    const output = await this.readOnlyGuard(handle, () => this.proposalTurn(role, packet, handle, attempt, view), view);
    let changes: ChangeSet;
    try { changes = validateChangeSet(output, scope); }
    catch (error) {
      if (!(error instanceof FusionFailure) || (error.error.kind !== "MalformedOutput" && error.error.kind !== "SecurityViolation"))
        throw error;
      const malformed = error.error.kind === "MalformedOutput";
      const paths = proposedPaths(output);
      // A proposal reaching outside its scope is evidence of risk even though it is refused before any mutation.
      if (!malformed) {
        const signals = this.freshSignals(proposalRiskSignals(paths, scope));
        if (signals.length > 0) await this.escalate(signals);
      }
      await this.emit({ type: "proposal", attempt, outcome: malformed ? "malformed" : "rejected", operations: paths.length }, false);
      return { kind: "stop", result: await this.finish("failed", malformed ? "proposalMalformed" : "proposalRejected",
        { role: "Worker", attempt, error: error.error }) };
    }
    this.#changeSet = changes;
    await this.emit({ type: "proposal", attempt, outcome: "validated", operations: changes.operations.length }, false);
    const outcome = await this.unchanged(undefined, () => this.applyToCandidate(handle, changes, scope));
    if ("preconditionFailed" in outcome) {
      await this.emit({ type: "candidate", attempt, phase: "preconditionFailed", changedPaths: 0 }, false);
      return { kind: "stale", paths: outcome.preconditionFailed, error: { kind: "WorkspaceConflict", retryable: true,
        safeMessage: "The proposal's file hashes do not match the committed baseline; nothing was applied." } };
    }
    this.#applied = outcome.applied;
    const files = [...new Set(outcome.applied.map(op => op.path))].sort();
    await this.emit({ type: "candidate", attempt, phase: "applied", changedPaths: files.length }, false);
    return { kind: "applied", packet: hostAppliedPacket(files, outcome.applied.length) };
  }

  /**
   * A read-only structured change proposal in a fresh session for the candidate, run in the baseline view; its output
   * is untrusted data.
   */
  private proposalTurn(role: ResolvedRole, packet: DelegationPacket, handle: WorkspaceHandle, attempt: number,
    view: BoundView | undefined): Promise<unknown> {
    if (role.posture !== "readOnly") failWith("InternalError", "A Change Author runs only in a read-only posture.");
    return this.withSession(role, handle.leaseId, view, async session => {
      const invoke = role.adapter.runChangeProposalTurn;
      if (typeof invoke !== "function") failWith("CapabilityUnavailable", "The bound adapter cannot propose changes.");
      const raw = await this.call(role, session, () => invoke.call(role.adapter, session, { kind: "changeProposal", packet }, this.#signal));
      const turn = validateStructuredTurnResult(raw);
      if (turn.status !== "completed") {
        if (turn.effectiveProvider !== "" && turn.effectiveProvider !== role.binding.provider)
          failWith("ProviderIdentityMismatch", "The turn was served by a provider other than the bound one.");
        throw new StageFailure(turn.error, FAILURE_REASON[turn.error.kind]);
      }
      if (turn.effectiveProvider !== role.binding.provider)
        failWith("ProviderIdentityMismatch", "The turn was served by a provider other than the bound one.");
      await this.emit({ type: "structuredTurn", provenance: { cycle: attempt, kind: "changeProposal", role: role.role,
        sessionId: session.id, provider: role.binding.provider, transport: role.binding.transport,
        requestedModel: role.binding.model.id, observedModel: turn.effectiveModel } }, false);
      return turn.output;
    });
  }

  /** Host application through the port; its answer is checked against the validated ChangeSet before it is believed. */
  private async applyToCandidate(handle: WorkspaceHandle, changes: ChangeSet, scope: ChangeScope): Promise<ApplicationOutcome> {
    this.checkAborted();
    let outcome: ApplicationOutcome;
    try { outcome = await raceAbort(this.config.workspace.apply(handle, changes, scope, this.#signal), this.#signal, () => this.cancelled()); }
    catch (error) { throw stageError(error, "workspaceFailure"); }
    const paths = changes.operations.map(op => op.path);
    const invalid = (): never => { throw new StageFailure({ kind: "WorkspaceConflict", retryable: false,
      safeMessage: "The workspace port returned an invalid application result." }, "workspaceFailure"); };
    if (outcome === null || typeof outcome !== "object") return invalid();
    if ("preconditionFailed" in outcome) {
      const stale: unknown = outcome.preconditionFailed;
      if (!Array.isArray(stale) || stale.length === 0 || stale.some(path => typeof path !== "string" || !paths.includes(path))) invalid();
      return Object.freeze({ preconditionFailed: Object.freeze([...new Set(stale as string[])].sort()) });
    }
    const ledger: unknown = (outcome as { applied?: unknown }).applied;
    if (!Array.isArray(ledger)) return invalid();
    // The ledger must be exactly the validated ChangeSet, operation for operation, with the hashes Fusion expects.
    const exact = ledger.length === changes.operations.length && changes.operations.every((op, index) => {
      const entry = ledger[index] as Partial<AppliedOperation> | null;
      return entry !== null && typeof entry === "object" && entry.kind === op.kind && entry.path === op.path &&
        entry.beforeSha256 === op.expectedSha256 && (op.kind === "delete"
          ? entry.afterSha256 === null && entry.bytes === 0
          : entry.afterSha256 === sha256(op.content) && entry.bytes === Buffer.byteLength(op.content, "utf8"));
    });
    if (!exact) failWith("SecurityViolation", "The host application ledger differs from the validated ChangeSet.");
    return Object.freeze({ applied: Object.freeze(ledger.map(entry => Object.freeze({ ...(entry as AppliedOperation) }))) });
  }

  /** Repository review: inspect → route Reviewer and adjudicating Lead → optional read-only verification → fresh review. */
  private async reviewFlow(change: RepositoryReviewRequest["change"]): Promise<WorkflowResult> {
    const request = this.request;
    const packet = this.validateRequest();
    if (change === null || typeof change !== "object" || !Array.isArray(change.changedPaths) ||
        change.changedPaths.length > REVIEW_EVIDENCE_LIMITS.maxChangedPaths ||
        change.changedPaths.some(path => typeof path !== "string" || path.length === 0) ||
        typeof change.text !== "string" || typeof change.truncated !== "boolean")
      failWith("InvalidInput", "The change under review is malformed.");
    const inspection = inspectTask(request.task);
    this.#risk = inspection.risk;
    if (inspection.writes) failWith("InvalidInput", "A repository review must be a read-only task.");
    const plan = request.verification;
    if (request.task.verification.planProvided !== plan.commands.length > 0)
      failWith("InvalidInput", "The verification plan does not match the task's verification declaration.");
    if (request.task.verification.required && plan.commands.length === 0)
      failWith("InvalidInput", "This task requires a Fusion verification plan.");
    if (plan.commands.some(command => command.mutationPolicy !== "readOnly"))
      failWith("InvalidInput", "Verification of the primary workspace must be read-only.");
    const delegated = scanRiskText(packetRiskText(packet), "delegation").signals;
    // Everything under review is the review's scope, so a changed path is never "outside" it.
    this.#changed = Object.freeze([...new Set(change.changedPaths)].sort());
    this.#allowedScope = this.#changed;
    await this.move("inspected", "taskInspected");
    await this.emitRisk();
    const extra = this.freshSignals(delegated);
    if (extra.length > 0) await this.escalate(extra);
    this.#tier = this.#risk.level;
    await this.reviewRoles().catch(error => { throw stageError(error, "policyFailure"); });
    await this.move("routed", "bindingsResolved");
    // As in `conclude`, critical risk never ends answered or completed; here it stops before any provider turn.
    if (this.#tier === "critical")
      return this.finish("humanGateRequired", "humanGateRequiredForRisk", { pendingStage: "humanGate" });
    if (plan.commands.length > 0) {
      await this.move("verifying", "verificationStarted", { attempt: 1 });
      const verdict = await this.unchanged(undefined, () => this.verify(plan, this.config.workspace.primaryRoot));
      this.#verdict = verdict;
      if (!verdict.passed) {
        await this.escalate([verificationFailureSignal(verdict.failedCommand ?? "unidentified")]);
        return this.finish("failed", "verificationFailed", { attempt: 1, error: verdict.failure ??
          { kind: "VerificationFailure", retryable: false, safeMessage: "Fusion verification did not pass." } });
      }
      this.#verifiedAttempt = 1;
    }
    const next = await this.freshReview(packet, plan, false);
    if ("result" in next) return next.result;
    failWith("InternalError", "A repository review cannot request a correction.");
  }

  /**
   * The only path to `completed` and `answered`, gated on risk and the review the level requires: none (low), the
   * Lead (medium) or a fresh Reviewer plus Lead adjudication (high, and medium writers that touch their own
   * verification). `completed` requires a passing Fusion verification of the final attempt; a read-only task with
   * nothing to verify is only `answered`, whatever any review concluded.
   */
  private async conclude(bound: (role: AgentRole) => ResolvedRole, packet: DelegationPacket, plan: VerificationPlan,
    correctionAvailable: boolean): Promise<Conclusion> {
    await this.assertVerifiedState();
    const level = this.#risk!.level;
    if (level === "critical")
      return { result: await this.finish("humanGateRequired", "humanGateRequiredForRisk", { pendingStage: "humanGate" }) };
    const mode = reviewMode(level, this.#writes, this.#risk!.signals);
    if (mode === "fresh") return this.freshReview(packet, plan, correctionAvailable);
    if (riskRank(level) > riskRank(this.#tier)) return { result: await this.finish("decisionRequired", "riskExceedsFlow") };
    if (mode === "lead") {
      await this.move("reviewing", "reviewRequested", { role: "Lead" });
      const review = await this.readOnlyTurn(bound("Lead"),
        reviewPacket(packet, this.#result!, this.#changed ?? [], plan, plan.commands.length > 0), this.#lease, "leadReview",
        Math.max(1, this.#attempts));
      if (!approves(review)) return { result: await this.finish("decisionRequired", "leadRejected", { role: "Lead" }) };
      await this.assertVerifiedState();
    }
    return { result: await this.succeed(plan) };
  }

  /** Terminal success: `completed` only with a passing verification of the final attempt, else `answered` or nothing. */
  private async succeed(plan: VerificationPlan): Promise<WorkflowResult> {
    if (this.verifiedFinalAttempt(plan)) return this.finish("completed", "succeeded");
    if (!this.#writes && this.#lease === undefined && plan.commands.length === 0 && !this.request.task.verification.required)
      return this.finish("answered", "answeredWithoutVerification");
    failWith("InternalError", "Success requires a passing Fusion verification of the final attempt.");
  }
  private verifiedFinalAttempt(plan: VerificationPlan): boolean {
    // A repository review has no delegate attempts; its single verification is attempt 1.
    const final = this.reviewChange === undefined ? this.#verifiedAttempt === this.#attempts && this.#verifiedAttempt > 0
      : this.#verifiedAttempt === 1;
    return plan.commands.length > 0 && this.#verdict?.passed === true && this.#verdict.commandsRun === plan.commands.length && final;
  }

  /** Fresh Reviewer and adjudicating Lead: strict read-only surface, review isolation and structured turns, never the Worker. */
  private async reviewRoles(): Promise<ReviewRoles> {
    if (this.#reviewRoles) return this.#reviewRoles;
    const route = (role: AgentRole): Promise<ResolvedRole> => raceAbort(
      resolveRole(role, this.config.roles, NO_EXTRA_CAPABILITIES, { structuredTurns: true, reviewIsolation: true,
        ...(this.config.views !== undefined ? { workspaceBinding: true } : {}) }),
      this.#signal, () => this.cancelled());
    const reviewer = await route("Reviewer");
    const adjudicator = await route("Lead");
    this.#reviewRoles = Object.freeze({ reviewer, adjudicator });
    return this.#reviewRoles;
  }

  /**
   * One review cycle: a fresh Reviewer session reports structured findings on bounded evidence, the Lead adjudicates
   * exactly that finding set, Fusion's facts override contradicted verdicts, and a deterministic policy decides.
   * Every finding and verdict is recorded before any terminal state.
   */
  private async freshReview(packet: DelegationPacket, plan: VerificationPlan, correctionAvailable: boolean): Promise<Conclusion> {
    const cycle = this.#reviews.length + 1;
    if (cycle > REVIEW_CYCLE_LIMIT) failWith("InternalError", "The review cycle bound was exceeded.");
    let roles: ReviewRoles;
    try { roles = await this.reviewRoles(); }
    catch (error) {
      if (!(error instanceof FusionFailure) || error.error.kind !== "CapabilityUnavailable") throw error;
      return { result: await this.finish("reviewRequired", "reviewUnavailable",
        { pendingStage: "freshReviewAndAdjudication", error: error.error }) };
    }
    await this.emit({ type: "reviewCycle", phase: "started", cycle }, false);
    const evidence = await this.reviewEvidence(packet, plan);
    const previous = this.#reviews.at(-1);
    const priorFindings = previous ? previous.adjudications.filter(isOutstanding).map(entry => entry.finding) : [];
    await this.move("reviewing", "freshReviewRequested", { role: "Reviewer", attempt: cycle });
    await this.emit({ type: "review", phase: "started", cycle }, false);
    const reviewed = await this.structuredTurn(roles.reviewer, { kind: "review", cycle, evidence, priorFindings,
      limits: { maxFindings: REVIEW_LIMITS.maxFindings } });
    const findings = validateReviewReport(reviewed.output,
      { cycle, runId: this.request.runId, sessionId: reviewed.sessionId, role: "Reviewer" });
    for (const finding of findings) await this.emit({ type: "finding", cycle, finding }, false);
    await this.emit({ type: "review", phase: "completed", cycle, findingCount: findings.length }, false);
    let adjudications: readonly AdjudicatedFinding[] = [];
    if (findings.length > 0) {
      await this.move("adjudicating", "adjudicationRequested", { role: "Lead", attempt: cycle });
      const observed = this.observedState(plan);
      const facts = new Map(findings.map(finding => [finding.id, evaluateFacts(finding, observed)]));
      const judged = await this.structuredTurn(roles.adjudicator, { kind: "adjudication", cycle, evidence, findings,
        fusionFacts: findings.map(finding => ({ findingId: finding.id, ...facts.get(finding.id)! })) });
      adjudications = adjudicate(findings, validateAdjudicationReport(judged.output, findings),
        new Map([...facts].map(([id, evaluation]) => [id, evaluation.supported])));
      for (const record of adjudications) await this.emit({ type: "adjudication", cycle, record }, false);
    }
    const outcome = reviewOutcome(adjudications, correctionAvailable && cycle < REVIEW_CYCLE_LIMIT);
    this.#reviews.push(Object.freeze({ cycle, findings, adjudications, outcome: outcome.kind }));
    await this.emit({ type: "reviewCycle", phase: "completed", cycle, outcome: outcome.kind }, false);
    if (outcome.kind === "correction") return { correction: outcome.findings };
    if (outcome.kind === "gate") return { result: await this.finish(outcome.state, "unresolvedFindings",
      outcome.state === "humanGateRequired" ? { pendingStage: "humanGate" } : {}) };
    await this.assertVerifiedState();
    return { result: await this.succeed(plan) };
  }

  private observedState(plan: VerificationPlan): ObservedState {
    const passed = this.verifiedFinalAttempt(plan);
    // A Writer attempt reports no checks of its own (its delegate result is Fusion's), so it can claim none.
    return { verification: new Map(plan.commands.map(command => [command.id, passed])), changedPaths: this.#changed ?? [],
      allowedScope: this.#allowedScope, claimedTests: this.#writes ? [] : this.#result?.verification.testsRun ?? [] };
  }

  /** Evidence for the Reviewer and Lead: the caller's packet, Fusion's verification and the observed change only. */
  private async reviewEvidence(packet: DelegationPacket, plan: VerificationPlan) {
    const passed = this.verifiedFinalAttempt(plan);
    const verification = { required: plan.commands.length > 0 || this.request.task.verification.required, passed,
      commands: plan.commands.map(command => ({ id: command.id, passed })) };
    if (this.reviewChange !== undefined)
      return reviewEvidence(packet, verification, { kind: "diff", changedPaths: this.#changed ?? [],
        text: this.reviewChange.text, truncated: this.reviewChange.truncated });
    if (this.#lease === undefined)
      return reviewEvidence(packet, verification, { kind: "answer", changedPaths: [],
        text: this.#result?.changes.summary ?? "", truncated: false });
    this.checkAborted();
    let diff: Readonly<{ text: string; truncated: boolean }>;
    try { diff = await this.config.workspace.diff(this.#lease, this.#signal); }
    catch (error) { throw stageError(error, "workspaceFailure"); }
    if (diff === null || typeof diff !== "object" || typeof diff.text !== "string" || typeof diff.truncated !== "boolean")
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false, safeMessage: "The candidate diff could not be taken." },
        "workspaceFailure");
    return reviewEvidence(packet, verification, { kind: "diff", changedPaths: this.#changed ?? [], text: diff.text,
      truncated: diff.truncated });
  }

  /** The verified candidate must be exactly what is handed on; any later change voids the verification. */
  private async assertVerifiedState(): Promise<void> {
    if (this.#lease === undefined || this.#verifiedState === undefined) return;
    if (await this.fingerprint(this.#lease, this.#signal) !== this.#verifiedState) this.leaseChanged();
  }
  private leaseChanged(): never {
    failWith("SecurityViolation", "The Writer candidate changed after host application; its verification is void.");
  }

  /** Signals not already present at the same or a higher level, so repeated scans do not create empty revisions. */
  private freshSignals(signals: readonly RiskSignal[]): RiskSignal[] {
    const known = this.#risk!.signals;
    return signals.filter(s => !known.some(k => k.code === s.code && riskRank(k.level) >= riskRank(s.level)));
  }

  /** Scans a packet exactly as it will be sent; returns true when the (monotonic) risk is now critical. */
  private async outgoingIsCritical(outgoing: DelegationPacket): Promise<boolean> {
    const fresh = this.freshSignals(scanRiskText(packetRiskText(outgoing), "delegation").signals);
    if (fresh.length > 0) await this.escalate(fresh);
    return this.#risk!.level === "critical";
  }

  private validateRequest(): DelegationPacket {
    const request: unknown = this.request;
    if (request === null || typeof request !== "object") failWith("InvalidInput", "The workflow request is malformed.");
    const { runId, verification, explore, timeoutMs, signal } = this.request;
    if (typeof runId !== "string" || !RUN_ID.test(runId)) failWith("InvalidInput", "The workflow run ID is invalid.");
    if (verification === null || typeof verification !== "object" || !Array.isArray(verification.commands) ||
        verification.commands.length > 64 || verification.commands.some(command => command === null ||
          typeof command !== "object" || typeof command.id !== "string" || typeof command.cwd !== "string" ||
          !Array.isArray(command.args) || (command.args as unknown[]).some(arg => typeof arg !== "string") ||
          (command.mutationPolicy !== "readOnly" && command.mutationPolicy !== "allowMutation")))
      failWith("InvalidInput", "The verification plan is malformed.");
    if (explore !== undefined && typeof explore !== "boolean") failWith("InvalidInput", "The exploration option is invalid.");
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WORKFLOW_LIMITS.maxTimeoutMs))
      failWith("InvalidInput", "The workflow timeout is out of range.");
    if (signal !== undefined && !(signal instanceof AbortSignal)) failWith("InvalidInput", "The cancellation signal is invalid.");
    const packet = validateDelegationPacket(this.request.packet);
    if (timeoutMs !== undefined) {
      // A referenced timer: the deadline must fire even when the awaited work holds no handles of its own.
      const deadline = new AbortController();
      this.#deadlineTimer = setTimeout(() => deadline.abort(), timeoutMs);
      this.#deadline = deadline.signal;
    }
    const signals = [signal, this.#deadline].filter((item): item is AbortSignal => item !== undefined);
    this.#signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    this.checkAborted();
    return packet;
  }

  private checkAborted(): void {
    if (this.#signal?.aborted) failWith("Cancelled", "The workflow was cancelled.");
  }
  private cancelled(): FusionFailure {
    return new FusionFailure({ kind: "Cancelled", safeMessage: "The workflow was cancelled.", retryable: false });
  }

  /**
   * A fresh private candidate for this attempt. The port's handle is refused unless it lies strictly inside the port's
   * candidate root, is neither the primary nor inside or around it, belongs to this run's Writer, and is bound to no
   * other active writer in this process. A refused handle is never reported as this run's candidate.
   */
  private async acquireCandidate(attempt: number): Promise<void> {
    this.checkAborted();
    const ownerId = `${this.request.runId}.worker`;
    let handle: WorkspaceHandle;
    try { handle = await this.config.workspace.acquire(ownerId, this.#signal); }
    catch (error) { throw stageError(error, "workspaceFailure"); }
    const { primaryRoot: primary, leaseRoot } = this.config.workspace;
    if (handle === null || typeof handle !== "object" || typeof handle.leaseId !== "string" || handle.leaseId.length === 0 ||
        handle.leaseId.length > 128 || typeof handle.path !== "string" || !isAbsolute(handle.path))
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false,
        safeMessage: "The workspace port returned an invalid candidate." }, "workspaceFailure");
    if (handle.leaseId === PRIMARY_WORKSPACE || typeof primary !== "string" || !isAbsolute(primary) ||
        typeof leaseRoot !== "string" || !isAbsolute(leaseRoot) || !within(leaseRoot, handle.path) ||
        samePath(leaseRoot, handle.path) || within(primary, handle.path) || within(handle.path, primary))
      failWith("SecurityViolation", "The primary workspace can never be assigned to an autonomous writer.");
    if (handle.ownerId !== ownerId)
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false,
        safeMessage: "The Writer candidate is owned by another writer." }, "workspaceFailure");
    const keys = leaseKeys(handle);
    if (keys.some(key => activeLeases.has(key)))
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false,
        safeMessage: "The Writer candidate is already bound to another active writer." }, "workspaceFailure");
    // A candidate and a provider view never overlap: no provider may run in, or around, what Fusion applies into.
    const privateRoot = dirname(resolve(handle.path));
    if ([...this.#views.values()].some(view => within(privateRoot, view.handle.path) || within(view.handle.path, privateRoot)))
      failWith("SecurityViolation", "A Writer candidate overlaps a provider view.");
    this.#candidateRoots.push(privateRoot);
    for (const key of keys) { activeLeases.set(key, this.#token); this.#claimed.push(key); }
    this.#lease = Object.freeze({ leaseId: handle.leaseId, ownerId: handle.ownerId, path: handle.path });
    this.#live = true;
    this.#candidates++;
    this.#applied = undefined;
    this.#changeSet = undefined;
    this.#changed = undefined;
    this.#verifiedState = undefined;
    await this.emit({ type: "candidate", attempt, phase: "created" }, false);
  }

  /**
   * Discards the live candidate, within a bound. An unproven removal keeps the candidate's claim for this run and is
   * reported (`false`); callers decide whether that fails the run. Only a failure to record the release throws, and
   * only when `bestEffortEvent` is false.
   */
  private async releaseCandidate(bestEffortEvent: boolean): Promise<boolean> {
    const handle = this.#lease;
    if (handle === undefined || !this.#live) return true;
    // The candidate's review view goes first; its completeness is tracked with every other view.
    await this.releaseView(`candidate:${handle.leaseId}`, bestEffortEvent);
    this.#live = false;
    const report = await settled<CleanupReport>(() => this.config.workspace.release(handle), WORKFLOW_LIMITS.candidateReleaseWaitMs);
    const complete = report !== null && typeof report === "object" && report.complete === true;
    if (complete) {
      this.#released++;
      for (const key of leaseKeys(handle)) if (activeLeases.get(key) === this.#token) activeLeases.delete(key);
    }
    this.#cleanupComplete &&= complete;
    await this.emit({ type: "candidate", attempt: Math.max(1, this.#attempts), phase: "released", complete }, bestEffortEvent);
    return complete;
  }

  /**
   * The provider view a session of the given purpose runs in, or undefined without a view port. A Writer's sources
   * are the committed baseline and its change is a copy of the current candidate; a read-only flow's view is the
   * primary's current work. A view is opened once per purpose and reused while live.
   */
  private async sessionView(purpose: ViewPurpose): Promise<BoundView | undefined> {
    if (this.config.views === undefined) return undefined;
    if (!this.#writes) return this.openView("workingTree", { kind: "workingTree" });
    if (purpose === "source") return this.openView("baseline", { kind: "baseline" });
    const lease = this.#lease;
    if (lease === undefined || !this.#live) failWith("InternalError", "A change view requires the live Writer candidate.");
    return this.openView(`candidate:${lease.leaseId}`, { kind: "candidate", candidate: lease });
  }

  /**
   * Opens a view through the port and refuses it unless it lies strictly inside the port's view root, is neither the
   * primary nor inside or around it, overlaps no Writer candidate of this run and is not a reused view. Its identity is
   * the fingerprint Fusion takes right after creation.
   */
  private async openView(key: string, request: ProviderViewRequest): Promise<BoundView> {
    const existing = this.#views.get(key);
    if (existing !== undefined && existing.live) return existing;
    this.checkAborted();
    const port = this.config.views!;
    let handle: ProviderViewHandle;
    try { handle = await port.open(`${this.request.runId}.views`, request, this.#signal); }
    catch (error) { throw stageError(error, "workspaceFailure"); }
    if (handle === null || typeof handle !== "object" || typeof handle.viewId !== "string" || !VIEW_ID.test(handle.viewId) ||
        handle.kind !== request.kind || typeof handle.path !== "string" || !isAbsolute(handle.path))
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false, safeMessage: "The view port returned an invalid provider view." },
        "workspaceFailure");
    const primary = this.config.workspace.primaryRoot, root = port.viewRoot;
    if (typeof root !== "string" || !isAbsolute(root) || !within(root, handle.path) || samePath(root, handle.path) ||
        typeof primary !== "string" || !isAbsolute(primary) || within(primary, handle.path) || within(handle.path, primary) ||
        this.#candidateRoots.some(candidate => within(candidate, handle.path) || within(handle.path, candidate)) ||
        this.#viewIds.has(handle.viewId))
      failWith("SecurityViolation", "A provider view must be Fusion-owned: never the primary workspace, a Writer candidate or a reused view.");
    this.#viewIds.add(handle.viewId);
    const view: BoundView = { handle: Object.freeze({ viewId: handle.viewId, kind: handle.kind, path: handle.path }), identity: "", live: true };
    this.#views.set(key, view);
    this.#viewsCreated++;
    view.identity = await this.viewFingerprint(view.handle, this.#signal);
    await this.emit({ type: "providerView", kind: view.handle.kind, phase: "created" }, false);
    return view;
  }

  private async viewFingerprint(handle: ProviderViewHandle, signal: AbortSignal | undefined): Promise<string> {
    let value: string;
    try { value = await this.config.views!.fingerprint(handle, signal); }
    catch (error) { throw stageError(error, "workspaceFailure"); }
    if (typeof value !== "string" || value.length === 0)
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false, safeMessage: "A provider view fingerprint could not be taken." },
        "workspaceFailure");
    return value;
  }

  /**
   * Runs a provider turn in `view` and proves the view is exactly as created, before and after (even when the turn
   * failed or was cancelled). A change is a security failure that raises risk to critical: no role can outweigh it.
   */
  private async viewUnchanged<T>(view: BoundView, work: () => Promise<T>): Promise<T> {
    if (await this.viewFingerprint(view.handle, this.#signal) !== view.identity) await this.viewChanged();
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try { outcome = { ok: true, value: await work() }; } catch (error) { outcome = { ok: false, error }; }
    if (await this.viewFingerprint(view.handle, undefined) !== view.identity) await this.viewChanged();
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  private async viewChanged(): Promise<never> {
    await this.escalate([{ code: "providerWorkspaceChanged", level: "critical", source: "diff",
      evidence: "A Fusion-owned provider view was modified during or around a provider turn." }]).catch(() => undefined);
    failWith("SecurityViolation", "A provider changed its Fusion-owned workspace; the turn and everything after it are void.");
  }

  /** Removes one view within a bound; an unproven removal is recorded and reported (`false`). */
  private async releaseView(key: string, bestEffortEvent: boolean): Promise<boolean> {
    const view = this.#views.get(key);
    if (view === undefined || !view.live) return true;
    view.live = false;
    const report = await settled<CleanupReport>(() => this.config.views!.release(view.handle), WORKFLOW_LIMITS.viewReleaseWaitMs);
    const complete = report !== null && typeof report === "object" && report.complete === true;
    if (complete) this.#viewsReleased++;
    this.#viewsComplete &&= complete;
    await this.emit({ type: "providerView", kind: view.handle.kind, phase: "released", complete }, bestEffortEvent);
    return complete;
  }
  private async releaseViews(bestEffortEvent: boolean): Promise<boolean> {
    let complete = true;
    for (const key of [...this.#views.keys()]) complete = await this.releaseView(key, bestEffortEvent) && complete;
    return complete;
  }

  private async changedPaths(): Promise<readonly string[]> {
    this.checkAborted();
    let changed: readonly string[];
    try { changed = await this.config.workspace.changedPaths(this.#lease!, this.#signal); }
    catch (error) { throw stageError(error, "workspaceFailure"); }
    if (!Array.isArray(changed) || changed.length > WORKFLOW_LIMITS.maxChangedPaths ||
        changed.some(path => typeof path !== "string" || path.length === 0))
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false,
        safeMessage: "The candidate's changed paths could not be determined." }, "workspaceFailure");
    this.#changed = Object.freeze([...new Set(changed)].sort());
    return this.#changed;
  }

  private async fingerprint(handle: WorkspaceHandle | undefined, signal: AbortSignal | undefined): Promise<string> {
    let value: string;
    try { value = await this.config.workspace.fingerprint(handle, signal); }
    catch (error) { throw stageError(error, "workspaceFailure"); }
    if (typeof value !== "string" || value.length === 0)
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false,
        safeMessage: "A workspace fingerprint could not be taken." }, "workspaceFailure");
    return value;
  }

  /**
   * Runs `work` (an agent turn, a host application or a verification) and then proves `handle` (the primary when
   * undefined) is unchanged. The after-check runs even when the work failed or was cancelled; a change is a security
   * failure and raises risk to critical.
   */
  /**
   * Runs `work` (an agent turn, a host application or a verification) and then proves `handle` (the primary when
   * undefined) is unchanged. The after-check runs even when the work failed or was cancelled; a change is a security
   * failure and raises risk to critical. The primary is held to the fingerprint of the run's FIRST observation, so a
   * change between two units of work (by a process that outlived a turn, say) is caught at the next check too.
   */
  private async unchanged<T>(handle: WorkspaceHandle | undefined, work: () => Promise<T>): Promise<T> {
    this.checkAborted();
    const before = await this.fingerprint(handle, this.#signal);
    if (handle === undefined) {
      this.#primaryAnchor ??= before;
      if (before !== this.#primaryAnchor) await this.workspaceChanged(handle);
    }
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try { outcome = { ok: true, value: await work() }; } catch (error) { outcome = { ok: false, error }; }
    const after = await this.fingerprint(handle, undefined);
    if (after !== (handle === undefined ? this.#primaryAnchor : before)) await this.workspaceChanged(handle);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  private async workspaceChanged(handle: WorkspaceHandle | undefined): Promise<never> {
    const code = handle === undefined ? "primaryWorkspaceChanged" : "readOnlyWorkspaceChanged";
    // The violation is reported even if its risk event cannot be recorded.
    await this.escalate([{ code, level: "critical", source: "diff",
      evidence: "A workspace that must stay unchanged during an agent turn or verification was modified." }]).catch(() => undefined);
    failWith("SecurityViolation", handle === undefined
      ? "The primary workspace changed while an agent turn or verification was running."
      : "A read-only turn changed its workspace.");
  }

  /**
   * A read-only turn proves the primary unchanged, and the candidate when there is one, and the provider view it ran in
   * (innermost, so a view change is reported as such).
   */
  private readOnlyGuard<T>(handle: WorkspaceHandle | undefined, work: () => Promise<T>, view?: BoundView): Promise<T> {
    const guarded = view === undefined ? work : () => this.viewUnchanged(view, work);
    return handle === undefined ? this.unchanged(undefined, guarded) : this.unchanged(undefined, () => this.unchanged(handle, guarded));
  }

  private async readOnlyTurn(role: ResolvedRole, packet: DelegationPacket, handle: WorkspaceHandle | undefined,
    kind: TurnProvenance["kind"], attempt: number): Promise<ResultPacket> {
    if (role.posture !== "readOnly") failWith("InternalError", "A writer role cannot run a read-only turn.");
    const view = await this.sessionView(kind === "leadReview" ? "change" : "source");
    return this.readOnlyGuard(handle, () => this.turn(role, packet, handle?.leaseId ?? PRIMARY_WORKSPACE, kind, attempt, view), view);
  }

  /** A structured review or adjudication turn: read-only, in a fresh session, in the view of the change under review. */
  private async structuredTurn(role: ResolvedRole, request: StructuredTurnRequest): Promise<{ output: unknown; sessionId: string }> {
    if (role.posture !== "readOnly") failWith("InternalError", "Review and adjudication run only in read-only roles.");
    const handle = this.#lease;
    const view = await this.sessionView("change");
    return this.readOnlyGuard(handle, () => this.withSession(role, handle?.leaseId ?? PRIMARY_WORKSPACE, view, async session => {
      const invoke = role.adapter.runStructuredTurn;
      if (typeof invoke !== "function") failWith("CapabilityUnavailable", "The bound adapter cannot run structured turns.");
      const raw = await this.call(role, session, () => invoke.call(role.adapter, session, request, this.#signal));
      const turn = validateStructuredTurnResult(raw);
      if (turn.status !== "completed") {
        // A failed turn may not have observed any identity; a reported one must still be the bound provider.
        if (turn.effectiveProvider !== "" && turn.effectiveProvider !== role.binding.provider)
          failWith("ProviderIdentityMismatch", "The turn was served by a provider other than the bound one.");
        throw new StageFailure(turn.error, FAILURE_REASON[turn.error.kind]);
      }
      if (turn.effectiveProvider !== role.binding.provider)
        failWith("ProviderIdentityMismatch", "The turn was served by a provider other than the bound one.");
      // Provenance is persisted before the output is used.
      await this.emit({ type: "structuredTurn", provenance: { cycle: request.cycle, kind: request.kind, role: role.role,
        sessionId: session.id, provider: role.binding.provider, transport: role.binding.transport,
        requestedModel: role.binding.model.id, observedModel: turn.effectiveModel } }, false);
      return { output: turn.output, sessionId: session.id };
    }), view);
  }

  private turn(role: ResolvedRole, packet: DelegationPacket, workspaceLeaseId: string, kind: TurnProvenance["kind"],
    attempt: number, view: BoundView | undefined): Promise<ResultPacket> {
    return this.withSession(role, workspaceLeaseId, view, async session => {
      const raw = await this.call(role, session, () => role.adapter.runTurn(session, packet, this.#signal));
      const turn = validateTurnResult(raw);
      if (turn.effectiveProvider !== role.binding.provider)
        failWith("ProviderIdentityMismatch", "The turn was served by a provider other than the bound one.");
      if (turn.status !== "completed") throw new StageFailure(turn.error, FAILURE_REASON[turn.error.kind]);
      await this.emit({ type: "turn", provenance: { kind, attempt, role: role.role, sessionId: session.id,
        provider: role.binding.provider, transport: role.binding.transport, requestedModel: role.binding.model.id,
        observedModel: turn.effectiveModel } }, false);
      return turn.output;
    });
  }

  /**
   * Opens a fresh session, checks it echoes the requested role, posture, run, workspace and provider, refuses any
   * session ID this run has already seen, and always closes it within a bound.
   */
  /**
   * Opens a fresh session — bound to `view` when there is one, which the adapter must echo — checks it echoes the
   * requested role, posture, run, workspace and provider, refuses any session ID this run has already seen, and always
   * closes it within a bound.
   */
  private async withSession<T>(role: ResolvedRole, workspaceLeaseId: string, view: BoundView | undefined,
    work: (session: Session) => Promise<T>): Promise<T> {
    this.checkAborted();
    const { adapter, binding } = role;
    const request = { runId: this.request.runId, role: role.role, workspaceLeaseId, posture: role.posture, model: binding.model,
      ...(view === undefined ? {} : { workspace: Object.freeze({ id: view.handle.viewId, root: view.handle.path }) }) };
    let session: Session;
    try { session = await raceAbort(adapter.createSession(request), this.#signal, () => this.cancelled()); }
    catch (error) { throw stageError(error); }
    try {
      if (session === null || typeof session !== "object" || session.role !== role.role || session.posture !== role.posture ||
          session.workspaceLeaseId !== workspaceLeaseId || session.runId !== this.request.runId ||
          session.provider !== binding.provider || typeof session.id !== "string" ||
          (view !== undefined && session.workspaceRoot !== view.handle.path))
        failWith("SecurityViolation", "The provider session does not match the requested role, posture or workspace.");
      const issued = this.#sessionIds.get(adapter) ?? new Set<string>();
      if (issued.has(session.id))
        failWith("SecurityViolation", "A provider session was reused; every turn requires a fresh session.");
      issued.add(session.id);
      this.#sessionIds.set(adapter, issued);
      return await work(session);
    } finally {
      await bounded(() => adapter.close(session), WORKFLOW_LIMITS.cleanupWaitMs);
    }
  }

  /** Races an adapter call against cancellation; an aborted call is also cancelled at the adapter within a bound. */
  private async call<T>(role: ResolvedRole, session: Session, invoke: () => Promise<T>): Promise<T> {
    try { return await raceAbort(invoke(), this.#signal, () => this.cancelled()); }
    catch (error) {
      if (this.#signal?.aborted) await bounded(() => role.adapter.cancel(session), WORKFLOW_LIMITS.cleanupWaitMs);
      throw stageError(error);
    }
  }

  /** Read-only verification of the primary workspace (read-only tasks and repository reviews). */
  private async verify(plan: VerificationPlan, root: string): Promise<VerificationVerdict> {
    this.checkAborted();
    let verdict: VerificationVerdict;
    try { verdict = await raceAbort(this.config.verifier.verify(plan, root, this.#signal), this.#signal, () => this.cancelled()); }
    catch (error) { throw stageError(error, "verifierFailure"); }
    return this.checkedVerdict(verdict, plan);
  }

  /**
   * Confined verification of the current candidate through the workspace port. A classified refusal (nothing ran) is
   * returned as such; anything else is held to exactly the rules of a primary-workspace verdict.
   */
  private async verifyCandidate(plan: VerificationPlan): Promise<VerificationVerdict> {
    this.checkAborted();
    let verdict: VerificationVerdict;
    try { verdict = await raceAbort(this.config.workspace.verify(this.#lease!, plan, this.#signal), this.#signal, () => this.cancelled()); }
    catch (error) { throw stageError(error, "verifierFailure"); }
    const refusal: unknown = verdict?.refusal;
    if (refusal !== undefined) {
      if (!(VERIFICATION_REFUSALS as readonly unknown[]).includes(refusal) || verdict.passed !== false || verdict.commandsRun !== 0 ||
          !isFusionError(verdict.failure))
        throw new StageFailure({ kind: "InternalError", retryable: false, safeMessage: "The verifier returned an invalid verdict." },
          "verifierFailure");
      return Object.freeze({ passed: false, commandsRun: 0, refusal: refusal as VerificationRefusal, failure: verdict.failure,
        ...(verdict.evidence === undefined ? {} : { evidence: evidenceSummary(verdict.evidence, plan) }) });
    }
    const checked = this.checkedVerdict(verdict, plan);
    return verdict.evidence === undefined ? checked : Object.freeze({ ...checked, evidence: evidenceSummary(verdict.evidence, plan) });
  }

  private checkedVerdict(verdict: VerificationVerdict, plan: VerificationPlan): VerificationVerdict {
    const failure: unknown = verdict?.failure;
    if (verdict === null || typeof verdict !== "object" || typeof verdict.passed !== "boolean" ||
        !Number.isSafeInteger(verdict.commandsRun) || verdict.commandsRun < 0 || verdict.commandsRun > plan.commands.length ||
        verdict.refusal !== undefined || (failure !== undefined && !isFusionError(failure)))
      throw new StageFailure({ kind: "InternalError", retryable: false, safeMessage: "The verifier returned an invalid verdict." },
        "verifierFailure");
    if (verdict.passed && (verdict.commandsRun !== plan.commands.length || failure !== undefined))
      throw new StageFailure({ kind: "InternalError", retryable: false,
        safeMessage: "The verifier reported a pass without running every command." }, "verifierFailure");
    const clean: VerificationVerdict = Object.freeze({ passed: verdict.passed, commandsRun: verdict.commandsRun,
      ...(typeof verdict.failedCommand === "string" ? { failedCommand: verdict.failedCommand } : {}),
      ...(failure === undefined ? {} : { failure: failure as FusionError }) });
    if (clean.passed) return clean;
    this.checkAborted();
    const kind = clean.failure?.kind;
    // A check that ran and did not pass is a verification failure; a verifier that could not run is not.
    if (kind === undefined || kind === "VerificationFailure" || kind === "Timeout") return clean;
    throw new StageFailure(clean.failure!, kind === "SecurityViolation" ? "securityViolation"
      : kind === "InvalidInput" ? "invalidRequest" : "verifierFailure");
  }

  /** A confined verification that could not start: a classified stop, never a retry and never a review. */
  private refused(refusal: VerificationRefusal, error: FusionError, attempt: number): Promise<WorkflowResult> {
    const [state, reason] = REFUSAL_OUTCOME[refusal];
    return this.finish(state, reason, { attempt, error, ...(state === "humanGateRequired" ? { pendingStage: "humanGate" as const } : {}) });
  }

  private async escalate(signals: readonly RiskSignal[]): Promise<void> {
    this.#risk = escalateRisk(this.#risk!, signals);
    await this.emitRisk();
  }

  private async emitRisk(): Promise<void> {
    const risk = this.#risk!;
    await this.emit({ type: "risk", level: risk.level, decisive: risk.decisive.slice(0, 32), revision: risk.revision }, false);
  }

  private async emit(event: WorkflowEvent, bestEffort: boolean): Promise<void> {
    if (this.config.events === undefined || this.#eventsBroken) return;
    try { await this.config.events.append(event); }
    catch (error) {
      this.#eventsBroken = true;
      if (!bestEffort) throw new StageFailure(internalError("Workflow events could not be recorded.", error), "internalFailure");
    }
  }

  /** Records a transition only after its event is durable, so a recorded state is never ahead of the log. */
  private async move(to: WorkflowState, reason: TransitionReason, extras: Extras = {}, bestEffort = false): Promise<void> {
    const from = this.#state;
    if (TERMINAL.has(from) || !(NEXT[from].includes(to) || ALWAYS.has(to)))
      failWith("InternalError", "The workflow attempted an invalid state transition.");
    const transition: Transition = Object.freeze({ from, to, reason,
      ...(extras.role === undefined ? {} : { role: extras.role }),
      ...(extras.attempt === undefined ? {} : { attempt: extras.attempt }) });
    await this.emit({ type: "transition", transition }, bestEffort);
    this.#transitions.push(transition);
    this.#state = to;
  }

  /**
   * Every terminal decision first discards the live candidate. A success whose teardown is not proven complete is
   * never reported as a success; an unfinished decision keeps its state and reports the incomplete cleanup.
   */
  private async finish(state: TerminalState, reason: TransitionReason, extras: Extras = {}): Promise<WorkflowResult> {
    const released = await this.releaseCandidate(false);
    const viewsReleased = await this.releaseViews(false);
    if ((!released || !viewsReleased || !this.#viewsComplete) && (state === "completed" || state === "answered")) {
      const error: FusionError = { kind: "WorkspaceConflict", retryable: false, safeMessage: released
        ? "A provider view could not be removed completely, so the result is not reported as a success."
        : "The Writer candidate could not be removed completely, so the result is not reported as a success." };
      await this.move("failed", "cleanupIncomplete");
      return this.snapshot("failed", { error });
    }
    await this.move(state, reason, extras);
    return this.snapshot(state, extras);
  }

  private async fail(error: unknown): Promise<WorkflowResult> {
    let state: TerminalState = "failed", reason: TransitionReason, fusionError: FusionError;
    if (error instanceof FusionFailure && error.error.kind === "SecurityViolation") {
      fusionError = error.error;
      reason = "securityViolation";
    } else if (this.#deadline?.aborted) {
      reason = "timedOut";
      fusionError = { kind: "Timeout", safeMessage: "The workflow deadline expired.", retryable: true };
    } else if (this.request?.signal instanceof AbortSignal && this.request.signal.aborted) {
      state = "cancelled"; reason = "cancelled";
      fusionError = { kind: "Cancelled", safeMessage: "The workflow was cancelled.", retryable: false };
    } else if (error instanceof FusionFailure) {
      fusionError = error.error;
      reason = error instanceof StageFailure ? error.reason : FAILURE_REASON[error.error.kind];
    } else {
      fusionError = internalError("The workflow failed unexpectedly.", error);
      reason = "internalFailure";
    }
    // The candidate and every provider view are discarded even after a failure or cancellation; that never masks the
    // failure itself.
    await this.releaseCandidate(true).catch(() => false);
    await this.releaseViews(true).catch(() => false);
    if (TERMINAL.has(this.#state)) return this.snapshot(this.#state as TerminalState, { error: fusionError });
    await this.move(state, reason, {}, true);
    return this.snapshot(state, { error: fusionError });
  }

  private snapshot(state: TerminalState, extras: Extras): WorkflowResult {
    return Object.freeze({
      state, transitions: Object.freeze([...this.#transitions]), delegateAttempts: this.#attempts,
      reviews: Object.freeze([...this.#reviews]),
      ...(this.#risk === undefined ? {} : { risk: this.#risk }),
      ...(this.#lease === undefined ? {} : { lease: this.#lease }),
      ...(this.#plan === undefined ? {} : { plan: this.#plan }),
      ...(this.#result === undefined ? {} : { result: this.#result }),
      ...(this.#changeSet === undefined ? {} : { changeSet: this.#changeSet }),
      ...(this.#applied === undefined ? {} : { applied: this.#applied }),
      ...(this.#changed === undefined ? {} : { changedPaths: this.#changed }),
      ...(this.#verdict === undefined ? {} : { verification: this.#verdict }),
      ...(extras.error === undefined ? {} : { error: extras.error }),
      ...(extras.pendingStage === undefined ? {} : { pendingStage: extras.pendingStage }),
      ...(this.#candidates === 0 ? {} : { cleanup: Object.freeze({ candidates: this.#candidates, released: this.#released,
        complete: this.#cleanupComplete && this.#released === this.#candidates }) }),
      ...(this.#viewsCreated === 0 ? {} : { providerViews: Object.freeze({ created: this.#viewsCreated, released: this.#viewsReleased,
        complete: this.#viewsComplete && this.#viewsReleased === this.#viewsCreated }) }),
    });
  }
}
