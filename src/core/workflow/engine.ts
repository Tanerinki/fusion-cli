import { isAbsolute, relative, resolve } from "node:path";
import { raceAbort } from "../cancellation.js";
import type { AdjudicatedFinding, AgentRole, DelegationPacket, Finding, FusionError, FusionErrorKind, ResultPacket, Session,
  StructuredTurnRequest, VerificationPlan } from "../domain.js";
import { FusionFailure, failWith, internalError } from "../errors.js";
import { escalateRisk, riskRank, type RiskAssessment, type RiskLevel, type RiskSignal } from "../policy/risk.js";
import { scanRiskText } from "../policy/risk-text.js";
import { NO_EXTRA_CAPABILITIES, resolveRole, type ResolvedRole, type TaskCapabilitySurface } from "../policy/routing.js";
import { inspectTask, scopeKey, unexpectedScopeSignals, verificationFailureSignal, verificationPlanReferences,
  verificationReferenceSignals } from "../policy/task-inspector.js";
import { adjudicate, evaluateFacts, REVIEW_LIMITS, validateAdjudicationReport, validateReviewReport,
  type ObservedState } from "../review/findings.js";
import { isOutstanding, REVIEW_CYCLE_LIMIT, reviewEvidence, reviewMode, reviewOutcome } from "../review/policy.js";
import { delegatePacket, packetRiskText, reviewPacket, validateDelegationPacket, validateStructuredTurnResult,
  validateTurnResult } from "./packets.js";
import { REVIEW_EVIDENCE_LIMITS } from "../review/policy.js";
import { PRIMARY_WORKSPACE, TERMINAL_STATES, type PendingStage, type RepositoryReviewRequest, type ReviewCycleRecord,
  type TerminalState, type Transition, type TransitionReason, type VerificationVerdict, type WorkflowConfig, type WorkflowEvent,
  type WorkflowRequest, type WorkflowResult, type WorkflowState, type WorkspaceHandle } from "./types.js";

export const WORKFLOW_LIMITS = Object.freeze({
  /** Targeted delegate retries after the first attempt, for flows with a Lead. Low-risk flows get none. */
  delegateRetries: 1,
  maxTimeoutMs: 24 * 60 * 60 * 1000,
  /** Bound on best-effort session cancel/close so cleanup can never hang a finished workflow. */
  cleanupWaitMs: 5_000,
  maxChangedPaths: 10_000,
});

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
  retrying: ["delegating", "humanGateRequired"],
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
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

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

/**
 * Writer leases bound to a running workflow, process-wide. A lease (by ID or by path) can back at most one
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

const proceeds = (packet: ResultPacket): boolean => packet.result.status === "completed" && packet.needsLeadDecision.length === 0;
const approves = (packet: ResultPacket): boolean => proceeds(packet) && packet.failures.length === 0;

/**
 * Provider-neutral orchestration state machine. It connects task inspection, monotonic risk, capability-driven
 * routing, workspace leases and Fusion verification. Roles are resolved from configuration; nothing here depends
 * on which provider or model fills a role.
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

class WorkflowRun {
  #state: WorkflowState = "received";
  readonly #transitions: Transition[] = [];
  readonly #token = Symbol("workflow");
  readonly #claimed: string[] = [];
  #risk?: RiskAssessment;
  #tier: RiskLevel = "low";
  #writes = false;
  #lease?: WorkspaceHandle;
  #plan?: ResultPacket;
  #result?: ResultPacket;
  #changed?: readonly string[];
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
    if (!writes && plan.commands.some(command => command.mutationPolicy !== "readOnly"))
      failWith("InvalidInput", "Verification of the primary workspace must be read-only.");
    if (writes && unexpectedScopeSignals(inspection.paths, packet.scope.allowedFiles).length > 0)
      failWith("InvalidInput", "The delegated scope exceeds the inspected task scope.");
    // Everything that can steer a role is inspected before the flow is chosen: all delegated packet text (one
    // canonical, bounded scan) and task paths the verification plan itself runs or reads.
    const delegated = scanRiskText(packetRiskText(packet), "delegation").signals;
    const referenced = writes ? verificationReferenceSignals(inspection.paths, verificationPlanReferences(plan.commands)) : [];
    await this.move("inspected", "taskInspected");
    await this.emitRisk();
    const extra = this.freshSignals([...delegated, ...referenced]);
    if (extra.length > 0) await this.escalate(extra);
    this.#tier = this.#risk.level;

    // Policy eligibility: every role the flow needs is resolved before any turn runs or any lease exists.
    const tier = this.#tier;
    const surface: TaskCapabilitySurface = { shell: request.task.requestedCapabilities.shell === true,
      network: request.task.requestedCapabilities.network === true };
    const needed: AgentRole[] = tier === "low" ? [] : ["Lead"];
    if (tier !== "critical") {
      if (writes && tier === "high" && request.explore === true) needed.push("Explorer");
      needed.push(writes ? "Worker" : "Explorer");
    }
    const roles = new Map<AgentRole, ResolvedRole>();
    for (const role of needed) if (!roles.has(role))
      roles.set(role, await raceAbort(resolveRole(role, this.config.roles, surface), this.#signal, () => this.cancelled())
        .catch(error => { throw stageError(error, "policyFailure"); }));
    // A flow that will need a fresh Reviewer and an adjudicating Lead routes them now, before any work runs.
    if (tier !== "critical" && reviewMode(tier, writes, this.#risk.signals) === "fresh")
      await this.reviewRoles().catch(error => { throw stageError(error, "policyFailure"); });
    const bound = (role: AgentRole): ResolvedRole => roles.get(role) ?? failWith("InternalError", "A workflow role was not routed.");
    await this.move("routed", "bindingsResolved");

    let exploration: ResultPacket | undefined;
    if (tier !== "low") {
      await this.move("planning", "planRequested", { role: "Lead" });
      this.#plan = await this.readOnlyTurn(bound("Lead"), packet, undefined);
      if (!proceeds(this.#plan)) return this.finish("decisionRequired", "decisionRequested", { role: "Lead" });
      if (tier === "critical")
        return this.finish("humanGateRequired", "humanGateRequiredForRisk", { pendingStage: "humanGate" });
      if (writes && tier === "high" && request.explore === true) {
        const explorerPacket = delegatePacket(packet, { plan: this.#plan });
        if (await this.outgoingIsCritical(explorerPacket))
          return this.finish("humanGateRequired", "humanGateRequiredForRisk", { pendingStage: "humanGate" });
        await this.move("exploring", "explorationRequested", { role: "Explorer" });
        exploration = await this.readOnlyTurn(bound("Explorer"), explorerPacket, undefined);
        if (!proceeds(exploration)) return this.finish("decisionRequired", "decisionRequested", { role: "Explorer" });
      }
    }

    const delegateRole: AgentRole = writes ? "Worker" : "Explorer";
    const delegate = bound(delegateRole);
    const contributions = { ...(this.#plan ? { plan: this.#plan } : {}), ...(exploration ? { exploration } : {}) };
    const firstPacket = delegatePacket(packet, contributions);
    // Forwarded Lead/Explorer text is scanned as sent; critical intent stops at the human gate before any lease.
    if (await this.outgoingIsCritical(firstPacket))
      return this.finish("humanGateRequired", "humanGateRequiredForRisk", { pendingStage: "humanGate" });
    if (writes) {
      await this.acquireLease();
      await this.move("leased", "leaseAcquired");
    }
    const forbidden = new Set(packet.scope.forbiddenFiles.map(scopeKey));
    const allowedScope = packet.scope.allowedFiles.filter(path => !forbidden.has(scopeKey(path)));
    this.#allowedScope = allowedScope;
    // One budget for all implementer attempts: an O3 retry and an O4 corrective attempt draw from the same two.
    const limit = tier === "low" ? 1 : 1 + WORKFLOW_LIMITS.delegateRetries;
    let retry: Parameters<typeof delegatePacket>[2];
    for (let attempt = 1; ; attempt++) {
      const turnPacket = attempt === 1 ? firstPacket : delegatePacket(packet, contributions, retry);
      if (attempt > 1 && await this.outgoingIsCritical(turnPacket))
        return this.finish("humanGateRequired", "humanGateRequiredForRisk", { pendingStage: "humanGate" });
      await this.move("delegating", "delegated", { role: delegateRole, attempt });
      this.#attempts = attempt;
      const output = writes ? await this.writerTurn(delegate, turnPacket) : await this.readOnlyTurn(delegate, turnPacket, undefined);
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
      let scoped: string | undefined;
      if (writes) {
        const changed = await this.changedPaths();
        if (changed.length === 0) return this.finish("decisionRequired", "noChanges", { role: delegateRole, attempt });
        const scope = unexpectedScopeSignals(allowedScope, changed);
        if (scope.length > 0) {
          await this.escalate(scope);
          return this.finish("decisionRequired", "unexpectedScope", { attempt });
        }
        scoped = await this.fingerprint(this.#lease, this.#signal);
      }
      if (plan.commands.length > 0) {
        await this.move("verifying", "verificationStarted", { attempt });
        // Verification runs workspace content with the user's privileges; the primary is proven unchanged around it.
        const root = writes ? this.#lease!.path : this.config.workspace.primaryRoot;
        const verdict = await this.unchanged(undefined, () => this.verify(plan, root));
        this.#verdict = verdict;
        if (!verdict.passed) {
          const failedCommand = verdict.failedCommand ?? "unidentified";
          await this.escalate([verificationFailureSignal(failedCommand)]);
          const error: FusionError = verdict.failure ?? { kind: "VerificationFailure", retryable: false,
            safeMessage: "Fusion verification did not pass." };
          if (attempt < limit) {
            await this.move("retrying", "verificationFailed", { attempt });
            retry = { attempt: attempt + 1, limit, reason: `Fusion verification command ${failedCommand} did not pass.` };
            continue;
          }
          return limit > 1 ? this.finish("decisionRequired", "retryExhausted", { attempt, error })
            : this.finish("failed", "verificationFailed", { attempt, error });
        }
        if (writes) {
          // What was verified is what the scope check saw; a mutating verifier's output is scope-checked again.
          this.#verifiedState = await this.fingerprint(this.#lease, this.#signal);
          if (plan.commands.every(command => command.mutationPolicy === "readOnly")) {
            if (this.#verifiedState !== scoped) this.leaseChanged();
          } else {
            const scope = unexpectedScopeSignals(allowedScope, await this.changedPaths());
            if (scope.length > 0) {
              await this.escalate(scope);
              return this.finish("decisionRequired", "unexpectedScope", { attempt });
            }
          }
        }
        this.#verifiedAttempt = attempt;
      }
      const next = await this.conclude(bound, packet, plan, writes && attempt < limit);
      if ("result" in next) return next.result;
      // Confirmed, fixable findings: the single corrective attempt, followed by verification and a fresh review.
      await this.move("retrying", "reviewFindingsConfirmed", { role: "Worker", attempt });
      retry = { attempt: attempt + 1, limit, reason: `Fusion review confirmed ${next.correction.length} finding(s) to fix.`,
        findings: next.correction };
    }
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
        reviewPacket(packet, this.#result!, this.#changed ?? [], plan, plan.commands.length > 0), this.#lease);
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

  /** Fresh Reviewer and adjudicating Lead: strict read-only surface and structured turns, never the Worker. */
  private async reviewRoles(): Promise<ReviewRoles> {
    if (this.#reviewRoles) return this.#reviewRoles;
    const route = (role: AgentRole): Promise<ResolvedRole> => raceAbort(
      resolveRole(role, this.config.roles, NO_EXTRA_CAPABILITIES, { structuredTurns: true }), this.#signal, () => this.cancelled());
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
    return { verification: new Map(plan.commands.map(command => [command.id, passed])), changedPaths: this.#changed ?? [],
      allowedScope: this.#allowedScope, claimedTests: this.#result?.verification.testsRun ?? [] };
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
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false, safeMessage: "The lease diff could not be taken." },
        "workspaceFailure");
    return reviewEvidence(packet, verification, { kind: "diff", changedPaths: this.#changed ?? [], text: diff.text,
      truncated: diff.truncated });
  }

  /** The verified lease must be exactly what is handed on; any later change voids the verification. */
  private async assertVerifiedState(): Promise<void> {
    if (this.#lease === undefined || this.#verifiedState === undefined) return;
    if (await this.fingerprint(this.#lease, this.#signal) !== this.#verifiedState) this.leaseChanged();
  }
  private leaseChanged(): never {
    failWith("SecurityViolation", "The workspace lease changed outside the writer's turn; its verification is void.");
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

  private async acquireLease(): Promise<void> {
    this.checkAborted();
    const ownerId = `${this.request.runId}.worker`;
    let handle: WorkspaceHandle;
    try { handle = await this.config.workspace.acquire(ownerId, this.#signal); }
    catch (error) { throw stageError(error, "workspaceFailure"); }
    const { primaryRoot: primary, leaseRoot } = this.config.workspace;
    if (handle === null || typeof handle !== "object" || typeof handle.leaseId !== "string" || handle.leaseId.length === 0 ||
        handle.leaseId.length > 128 || typeof handle.path !== "string" || !isAbsolute(handle.path))
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false,
        safeMessage: "The workspace port returned an invalid lease." }, "workspaceFailure");
    // A refused handle is never reported as this run's lease, so no caller can clean up a directory Fusion does not own.
    if (handle.leaseId === PRIMARY_WORKSPACE || typeof primary !== "string" || !isAbsolute(primary) ||
        typeof leaseRoot !== "string" || !isAbsolute(leaseRoot) || within(leaseRoot, primary) ||
        !within(leaseRoot, handle.path) || samePath(leaseRoot, handle.path) || within(handle.path, primary))
      failWith("SecurityViolation", "The primary workspace can never be assigned to an autonomous writer.");
    if (handle.ownerId !== ownerId)
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false,
        safeMessage: "The workspace lease is owned by another writer." }, "workspaceFailure");
    const keys = leaseKeys(handle);
    if (keys.some(key => activeLeases.has(key)))
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false,
        safeMessage: "The workspace lease is already bound to another active writer." }, "workspaceFailure");
    for (const key of keys) { activeLeases.set(key, this.#token); this.#claimed.push(key); }
    this.#lease = Object.freeze({ leaseId: handle.leaseId, ownerId: handle.ownerId, path: handle.path });
  }

  private async changedPaths(): Promise<readonly string[]> {
    this.checkAborted();
    let changed: readonly string[];
    try { changed = await this.config.workspace.changedPaths(this.#lease!, this.#signal); }
    catch (error) { throw stageError(error, "workspaceFailure"); }
    if (!Array.isArray(changed) || changed.length > WORKFLOW_LIMITS.maxChangedPaths ||
        changed.some(path => typeof path !== "string" || path.length === 0))
      throw new StageFailure({ kind: "WorkspaceConflict", retryable: false,
        safeMessage: "The lease's changed paths could not be determined." }, "workspaceFailure");
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
   * Runs `work` (an agent turn or a verification) and then proves `handle` (the primary when undefined) is
   * unchanged. The after-check runs even when the work failed or was cancelled; a change is a security failure
   * and raises risk to critical.
   */
  private async unchanged<T>(handle: WorkspaceHandle | undefined, work: () => Promise<T>): Promise<T> {
    this.checkAborted();
    const before = await this.fingerprint(handle, this.#signal);
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try { outcome = { ok: true, value: await work() }; } catch (error) { outcome = { ok: false, error }; }
    const after = await this.fingerprint(handle, undefined);
    if (after !== before) {
      const code = handle === undefined ? "primaryWorkspaceChanged" : "readOnlyWorkspaceChanged";
      // The violation is reported even if its risk event cannot be recorded.
      await this.escalate([{ code, level: "critical", source: "diff",
        evidence: "A workspace that must stay unchanged during an agent turn or verification was modified." }]).catch(() => undefined);
      failWith("SecurityViolation", handle === undefined
        ? "The primary workspace changed while an agent turn or verification was running."
        : "A read-only turn changed its workspace.");
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** A read-only turn on a lease proves both the lease and the primary unchanged; on the primary, the primary. */
  private readOnlyGuard<T>(handle: WorkspaceHandle | undefined, work: () => Promise<T>): Promise<T> {
    return handle === undefined ? this.unchanged(undefined, work) : this.unchanged(undefined, () => this.unchanged(handle, work));
  }

  private readOnlyTurn(role: ResolvedRole, packet: DelegationPacket, handle: WorkspaceHandle | undefined): Promise<ResultPacket> {
    if (role.posture !== "readOnly") failWith("InternalError", "A writer role cannot run a read-only turn.");
    return this.readOnlyGuard(handle, () => this.turn(role, packet, handle?.leaseId ?? PRIMARY_WORKSPACE));
  }

  /** A structured review or adjudication turn: read-only, in a fresh session, on the lease or the primary. */
  private structuredTurn(role: ResolvedRole, request: StructuredTurnRequest): Promise<{ output: unknown; sessionId: string }> {
    if (role.posture !== "readOnly") failWith("InternalError", "Review and adjudication run only in read-only roles.");
    const handle = this.#lease;
    return this.readOnlyGuard(handle, () => this.withSession(role, handle?.leaseId ?? PRIMARY_WORKSPACE, async session => {
      const invoke = role.adapter.runStructuredTurn;
      if (typeof invoke !== "function") failWith("CapabilityUnavailable", "The bound adapter cannot run structured turns.");
      const raw = await this.call(role, session, () => invoke.call(role.adapter, session, request, this.#signal));
      const turn = validateStructuredTurnResult(raw);
      if (turn.effectiveProvider !== role.binding.provider)
        failWith("ProviderIdentityMismatch", "The turn was served by a provider other than the bound one.");
      if (turn.status !== "completed") throw new StageFailure(turn.error, FAILURE_REASON[turn.error.kind]);
      return { output: turn.output, sessionId: session.id };
    }));
  }

  /** The writer runs only inside its own lease; the primary workspace is proven unchanged around the turn. */
  private writerTurn(role: ResolvedRole, packet: DelegationPacket): Promise<ResultPacket> {
    const lease = this.#lease;
    if (role.posture !== "writer" || lease === undefined || !this.#claimed.includes(`id:${lease.leaseId}`))
      failWith("SecurityViolation", "An autonomous writer requires its own workspace lease.");
    return this.unchanged(undefined, () => this.turn(role, packet, lease.leaseId));
  }

  private turn(role: ResolvedRole, packet: DelegationPacket, workspaceLeaseId: string): Promise<ResultPacket> {
    return this.withSession(role, workspaceLeaseId, async session => {
      const raw = await this.call(role, session, () => role.adapter.runTurn(session, packet, this.#signal));
      const turn = validateTurnResult(raw);
      if (turn.effectiveProvider !== role.binding.provider)
        failWith("ProviderIdentityMismatch", "The turn was served by a provider other than the bound one.");
      if (turn.status !== "completed") throw new StageFailure(turn.error, FAILURE_REASON[turn.error.kind]);
      return turn.output;
    });
  }

  /**
   * Opens a fresh session, checks it echoes the requested role, posture, run, workspace and provider, refuses any
   * session ID this run has already seen, and always closes it within a bound.
   */
  private async withSession<T>(role: ResolvedRole, workspaceLeaseId: string, work: (session: Session) => Promise<T>): Promise<T> {
    this.checkAborted();
    const { adapter, binding } = role;
    const request = { runId: this.request.runId, role: role.role, workspaceLeaseId, posture: role.posture, model: binding.model };
    let session: Session;
    try { session = await raceAbort(adapter.createSession(request), this.#signal, () => this.cancelled()); }
    catch (error) { throw stageError(error); }
    try {
      if (session === null || typeof session !== "object" || session.role !== role.role || session.posture !== role.posture ||
          session.workspaceLeaseId !== workspaceLeaseId || session.runId !== this.request.runId ||
          session.provider !== binding.provider || typeof session.id !== "string")
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

  private async verify(plan: VerificationPlan, root: string): Promise<VerificationVerdict> {
    this.checkAborted();
    let verdict: VerificationVerdict;
    try { verdict = await raceAbort(this.config.verifier.verify(plan, root, this.#signal), this.#signal, () => this.cancelled()); }
    catch (error) { throw stageError(error, "verifierFailure"); }
    const failure: unknown = verdict?.failure;
    if (verdict === null || typeof verdict !== "object" || typeof verdict.passed !== "boolean" ||
        !Number.isSafeInteger(verdict.commandsRun) || verdict.commandsRun < 0 || verdict.commandsRun > plan.commands.length ||
        (failure !== undefined && (failure === null || typeof failure !== "object" ||
          !Object.hasOwn(FAILURE_REASON, (failure as FusionError).kind))))
      throw new StageFailure({ kind: "InternalError", retryable: false, safeMessage: "The verifier returned an invalid verdict." },
        "verifierFailure");
    if (verdict.passed && (verdict.commandsRun !== plan.commands.length || failure !== undefined))
      throw new StageFailure({ kind: "InternalError", retryable: false,
        safeMessage: "The verifier reported a pass without running every command." }, "verifierFailure");
    if (verdict.passed) return verdict;
    this.checkAborted();
    const kind = verdict.failure?.kind;
    // A check that ran and did not pass is a verification failure; a verifier that could not run is not.
    if (kind === undefined || kind === "VerificationFailure" || kind === "Timeout") return verdict;
    throw new StageFailure(verdict.failure!, kind === "SecurityViolation" ? "securityViolation"
      : kind === "InvalidInput" ? "invalidRequest" : "verifierFailure");
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

  private async finish(state: TerminalState, reason: TransitionReason, extras: Extras = {}): Promise<WorkflowResult> {
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
      ...(this.#changed === undefined ? {} : { changedPaths: this.#changed }),
      ...(this.#verdict === undefined ? {} : { verification: this.#verdict }),
      ...(extras.error === undefined ? {} : { error: extras.error }),
      ...(extras.pendingStage === undefined ? {} : { pendingStage: extras.pendingStage }),
    });
  }
}
