import type { AdjudicatedFinding, AgentRole, DelegationPacket, Finding, FusionError, ResultPacket, RunId,
  VerificationPlan } from "../domain.js";
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
export type WorkflowEvent =
  | Readonly<{ type: "transition"; transition: Transition }>
  | Readonly<{ type: "risk"; level: RiskLevel; decisive: readonly string[]; revision: number }>
  | Readonly<{ type: "reviewCycle"; phase: "started" | "completed"; cycle: number; outcome?: ReviewCycleOutcome }>
  | Readonly<{ type: "review"; phase: "started" | "completed"; cycle: number; findingCount?: number }>
  | Readonly<{ type: "finding"; cycle: number; finding: Finding }>
  | Readonly<{ type: "adjudication"; cycle: number; record: AdjudicatedFinding }>;
/** Receives provider-neutral workflow events in order; a failed append stops the workflow. */
export interface EventSink { append(event: WorkflowEvent): Promise<void> }

/** Session workspace identifier for read-only roles attached to the primary workspace. Never a writer's. */
export const PRIMARY_WORKSPACE = "primary";
/** An isolated writer workspace. Never the primary workspace. */
export interface WorkspaceHandle {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly path: string;
}
export interface WorkspacePort {
  /** Absolute path of the user's primary workspace. */
  readonly primaryRoot: string;
  /** Absolute directory dedicated to leases; every writer path must lie strictly inside it. */
  readonly leaseRoot: string;
  /** A fresh isolated writer workspace owned exclusively by `ownerId`. */
  acquire(ownerId: string, signal?: AbortSignal): Promise<WorkspaceHandle>;
  /** Repository-relative paths changed in the lease relative to its base, including untracked files. */
  changedPaths(handle: WorkspaceHandle, signal?: AbortSignal): Promise<readonly string[]>;
  /** Content fingerprint of a lease, or of the primary workspace when `handle` is undefined. */
  fingerprint(handle: WorkspaceHandle | undefined, signal?: AbortSignal): Promise<string>;
  /** Bounded textual diff of a lease against its base, including untracked files, for review evidence. */
  diff(handle: WorkspaceHandle, signal?: AbortSignal): Promise<Readonly<{ text: string; truncated: boolean }>>;
}
/** Fusion-observed verification. Agent-reported checks never reach this port. */
export interface VerificationVerdict {
  readonly passed: boolean;
  /** Commands Fusion actually executed. A pass requires every planned command. */
  readonly commandsRun: number;
  readonly failedCommand?: string;
  readonly failure?: FusionError;
}
export interface VerifierPort {
  verify(plan: VerificationPlan, workspaceRoot: string, signal?: AbortSignal): Promise<VerificationVerdict>;
}

export interface WorkflowConfig {
  /** Role → provider/model configuration, in preference order. The engine never interprets these identities. */
  readonly roles: readonly RoleCandidate[];
  readonly workspace: WorkspacePort;
  readonly verifier: VerifierPort;
  readonly events?: EventSink;
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
  /** Writer workspace, kept for integration or inspection; the engine never discards writer work. */
  readonly lease?: WorkspaceHandle;
  /** The Lead's structured plan (medium and above). */
  readonly plan?: ResultPacket;
  /** Last structured delegate result. Its verification fields are claims, never evidence. */
  readonly result?: ResultPacket;
  /** Fusion-observed paths changed in the lease. */
  readonly changedPaths?: readonly string[];
  readonly verification?: VerificationVerdict;
  readonly error?: FusionError;
  readonly pendingStage?: PendingStage;
  readonly delegateAttempts: number;
  /** Fresh review cycles, in order. Empty when no fresh review ran. */
  readonly reviews: readonly ReviewCycleRecord[];
}
