import type { AdjudicationVerdict, AgentRole, AuthLane, CapabilitySnapshot, FindingConfidence, FindingSeverity, ProviderUsage,
  RequiredAction, WorkspacePosture } from "../../core/domain.js";
import type { RiskLevel } from "../../core/policy/risk.js";
import type { ReviewCycleOutcome, TransitionReason, WorkflowState } from "../../core/workflow/types.js";
import type { STORAGE_SCHEMA_VERSION } from "./shared.js";

export type Risk = "low" | "medium" | "high" | "critical" | "unknown";
/** `pending`: the run stopped with work remaining (review, decision or human gate); it is not a completion. */
export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "pending";
export interface ProviderBindingRecord {
  readonly role: AgentRole;
  readonly providerId: string;
  readonly transportId: string;
  readonly requestedModel: string;
  readonly observedModel?: string;
  readonly capabilityRef?: string;
}
export interface RunManifest {
  readonly schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  readonly runId: string;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly status: RunStatus;
  readonly fusionVersion: string;
  readonly workspaceHash: string;
  readonly runtime: Readonly<{ platform: string; nodeVersion: string }>;
  readonly workflowId?: string;
  readonly taskClass?: string;
  readonly risk?: Risk;
  readonly providerBindings?: readonly ProviderBindingRecord[];
  readonly capabilityRefs?: readonly string[];
  readonly artifactRefs?: readonly string[];
  readonly termination?: Readonly<{ reason: "completed" | "failed" | "cancelled" | "timeout"; killedByFusion?: boolean }>;
  readonly verification?: Readonly<{ passes?: number; failures?: number }>;
}
export type ManifestUpdate = Partial<Pick<RunManifest, "status" | "completedAt" | "workflowId" | "taskClass" |
  "risk" | "providerBindings" | "capabilityRefs" | "artifactRefs" | "termination" | "verification">>;

/** Narrow persistence DTOs. These never contain raw auth, prompts, streams or env. */
export interface ProviderEvidence {
  readonly providerId: string;
  readonly transportId: string;
  readonly runtimeVersion?: string;
  readonly requestedModel: string;
  readonly observedModel?: string;
  readonly authLane?: AuthLane;
  readonly posture?: WorkspacePosture;
  readonly capability?: CapabilitySnapshot;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly termination?: "completed" | "failed" | "cancelled" | "timeout";
  readonly usage?: Pick<ProviderUsage, "inputTokens" | "outputTokens" | "estimatedListCostUsd" | "subscription">;
}
export interface ProcessEvidence {
  readonly executableName: string;
  readonly executableHash: string;
  readonly argumentFlags: readonly string[];
  readonly positionalArgumentCount: number;
  readonly cwdHash: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly cancellationReason?: string;
  readonly killedByFusion: boolean;
  readonly cleanup: "none" | "taskkill" | "directKill" | "processGroup" | "failed";
  readonly stdoutArtifactRef?: string;
  readonly stderrArtifactRef?: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export type VerificationEvidenceStatus = "passed" | "failed" | "timeout" | "cancelled" | "spawnFailure" |
  "mutationViolation" | "processError" | "evidenceFailure";
/** Fusion-observed verification outcome. Never contains stdout/stderr, argv values, env or full paths. */
export interface VerificationEvidence {
  readonly commandId: string;
  readonly status: VerificationEvidenceStatus;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly mutationPolicy: "readOnly" | "allowMutation";
  readonly mutated: boolean;
  readonly mutationProven: boolean;
  readonly changedPathCount: number;
  readonly durationMs: number;
  readonly stdoutArtifactRef?: string;
  readonly stderrArtifactRef?: string;
  readonly preStateArtifactRef?: string;
  readonly postStateArtifactRef?: string;
}

/** One workflow state transition: closed vocabularies only, never provider/model identities, paths or text. */
export interface WorkflowTransitionRecord {
  readonly from: WorkflowState;
  readonly to: WorkflowState;
  readonly reason: TransitionReason;
  readonly role?: AgentRole;
  readonly attempt?: number;
}
/** A risk assessment revision: the level and the signal codes that set it, never signal evidence text. */
export interface RiskAssessmentRecord {
  readonly level: RiskLevel;
  readonly decisive: readonly string[];
  readonly revision: number;
}

/** A recorded review finding: bounded labels only; the full redacted record is an optional artifact. */
export interface FindingEventRecord {
  readonly cycle: number;
  readonly findingId: string;
  readonly severity: FindingSeverity;
  readonly confidence: FindingConfidence;
  readonly category: string;
  readonly title: string;
  readonly file?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly artifactRef?: string;
}
/** Provenance of one structured review, adjudication or change-proposal turn; bounded, redacted labels only. */
export interface StructuredTurnEventRecord {
  readonly cycle: number;
  readonly kind: "review" | "adjudication" | "changeProposal";
  readonly role: AgentRole;
  readonly sessionId: string;
  readonly provider: string;
  readonly transport: string;
  readonly requestedModel: string;
  readonly observedModel: string;
}
/** Provenance of one packet turn (Lead plan, exploration, read-only delegate, Lead review). */
export interface AgentTurnEventRecord {
  readonly kind: "plan" | "exploration" | "delegate" | "leadReview";
  readonly attempt: number;
  readonly role: AgentRole;
  readonly sessionId: string;
  readonly provider: string;
  readonly transport: string;
  readonly requestedModel: string;
  readonly observedModel: string;
}
/** Fusion's decision about one Writer change proposal: counts only, never paths or content. */
export interface ChangeProposalEventRecord {
  readonly attempt: number;
  readonly outcome: "validated" | "malformed" | "rejected";
  readonly operations: number;
}
/** One lifecycle step of a private Writer candidate. */
export interface CandidateEventRecord {
  readonly attempt: number;
  readonly phase: "created" | "applied" | "preconditionFailed" | "released";
  readonly changedPaths?: number;
  readonly complete?: boolean;
}
/** One lifecycle step of a Fusion-owned provider view: its kind only, never its path or content. */
export interface ProviderViewEventRecord {
  readonly kind: "baseline" | "candidate" | "workingTree";
  readonly phase: "created" | "released";
  readonly complete?: boolean;
}
/** How one candidate verification ran (backend labels, acceptance, dependency identity key, per-command status). */
export interface CandidateVerificationEventRecord {
  readonly attempt: number;
  readonly passed: boolean;
  readonly commandsRun: number;
  readonly refusal?: string;
  readonly backendId?: string;
  readonly confinement?: string;
  readonly platformRequirement?: string;
  readonly acceptance?: "granted" | "offlineRehearsal";
  readonly dependencyKey?: string;
  readonly dependencyPrepared?: boolean;
  readonly dependencyCacheHit?: boolean;
  readonly commands?: readonly Readonly<{ id: string; status: string; exitCode: number | null }>[];
}
/** A recorded adjudication; the rationale lives only in the optional redacted artifact. */
export interface AdjudicationEventRecord {
  readonly cycle: number;
  readonly findingId: string;
  readonly verdict: AdjudicationVerdict;
  readonly requiredAction: RequiredAction;
  readonly verdictSource: "lead" | "fusionEvidence";
  readonly artifactRef?: string;
}

export type ArtifactKind = "text" | "json" | "jsonl" | "binary" | "copiedFile";
export interface ArtifactMetadata {
  readonly schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  readonly artifactId: string;
  readonly runId: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly relativePath: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly producer?: string;
  readonly sha256: string;
}

export type EventSource = "runtime" | "policy" | "provider" | "process" | "artifact" | "verification" | "review";
export type EventInput =
  | Readonly<{ type: "RunStarted"; source: EventSource; payload: { workflowId?: string; taskClass?: string; risk?: Risk } }>
  | Readonly<{ type: "RunCompleted"; source: EventSource; payload: { wallTimeMs?: number } }>
  | Readonly<{ type: "RunFailed"; source: EventSource; payload: { errorKind: string } }>
  | Readonly<{ type: "ProviderObserved"; source: EventSource; payload: { evidence: ProviderEvidence } }>
  | Readonly<{ type: "ProcessObserved"; source: EventSource; payload: { evidence: ProcessEvidence } }>
  | Readonly<{ type: "ArtifactStored"; source: EventSource; payload: { artifactId: string; kind: ArtifactKind; byteSize: number; sha256: string } }>
  | Readonly<{ type: "CapabilityObserved"; source: EventSource; payload: { capabilityRef: string; providerId: string } }>
  | Readonly<{ type: "VerificationObserved"; source: EventSource; payload: { evidence: VerificationEvidence } }>
  | Readonly<{ type: "WorkflowTransition"; source: EventSource; payload: WorkflowTransitionRecord }>
  | Readonly<{ type: "RiskAssessed"; source: EventSource; payload: RiskAssessmentRecord }>
  | Readonly<{ type: "ReviewCycleStarted"; source: EventSource; payload: { cycle: number } }>
  | Readonly<{ type: "ReviewCycleCompleted"; source: EventSource; payload: { cycle: number; outcome: ReviewCycleOutcome } }>
  | Readonly<{ type: "ReviewStarted"; source: EventSource; payload: { cycle: number } }>
  | Readonly<{ type: "ReviewCompleted"; source: EventSource; payload: { cycle: number; findingCount: number } }>
  | Readonly<{ type: "FindingRecorded"; source: EventSource; payload: FindingEventRecord }>
  | Readonly<{ type: "AdjudicationRecorded"; source: EventSource; payload: AdjudicationEventRecord }>
  | Readonly<{ type: "StructuredTurnObserved"; source: EventSource; payload: StructuredTurnEventRecord }>
  | Readonly<{ type: "AgentTurnObserved"; source: EventSource; payload: AgentTurnEventRecord }>
  | Readonly<{ type: "ChangeProposalRecorded"; source: EventSource; payload: ChangeProposalEventRecord }>
  | Readonly<{ type: "CandidateObserved"; source: EventSource; payload: CandidateEventRecord }>
  | Readonly<{ type: "CandidateVerificationObserved"; source: EventSource; payload: CandidateVerificationEventRecord }>
  | Readonly<{ type: "ProviderViewObserved"; source: EventSource; payload: ProviderViewEventRecord }>;
export type EventType = EventInput["type"];
export interface StoredEvent {
  readonly schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: EventType;
  readonly source: EventSource;
  readonly payload: EventInput["payload"];
}

export interface LocalRunMetrics {
  readonly schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  readonly runId: string;
  readonly success?: boolean;
  readonly wallTimeMs?: number;
  readonly risk?: Risk;
  readonly workflowId?: string;
  readonly providerRunCount?: number;
  readonly retries?: number;
  readonly takeovers?: number;
  readonly verificationFailures?: number;
  readonly humanInterventions?: number;
  readonly confirmedFindings?: number;
  readonly rejectedFindings?: number;
  readonly contextTransferredBytes?: number;
  readonly contextTransferredTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedListCostUsd?: number;
}
