import { join } from "node:path";
import type { BaselineFileHash, VerificationPlan } from "../../core/domain.js";
import { failWith } from "../../core/errors.js";
import type { ApplicationOutcome, CleanupReport, EventSink, ProviderViewHandle, ProviderViewPort, ProviderViewRequest,
  VerificationVerdict, VerifierPort, WorkflowEvent, WorkspaceHandle, WorkspacePort } from "../../core/workflow/types.js";
import type { ArtifactStore } from "../events/artifact-store.js";
import type { EventStore } from "../events/event-store.js";
import type { EventInput, EventScope } from "../events/types.js";
import type { VerificationEngine, VerificationRunOptions } from "../verification/engine.js";
import type { GitClient } from "../workspace/git.js";
import { PrimaryWorkspaceMonitor, type IgnoredCoverage, type IgnoredProtectionPolicy } from "../workspace/ignored-monitor.js";
import type { ProviderViewStore, ViewInputFilter } from "../workspace/provider-views.js";
import type { PrivateCandidateWorkspacePort } from "./candidates.js";

/**
 * Workspace port for read-only runs (repository review, read-only builds): the primary can be fingerprinted, but no
 * candidate can ever be acquired, so no Writer can run, whatever the workflow asks.
 */
export class ReadOnlyWorkspacePort implements WorkspacePort {
  readonly leaseRoot: string;
  readonly #primary: PrimaryWorkspaceMonitor;
  constructor(readonly primaryRoot: string, git: GitClient, protection: IgnoredProtectionPolicy = {}) {
    this.leaseRoot = join(primaryRoot, ".fusion", "no-candidates");
    this.#primary = new PrimaryWorkspaceMonitor(primaryRoot, git, protection);
  }
  /** Coverage of the latest primary observation's ignored-path monitoring (counts only). */
  get ignoredCoverage(): IgnoredCoverage | undefined { return this.#primary.coverage; }
  async acquire(): Promise<WorkspaceHandle> { return failWith("SecurityViolation", "This run is read-only; no Writer candidate exists."); }
  async baselineHashes(): Promise<readonly BaselineFileHash[]> {
    return failWith("SecurityViolation", "This run is read-only; there is no candidate.");
  }
  async apply(): Promise<ApplicationOutcome> { return failWith("SecurityViolation", "This run is read-only; nothing is ever applied."); }
  async changedPaths(): Promise<readonly string[]> { return failWith("SecurityViolation", "This run is read-only; there is no candidate."); }
  async diff(): Promise<Readonly<{ text: string; truncated: boolean }>> {
    return failWith("SecurityViolation", "This run is read-only; there is no candidate.");
  }
  async verify(): Promise<VerificationVerdict> { return failWith("SecurityViolation", "This run is read-only; there is no candidate."); }
  async release(): Promise<CleanupReport> { return { complete: false, reason: "read-only run" }; }
  async fingerprint(handle: WorkspaceHandle | undefined, signal?: AbortSignal): Promise<string> {
    if (handle !== undefined) failWith("SecurityViolation", "This run is read-only; there is no candidate.");
    return this.#primary.fingerprint(signal);
  }
}

/**
 * The workflow's provider-view port over a `ProviderViewStore`: baseline and working-tree views of the primary, and —
 * with a candidate port — verified copies of a host-applied candidate. Without a candidate port, candidate views are
 * refused (a read-only run has no candidate).
 */
export class ProviderViewWorkspacePort implements ProviderViewPort {
  /**
   * v0.2.1: `filter` is the input policy every view of this run passes (baseline, working tree and candidates alike), so a
   * build's Lead, Explorer, Change Author and Reviewer never read more than a conversation about the same files would.
   */
  constructor(private readonly store: ProviderViewStore, private readonly candidates?: PrivateCandidateWorkspacePort,
    private readonly filter?: ViewInputFilter) {}
  get viewRoot(): string { return this.store.viewRoot; }
  async open(ownerId: string, request: ProviderViewRequest, signal?: AbortSignal): Promise<ProviderViewHandle> {
    const view = request.kind === "baseline" ? await this.store.baseline(ownerId, signal, this.filter)
      : request.kind === "workingTree" ? await this.store.workingTree(ownerId, signal, this.filter)
      : this.candidates === undefined ? failWith("SecurityViolation", "This run has no Writer candidate to view.")
      : await this.store.candidate(ownerId, await this.candidates.candidateSource(request.candidate), signal, this.filter);
    return Object.freeze({ viewId: view.viewId, kind: view.kind, path: view.path });
  }
  fingerprint(view: ProviderViewHandle): Promise<string> { return this.store.fingerprint(view.viewId); }
  release(view: ProviderViewHandle): Promise<CleanupReport> { return this.store.release(view.viewId); }
}

/** Workflow verifier port over the O1 VerificationEngine; only Fusion-observed results cross it. */
export class EngineVerifierPort implements VerifierPort {
  constructor(private readonly engine: VerificationEngine,
    private readonly options: Omit<VerificationRunOptions, "workspaceRoot" | "signal">) {}

  async verify(plan: VerificationPlan, workspaceRoot: string, signal?: AbortSignal): Promise<VerificationVerdict> {
    const report = await this.engine.run(plan, { ...this.options, workspaceRoot, ...(signal ? { signal } : {}) });
    const failed = report.steps.find(step => step.status !== "passed");
    return { passed: report.passed, commandsRun: report.steps.length,
      ...(failed ? { failedCommand: failed.commandId } : {}), ...(report.failure ? { failure: report.failure } : {}) };
  }
}

/**
 * Persists workflow events through the existing EventStore projection boundary. Review findings and adjudications
 * are recorded as bounded labels; with an ArtifactStore, the full record is stored as a redacted JSON artifact.
 */
export class EventStoreWorkflowSink implements EventSink {
  /** `scope` (v0.5): every event of this sink belongs to one tournament candidate, explicitly — whatever else is appended between them. */
  constructor(private readonly store: EventStore, private readonly artifacts?: ArtifactStore, private readonly scope?: EventScope) {}
  private put(input: EventInput): Promise<unknown> { return this.store.append(this.scope === undefined ? input : { ...input, scope: this.scope }); }

  async append(event: WorkflowEvent): Promise<void> {
    switch (event.type) {
      case "transition":
        await this.put({ type: "WorkflowTransition", source: "runtime", payload: event.transition }); return;
      case "risk":
        await this.put({ type: "RiskAssessed", source: "policy",
          payload: { level: event.level, decisive: event.decisive, revision: event.revision } }); return;
      case "reviewCycle":
        if (event.phase === "started") await this.put({ type: "ReviewCycleStarted", source: "review", payload: { cycle: event.cycle } });
        else await this.put({ type: "ReviewCycleCompleted", source: "review",
          payload: { cycle: event.cycle, outcome: event.outcome ?? "gate" } });
        return;
      case "review":
        if (event.phase === "started") await this.put({ type: "ReviewStarted", source: "review", payload: { cycle: event.cycle } });
        else await this.put({ type: "ReviewCompleted", source: "review",
          payload: { cycle: event.cycle, findingCount: event.findingCount ?? 0 } });
        return;
      case "finding": {
        const f = event.finding;
        const artifactRef = this.artifacts ? (await this.artifacts.storeJson({ finding: f }, `review:finding:${f.id}`)).artifactId : undefined;
        await this.put({ type: "FindingRecorded", source: "review", payload: {
          cycle: event.cycle, findingId: f.id, severity: f.severity, confidence: f.confidence, category: f.category, title: f.title,
          ...(f.file === undefined ? {} : { file: f.file }), ...(f.lines ? { lineStart: f.lines.start, lineEnd: f.lines.end } : {}),
          ...(artifactRef === undefined ? {} : { artifactRef }) } });
        return;
      }
      case "adjudication": {
        const a = event.record;
        const artifactRef = this.artifacts ? (await this.artifacts.storeJson({ findingId: a.finding.id, verdict: a.verdict,
          rationale: a.rationale, requiredAction: a.requiredAction, verdictSource: a.verdictSource, supportedFacts: a.supportedFacts },
          `review:adjudication:${a.finding.id}`)).artifactId : undefined;
        await this.put({ type: "AdjudicationRecorded", source: "review", payload: {
          cycle: event.cycle, findingId: a.finding.id, verdict: a.verdict, requiredAction: a.requiredAction,
          verdictSource: a.verdictSource, ...(artifactRef === undefined ? {} : { artifactRef }) } });
        return;
      }
      case "structuredTurn":
        await this.put({ type: "StructuredTurnObserved", source: "provider", payload: { ...event.provenance } });
        return;
      case "turn":
        await this.put({ type: "AgentTurnObserved", source: "provider", payload: { ...event.provenance } });
        return;
      case "proposal":
        await this.put({ type: "ChangeProposalRecorded", source: "runtime",
          payload: { attempt: event.attempt, outcome: event.outcome, operations: event.operations } });
        return;
      case "candidate":
        await this.put({ type: "CandidateObserved", source: "runtime", payload: { attempt: event.attempt, phase: event.phase,
          ...(event.changedPaths === undefined ? {} : { changedPaths: event.changedPaths }),
          ...(event.complete === undefined ? {} : { complete: event.complete }) } });
        return;
      case "providerView":
        await this.put({ type: "ProviderViewObserved", source: "runtime", payload: { kind: event.kind, phase: event.phase,
          ...(event.complete === undefined ? {} : { complete: event.complete }) } });
        return;
      case "reproduction": {
        const e = event.evidence;
        await this.put({ type: "ReproductionObserved", source: "verification", payload: { ran: event.ran,
          ...(event.passed === undefined ? {} : { passed: event.passed }), ...(event.commandsRun === undefined ? {} : { commandsRun: event.commandsRun }),
          ...(event.refusal === undefined ? {} : { refusal: event.refusal }), ...(event.reason === undefined ? {} : { reason: event.reason }),
          ...(e === undefined ? {} : { backendId: e.backendId, confinement: e.confinement, platformRequirement: e.platformRequirement,
            acceptance: e.acceptance, commands: e.commands.map(c => ({ id: c.id, status: c.status, exitCode: c.exitCode })) }) } });
        return;
      }
      case "verification": {
        const e = event.evidence;
        await this.put({ type: "CandidateVerificationObserved", source: "verification", payload: {
          attempt: event.attempt, passed: event.passed, commandsRun: event.commandsRun,
          ...(event.refusal === undefined ? {} : { refusal: event.refusal }),
          ...(e === undefined ? {} : { backendId: e.backendId, confinement: e.confinement, platformRequirement: e.platformRequirement,
            acceptance: e.acceptance, commands: e.commands.map(c => ({ id: c.id, status: c.status, exitCode: c.exitCode })),
            ...(e.dependencies === undefined ? {} : { dependencyKey: e.dependencies.key, dependencyPrepared: e.dependencies.prepared,
              dependencyCacheHit: e.dependencies.cacheHit }) }) } });
        return;
      }
    }
  }
}
