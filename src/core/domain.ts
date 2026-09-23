/** Provider-neutral contracts. Provider-specific wire shapes belong in adapters. */

export const AGENT_ROLES = ["Lead", "Worker", "Explorer", "Reviewer", "Auditor"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export type ProviderId = string;
export type TransportId = string;
export type RunId = string;
export type StepId = string;
export type SessionId = string;
export type WorkspaceLeaseId = string;

export interface ModelProfile {
  readonly id: string;
  readonly effort: string;
  readonly maxTurns?: number;
}

export type CapabilityState = boolean | "unknown";
export interface CapabilitySnapshot {
  readonly provider: ProviderId;
  readonly transport: TransportId;
  readonly observedAt: string;
  readonly runtimeVersion: string;
  readonly schemaFingerprint?: string;
  readonly persistentSessions: CapabilityState;
  readonly structuredOutput: CapabilityState;
  /** Whether host mechanics disable model-facing web tools for this transport. */
  readonly webToolsDisabled?: CapabilityState;
  /** Provenance for a security-sensitive web disable claim. */
  readonly webToolsDisabledEvidence?: Readonly<{ source: "launchFlag" | "runtimeReadback"; versionVerified: boolean }>;
  readonly filesystem: Readonly<{ read: CapabilityState; write: CapabilityState }>;
  readonly shell: Readonly<{ available: CapabilityState; sandboxed: CapabilityState }>;
  readonly approvalCallback: CapabilityState;
  readonly protocolCancellation: CapabilityState;
  readonly usageReporting: CapabilityState;
  readonly modelIdentityReadback: CapabilityState;
  readonly subscriptionLaneReadback: CapabilityState;
}

/** A requirement is satisfied only by an observed true capability. */
type SimpleCapabilityKey =
  | "persistentSessions"
  | "structuredOutput"
  | "approvalCallback"
  | "protocolCancellation"
  | "usageReporting"
  | "modelIdentityReadback"
  | "subscriptionLaneReadback"
  | "webToolsDisabled";
export type CapabilityRequirement = Readonly<Partial<Record<SimpleCapabilityKey, boolean>> & {
  readonly filesystem?: Readonly<Partial<Record<"read" | "write", boolean>>>;
  readonly shell?: Readonly<Partial<Record<"available" | "sandboxed", boolean>>>;
}>;

export interface RoleBinding {
  readonly role: AgentRole;
  readonly provider: ProviderId;
  readonly model: ModelProfile;
  readonly transport: TransportId;
  readonly requires: CapabilityRequirement;
}

export type AuthLane = "subscription" | "subscriptionToken" | "api" | "thirdParty" | "unknown";
interface AuthStatusBase {
  readonly observedAt: string;
  readonly evidence: readonly string[];
}
export type AuthStatus = AuthStatusBase & (
  | Readonly<{ state: "authenticated"; lane: Exclude<AuthLane, "unknown"> }>
  | Readonly<{ state: "unauthenticated" | "ambiguous"; lane: "unknown" }>
);

export type WorkspacePosture = "readOnly" | "writer";
export interface Session {
  readonly id: SessionId;
  readonly runId: RunId;
  readonly role: AgentRole;
  readonly provider: ProviderId;
  readonly transport: TransportId;
  readonly workspaceLeaseId: WorkspaceLeaseId;
  readonly posture: WorkspacePosture;
  readonly providerSessionRef: string;
}

export interface Task {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

export interface DelegationPacket {
  readonly task: Task;
  readonly scope: Readonly<{
    relevantFiles: readonly string[];
    allowedFiles: readonly string[];
    forbiddenFiles: readonly string[];
  }>;
  readonly architecture: Readonly<{
    decisions: readonly string[];
    invariants: readonly string[];
  }>;
  readonly verification: Readonly<{ requiredTests: readonly string[] }>;
  readonly openQuestions: readonly string[];
}

export type PacketStatus = "completed" | "partial" | "blocked" | "failed";
export interface ResultPacket {
  readonly result: Readonly<{ status: PacketStatus }>;
  readonly changes: Readonly<{ files: readonly string[]; summary: string }>;
  /** Model-reported checks are claims; only VerificationResult has verifier authority. */
  readonly verification: Readonly<{ testsRun: readonly string[]; results: readonly string[] }>;
  readonly uncertainties: readonly string[];
  readonly failures: readonly string[];
  readonly needsLeadDecision: readonly string[];
}

export type TurnStatus = "completed" | "failed" | "cancelled";
export interface ProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedListCostUsd?: number;
  readonly rawUsageArtifact?: string;
  /** Point-in-time subscription quota telemetry, never a billed cost. */
  readonly subscription?: Readonly<{
    tier: string;
    observedAtMs: number;
    window: Readonly<{ usedPercent: number; resetsAtMs: number; windowDurationMins: number }>;
    weekly: Readonly<{ usedPercent: number; resetsAtMs: number }>;
  }>;
}

export type FusionErrorKind =
  | "InvalidInput"
  | "CapabilityUnavailable"
  | "BillingBlocked"
  | "AuthMismatch"
  | "ProviderIdentityMismatch"
  | "SecurityViolation"
  | "SpawnFailure"
  | "Timeout"
  | "Cancelled"
  | "ProcessFailure"
  | "ProtocolError"
  | "MalformedOutput"
  | "VerificationFailure"
  | "WorkspaceConflict"
  | "InternalError";

export interface FusionError {
  readonly kind: FusionErrorKind;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly runId?: RunId;
  readonly stepId?: StepId;
  readonly evidenceArtifact?: string;
}

interface TurnResultBase {
  readonly effectiveProvider: ProviderId;
  readonly effectiveModel: string;
  readonly usage?: ProviderUsage;
  readonly artifactRefs: readonly string[];
}
export type TurnResult = TurnResultBase & (
  | Readonly<{ status: "completed"; output: ResultPacket; error?: never }>
  | Readonly<{ status: "failed" | "cancelled"; output?: ResultPacket; error: FusionError }>
);

export interface Finding {
  readonly id: string;
  readonly severity: "info" | "low" | "medium" | "high" | "critical";
  readonly confidence: number;
  readonly category: string;
  readonly file?: string;
  readonly lines?: Readonly<{ start: number; end: number }>;
  readonly claim: string;
  readonly evidence: readonly string[];
  readonly reproduction?: string;
  readonly realisticFailureScenario?: string;
  readonly suggestedFix?: string;
  readonly sourceProvider: ProviderId;
  readonly sourceModel: string;
  readonly sourceSession: SessionId;
  readonly sourceRun: RunId;
  readonly verdict?: "CONFIRMED" | "PARTIAL" | "REJECTED" | "UNVERIFIABLE";
}

export interface VerificationCommand {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}
export interface VerificationPlan {
  readonly commands: readonly VerificationCommand[];
}
interface VerificationResultBase {
  readonly commandId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly stdoutArtifact: string;
  readonly stderrArtifact: string;
  readonly preDiffArtifact: string;
  readonly postDiffArtifact: string;
  readonly mutatedRepository: boolean;
}
export type VerificationResult = VerificationResultBase & (
  | Readonly<{ passed: true; exitCode: 0 }>
  | Readonly<{ passed: false; exitCode: number | null }>
);

export type RunEventKind =
  | "task" | "policy" | "capability" | "process" | "agent"
  | "verification" | "finding" | "adjudication" | "metric" | "run";
export interface RunEvent {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly stepId?: StepId;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly kind: RunEventKind;
  /** The event writer must redact this before persistence. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RunMetrics {
  readonly taskSucceeded: boolean;
  readonly wallTimeMs: number;
  readonly roleAssignments: Readonly<Partial<Record<AgentRole, number>>>;
  readonly agentRuns: number;
  readonly turns: number;
  readonly contextBytesTransferred: number;
  readonly verificationPasses: number;
  readonly verificationFailures: number;
  readonly findings: number;
  readonly confirmedFindings: number;
  readonly workerRework: number;
  readonly leadTakeovers: number;
  readonly humanInterventions: number;
  readonly retries: number;
  readonly usage: readonly ProviderUsage[];
}

export interface ProviderAdapter {
  capabilities(): Promise<CapabilitySnapshot>;
  authStatus(): Promise<AuthStatus>;
  createSession(request: Readonly<{
    runId: RunId; role: AgentRole; workspaceLeaseId: WorkspaceLeaseId;
    posture: WorkspacePosture; model: ModelProfile;
  }>): Promise<Session>;
  resumeSession(session: Session): Promise<Session>;
  runTurn(session: Session, packet: DelegationPacket, signal?: AbortSignal): Promise<TurnResult>;
  cancel(session: Session): Promise<void>;
  usage(session: Session): Promise<ProviderUsage | null>;
  close(session: Session): Promise<void>;
}
