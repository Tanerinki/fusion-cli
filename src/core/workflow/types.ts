import type { AdjudicatedFinding, AgentRole, BaselineFileHash, ChangeScope, ChangeSet, DelegationPacket, Finding, FusionError,
  PacketTurnPurpose, ResultPacket, RunId, VerificationPlan } from "../domain.js";
import type { RiskAssessment, RiskLevel } from "../policy/risk.js";
import type { RoleCandidate } from "../policy/routing.js";
import type { TaskRequest } from "../policy/task-inspector.js";

export const WORKFLOW_STATES = ["received", "inspected", "routed", "planning", "exploring", "leased", "delegating",
  "retrying", "verifying", "reviewing", "adjudicating", "completed", "answered", "failed", "cancelled", "decisionRequired",
  "reviewRequired", "humanGateRequired"] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];
/**
 * `completed`: the required authoritative Fusion verification ran and passed, and every required review gate passed.
 * `answered`: a read-only task finished with no verification to run; no review can turn it into `completed`.
 * `reviewRequired`: verified work that still needs a fresh review Fusion could not run (no eligible Reviewer).
 */
export const TERMINAL_STATES = ["completed", "answered", "failed", "cancelled", "decisionRequired", "reviewRequired",
  "humanGateRequired"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export const TRANSITION_REASONS = [
  // progress
  "taskInspected", "bindingsResolved", "planRequested", "explorationRequested", "leaseAcquired", "delegated",
  "verificationStarted", "delegateUnsuccessful", "verificationFailed", "reviewRequested", "succeeded",
  "answeredWithoutVerification",
  // decisions and later stages
  "decisionRequested", "leadRejected", "retryExhausted", "unexpectedScope", "noChanges", "riskExceedsFlow",
  "reviewRequiredForRisk", "humanGateRequiredForRisk",
  // fresh review and adjudication (O4)
  "freshReviewRequested", "adjudicationRequested", "reviewFindingsConfirmed", "unresolvedFindings", "reviewUnavailable",
  // host-controlled Writer (O5.5B7): each a stable classification of one mechanical stage
  "proposalMalformed", "proposalRejected", "applicationRejected", "platformIncompatible", "verifierUnavailable",
  "dependencyApprovalRequired", "dependencyLaneFailure", "confinementNotAccepted", "cleanupIncomplete",
  // v0.2.1: a proposal would write protected material (or cannot be restored exactly): a human decides
  "protectedMaterial",
  // failures
  "cancelled", "timedOut", "invalidRequest", "policyFailure", "providerFailure", "malformedResult",
  "securityViolation", "workspaceFailure", "verifierFailure", "internalFailure",
] as const;
export type TransitionReason = (typeof TRANSITION_REASONS)[number];

/** Deterministic transition record: no timestamps, provider or model identities, paths or free text. */
export interface Transition {
  readonly from: WorkflowState;
  readonly to: WorkflowState;
  readonly reason: TransitionReason;
  readonly role?: AgentRole;
  readonly attempt?: number;
}
export type ReviewCycleOutcome = "clean" | "correction" | "gate";
/** What Fusion decided about one change proposal; the proposal itself is never an event payload. */
export type ProposalOutcome = "validated" | "malformed" | "rejected";
export type CandidatePhase = "created" | "applied" | "preconditionFailed" | "released";
export type ProviderViewPhase = "created" | "released";
export type WorkflowEvent =
  | Readonly<{ type: "transition"; transition: Transition }>
  | Readonly<{ type: "risk"; level: RiskLevel; decisive: readonly string[]; revision: number }>
  | Readonly<{ type: "reviewCycle"; phase: "started" | "completed"; cycle: number; outcome?: ReviewCycleOutcome }>
  | Readonly<{ type: "review"; phase: "started" | "completed"; cycle: number; findingCount?: number }>
  | Readonly<{ type: "finding"; cycle: number; finding: Finding }>
  | Readonly<{ type: "adjudication"; cycle: number; record: AdjudicatedFinding }>
  | Readonly<{ type: "structuredTurn"; provenance: StructuredTurnProvenance }>
  | Readonly<{ type: "turn"; provenance: TurnProvenance }>
  | Readonly<{ type: "proposal"; attempt: number; outcome: ProposalOutcome; operations: number }>
  | Readonly<{ type: "candidate"; attempt: number; phase: CandidatePhase; changedPaths?: number; complete?: boolean }>
  | Readonly<{ type: "providerView"; kind: ProviderViewKind; phase: ProviderViewPhase; complete?: boolean }>
  | Readonly<{ type: "verification"; attempt: number; passed: boolean; commandsRun: number; refusal?: VerificationRefusal;
      evidence?: VerificationEvidenceSummary }>
  /** v0.4: the confined checks on the UNCHANGED baseline (a reproduction), or why they did not run. */
  | Readonly<{ type: "reproduction"; ran: boolean; passed?: boolean; commandsRun?: number; refusal?: VerificationRefusal;
      reason?: ReproductionUnavailable; evidence?: VerificationEvidenceSummary }>;
/**
 * Who produced a structured turn (a review, an adjudication or a change proposal): the bound provider/transport, the
 * model the binding requested and the model the provider reported serving the turn, and Fusion's session. Opaque
 * labels, never interpreted. `cycle` is the review cycle, or the Writer attempt of a change proposal.
 */
export interface StructuredTurnProvenance {
  readonly cycle: number;
  readonly kind: "review" | "adjudication" | "changeProposal";
  readonly role: AgentRole;
  readonly sessionId: string;
  readonly provider: string;
  readonly transport: string;
  readonly requestedModel: string;
  readonly observedModel: string;
}
/** Who served a packet turn (Lead plan, Explorer, Lead review), with the same opaque provenance labels. */
export interface TurnProvenance {
  readonly kind: PacketTurnPurpose;
  readonly attempt: number;
  readonly role: AgentRole;
  readonly sessionId: string;
  readonly provider: string;
  readonly transport: string;
  readonly requestedModel: string;
  readonly observedModel: string;
}
/** Receives provider-neutral workflow events in order; a failed append stops the workflow. */
export interface EventSink { append(event: WorkflowEvent): Promise<void> }

/** Session workspace identifier for read-only roles attached to the primary workspace. Never a writer's. */
export const PRIMARY_WORKSPACE = "primary";
/**
 * A private, host-controlled Writer candidate: a fresh repository at the committed baseline that only Fusion mutates,
 * by applying one validated ChangeSet. Never the primary workspace, never inside it and never around it. Every Writer
 * attempt gets a fresh candidate; a superseded one is discarded, so nothing accumulates between attempts.
 */
export interface WorkspaceHandle {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly path: string;
}
/** One host-applied operation: hashes and sizes only, never content. */
export interface AppliedOperation {
  readonly kind: "writeText" | "delete";
  readonly path: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly bytes: number;
}
/**
 * v0.2.1 — the host form of a validated proposal (`WorkspacePort.hostChangeSet`): the same operations, with every masked
 * value restored and every precondition as the real file hash; or a refusal a human must decide about.
 */
export type HostChangeSet = Readonly<{ changes: ChangeSet; restored: number }> | Readonly<{ refused: string }>;
/** Host application either happened exactly, or was refused before any mutation because a file precondition failed. */
export type ApplicationOutcome =
  | Readonly<{ applied: readonly AppliedOperation[] }>
  | Readonly<{ preconditionFailed: readonly string[] }>;
/** Whether a released candidate is proven gone. */
export interface CleanupReport {
  readonly complete: boolean;
  /** Stable, path-free reason when incomplete. */
  readonly reason?: string;
}
export interface WorkspacePort {
  /** Absolute path of the user's primary workspace. */
  readonly primaryRoot: string;
  /** Absolute directory holding private candidates; every candidate path must lie strictly inside it. */
  readonly leaseRoot: string;
  /** A fresh private candidate at the committed baseline, owned exclusively by `ownerId`. */
  acquire(ownerId: string, signal?: AbortSignal): Promise<WorkspaceHandle>;
  /**
   * The SHA-256 of each given repository-relative file in a candidate that has not received a ChangeSet yet (`null`:
   * absent), in the given order: the preconditions a read-only Change Author is handed. Never writes.
   */
  baselineHashes(handle: WorkspaceHandle, paths: readonly string[], signal?: AbortSignal): Promise<readonly BaselineFileHash[]>;
  /**
   * v0.2.1: provider views mask secret values (numbered markers) and `baselineHashes` reports each file as its provider
   * saw it, so a proposal is written against that view. This turns a validated proposal into the HOST ChangeSet for the
   * still pristine candidate — markers restored exactly, preconditions as real hashes — or refuses it (protected
   * material, a marker that cannot be restored). Absent: providers saw the real files and the proposal is the host form.
   */
  hostChangeSet?(handle: WorkspaceHandle, changes: ChangeSet, scope: ChangeScope, signal?: AbortSignal): Promise<HostChangeSet>;
  /** Host application of a ChangeSet Fusion already validated against `scope`. Exactly one per candidate. */
  apply(handle: WorkspaceHandle, changes: ChangeSet, scope: ChangeScope, signal?: AbortSignal): Promise<ApplicationOutcome>;
  /** Repository-relative paths changed in the candidate relative to its baseline, including untracked files. */
  changedPaths(handle: WorkspaceHandle, signal?: AbortSignal): Promise<readonly string[]>;
  /** Content fingerprint of a candidate, or of the primary workspace when `handle` is undefined. */
  fingerprint(handle: WorkspaceHandle | undefined, signal?: AbortSignal): Promise<string>;
  /** Bounded textual diff of a candidate against its baseline, including untracked files, for review evidence. */
  diff(handle: WorkspaceHandle, signal?: AbortSignal): Promise<Readonly<{ text: string; truncated: boolean }>>;
  /**
   * Autonomous verification of the applied candidate in an accepted confined backend — never on the host and never
   * with a fallback. A verification that cannot start is a classified `refusal`, not a failed check.
   */
  verify(handle: WorkspaceHandle, plan: VerificationPlan, signal?: AbortSignal): Promise<VerificationVerdict>;
  /**
   * v0.4: the same confined verification of a candidate that has NOT received a ChangeSet — Fusion's checks on the unchanged
   * committed baseline (a reproduction). Refusals are classified exactly as for `verify`. Optional: a port without it cannot
   * reproduce, and the run records that.
   */
  verifyBaseline?(handle: WorkspaceHandle, plan: VerificationPlan, signal?: AbortSignal): Promise<VerificationVerdict>;
  /**
   * v0.5: the unchanged text of files in a candidate that has NOT received a ChangeSet (`null`: absent; `tooLarge`: above the
   * sharing bound), read by Fusion itself — the baseline Fusion derives its own mutations from. Never shown to a provider.
   */
  baselineTexts?(handle: WorkspaceHandle, paths: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, string | null | "tooLarge">>;
  /** Discards a candidate. Never throws for an incomplete removal: it reports it. */
  release(handle: WorkspaceHandle): Promise<CleanupReport>;
}
/**
 * Why a confined verification could not start. Deterministic facts: no role can override them.
 * - `backendUnavailable`: no confined backend is available (never a fallback to the host).
 * - `platformIncompatible`: the task's platform requirement is outside every confined backend's semantics, or unknown.
 * - `dependencyApprovalRequired`: the candidate changes its dependency environment without explicit host approval.
 * - `dependencyLaneFailure`: the approved dependency environment could not be provided (unsupported or refused project).
 * - `confinementNotAccepted`: no verification-isolation acceptance covers the backend (and this is not an offline rehearsal).
 */
export const VERIFICATION_REFUSALS = ["backendUnavailable", "platformIncompatible", "dependencyApprovalRequired",
  "dependencyLaneFailure", "confinementNotAccepted"] as const;
export type VerificationRefusal = (typeof VERIFICATION_REFUSALS)[number];
/**
 * v0.4: why the checks could not run on the unchanged baseline. A refusal keeps its own category; `unsupported`: the port
 * cannot verify a pristine candidate; `noChecks`: nothing ran; `verifierFailure`: the verifier could not run them.
 */
export const REPRODUCTION_UNAVAILABLE = [...VERIFICATION_REFUSALS, "unsupported", "noChecks", "verifierFailure"] as const;
export type ReproductionUnavailable = (typeof REPRODUCTION_UNAVAILABLE)[number];
/** v0.4: the reproduction of one Writer run: the verdict on the unchanged baseline, or why there is none. */
export type ReproductionRecord = Readonly<{ ran: true; verdict: VerificationVerdict }> | Readonly<{ ran: false; reason: ReproductionUnavailable }>;
/** How a candidate verification ran, as Fusion observed it: opaque labels and counts, never paths or output. */
export interface VerificationEvidenceSummary {
  readonly backendId: string;
  readonly confinement: string;
  readonly platformRequirement: string;
  /** `granted`: an acceptance granted in this process covers the backend. `offlineRehearsal`: none; never production evidence. */
  readonly acceptance: "granted" | "offlineRehearsal";
  readonly dependencies?: Readonly<{ kind: string; key: string; prepared: boolean; cacheHit: boolean }>;
  readonly commands: readonly Readonly<{ id: string; status: string; exitCode: number | null }>[];
}
/**
 * v0.5: what one confined command printed, as Fusion observed it — the digest of its retained standard output, whether that
 * output was retained completely (a truncated output is never compared), and a bounded excerpt kept IN MEMORY only (it may
 * hold repository data: it is persisted only through the redactor, as a bounded reproducer).
 */
export interface VerificationObservation {
  readonly id: string;
  readonly exitCode: number | null;
  readonly stdoutSha256: string;
  readonly complete: boolean;
  readonly excerpt: string;
}
/** Fusion-observed verification. Agent-reported checks never reach this port. */
export interface VerificationVerdict {
  readonly passed: boolean;
  /** Commands Fusion actually executed. A pass requires every planned command. */
  readonly commandsRun: number;
  readonly failedCommand?: string;
  readonly failure?: FusionError;
  /** Candidate verification only: why it could not start (then nothing ran and it did not pass). */
  readonly refusal?: VerificationRefusal;
  readonly evidence?: VerificationEvidenceSummary;
  /** v0.5: per command, what it printed (a backend that reports output only). Never an event payload. */
  readonly observations?: readonly VerificationObservation[];
}
/** Read-only verification of the primary workspace (repository review, read-only builds). Never a Writer's candidate. */
export interface VerifierPort {
  verify(plan: VerificationPlan, workspaceRoot: string, signal?: AbortSignal): Promise<VerificationVerdict>;
}

/**
 * What a provider view shows. `baseline`: the committed HEAD as plain files (Lead plan, Explorer, Change Author).
 * `candidate`: a copy of the current host-applied candidate (Lead review, fresh Reviewer, adjudicating Lead).
 * `workingTree`: the primary's current work, for read-only reviews and builds only.
 */
export type ProviderViewKind = "baseline" | "candidate" | "workingTree" | "folder";
export type ProviderViewRequest =
  | Readonly<{ kind: "baseline" }>
  | Readonly<{ kind: "workingTree" }>
  | Readonly<{ kind: "candidate"; candidate: WorkspaceHandle }>;
/** A Fusion-owned provider view: the only directory a provider session of the workflow runs in. */
export interface ProviderViewHandle {
  readonly viewId: string;
  readonly kind: ProviderViewKind;
  readonly path: string;
}
/**
 * Fusion-owned, read-only snapshots providers run in. A view is never the primary, never inside or around it, never a
 * private candidate (nor inside or around one), and contains no `.git`. Any write to a view changes its fingerprint.
 */
export interface ProviderViewPort {
  /** Absolute directory holding views; every view path lies strictly inside it. */
  readonly viewRoot: string;
  open(ownerId: string, request: ProviderViewRequest, signal?: AbortSignal): Promise<ProviderViewHandle>;
  /** Content fingerprint of the whole view. */
  fingerprint(view: ProviderViewHandle, signal?: AbortSignal): Promise<string>;
  /** Removes a view. Never throws for an incomplete removal: it reports it. */
  release(view: ProviderViewHandle): Promise<CleanupReport>;
}

export interface WorkflowConfig {
  /** Role → provider/model configuration, in preference order. The engine never interprets these identities. */
  readonly roles: readonly RoleCandidate[];
  readonly workspace: WorkspacePort;
  readonly verifier: VerifierPort;
  readonly events?: EventSink;
  /**
   * Fusion-owned provider views. Required for a Writer workflow (no provider then ever runs in the primary checkout);
   * when present for a read-only flow, every session of it runs in a view too. Absent: read-only sessions attach to the
   * primary as before (legacy composition only).
   */
  readonly views?: ProviderViewPort;
}
export interface WorkflowRequest {
  readonly runId: RunId;
  readonly task: TaskRequest;
  /** The structured delegation packet; the only task context any role receives. */
  readonly packet: DelegationPacket;
  readonly verification: VerificationPlan;
  /** High/critical writer flows: run the optional read-only Explorer after Lead planning. */
  readonly explore?: boolean;
  /** Overall deadline; expiry aborts in-flight work and ends the workflow as a Timeout failure. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * O5.5B20: the caller guarantees the review stage cannot run in this request (an authorization that gives the fresh
   * Reviewer no turn), so the fresh Reviewer and adjudicating Lead are NOT routed before work starts. Should the flow ever
   * reach review, they are routed then, fail-closed as always. Absent (the default): routed up front.
   */
  readonly deferReviewRouting?: boolean;
  /**
   * v0.4: before the first Writer change, run the confined checks on the unchanged baseline of that attempt's candidate (a
   * reproduction: no model turn). Its result is evidence only; it never stops or steers the run.
   */
  readonly reproduce?: boolean;
  /**
   * v0.4: the host's reliability policy requires the fresh Reviewer and Lead adjudication at this risk (a falsification),
   * where v0.3's rule alone would ask less. It can only ADD the fresh stage; critical work still stops at the human gate.
   */
  readonly requireFreshReview?: boolean;
  /**
   * v0.4: the fresh review is a FALSIFICATION — the Reviewer is asked to break the conclusion (the task's goal), with Fusion's
   * baseline checks as data. Same read-only posture, fresh session, evidence and report contract as a review.
   */
  readonly falsify?: boolean;
}
/**
 * A read-only review of an existing change: no delegate and no Writer. The change is observed by Fusion from the
 * primary workspace before the run and is the only change evidence the Reviewer and Lead receive.
 */
export interface RepositoryReviewRequest {
  readonly runId: RunId;
  /** Must inspect as read-only (for example operation `review`). */
  readonly task: TaskRequest;
  readonly packet: DelegationPacket;
  /** Read-only verification of the primary workspace; may be empty. */
  readonly verification: VerificationPlan;
  readonly change: Readonly<{ changedPaths: readonly string[]; text: string; truncated: boolean }>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Work this engine deliberately leaves to a later stage; it never reports that work as done. */
export type PendingStage = "freshReviewAndAdjudication" | "humanGate";
/** One fresh review and its adjudication, as persisted. */
export interface ReviewCycleRecord {
  readonly cycle: number;
  readonly findings: readonly Finding[];
  readonly adjudications: readonly AdjudicatedFinding[];
  readonly outcome: ReviewCycleOutcome;
}
export interface WorkflowResult {
  readonly state: TerminalState;
  /** Absent only when the task could not be inspected. */
  readonly risk?: RiskAssessment;
  readonly transitions: readonly Transition[];
  /**
   * Identity of the last private Writer candidate. Candidates are disposable (baseline + `changeSet` reconstructs one),
   * so the engine released it before returning; `cleanup` says whether every candidate is proven gone.
   */
  readonly lease?: WorkspaceHandle;
  /** The Lead's structured plan (medium and above). */
  readonly plan?: ResultPacket;
  /**
   * Last delegate result. A Writer attempt's is written by Fusion from the host-applied ChangeSet (no model claim);
   * a read-only delegate's verification fields are claims, never evidence.
   */
  readonly result?: ResultPacket;
  /**
   * The last ChangeSet Fusion validated and host-applied, in memory only (never persisted with its content). It is the
   * approved change only when `state` is `completed`; the primary workspace is never modified by the workflow.
   */
  readonly changeSet?: ChangeSet;
  /** The host application ledger of `changeSet`: hashes and sizes, never content. */
  readonly applied?: readonly AppliedOperation[];
  /** Fusion-observed paths changed in the last candidate. */
  readonly changedPaths?: readonly string[];
  readonly verification?: VerificationVerdict;
  /** v0.4: the checks on the unchanged baseline, when the request asked for a reproduction. */
  readonly reproduction?: ReproductionRecord;
  readonly error?: FusionError;
  readonly pendingStage?: PendingStage;
  readonly delegateAttempts: number;
  /** Fresh review cycles, in order. Empty when no fresh review ran. */
  readonly reviews: readonly ReviewCycleRecord[];
  /** Private candidates created and whether every one was released completely. Absent when none existed. */
  readonly cleanup?: Readonly<{ candidates: number; released: number; complete: boolean }>;
  /** Provider views created and whether every one was released completely. Absent when none existed. */
  readonly providerViews?: Readonly<{ created: number; released: number; complete: boolean }>;
}
