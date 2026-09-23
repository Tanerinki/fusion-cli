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
/** `launchFlag`: a launch-time control Fusion applies; `runtimeReadback`: observed in a running session. */
export type CapabilityEvidenceSource = "launchFlag" | "runtimeReadback";
export interface WriterIsolationCapabilities {
  readonly workspaceScopedWrites: CapabilityState;
  readonly primaryWorkspaceInaccessible: CapabilityState;
  readonly gitPushDisabled: CapabilityState;
  readonly forcePushDisabled: CapabilityState;
  readonly credentialOverrideBlocked: CapabilityState;
  readonly boundedCommands: CapabilityState;
  readonly approvalPolicyKnown: CapabilityState;
  readonly processTreeSupervised: CapabilityState;
  readonly workspaceIdentityReadback: CapabilityState;
}
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
  readonly webToolsDisabledEvidence?: Readonly<{ source: CapabilityEvidenceSource; versionVerified: boolean }>;
  /** No provider approval path (prompt, auto-approval judge or approval mode) can widen the posture during a turn. */
  readonly approvalEscalationDisabled?: CapabilityState;
  /** Personal or foreign context (user memory files, personal instructions, other applications' context) is excluded. */
  readonly personalContextDisabled?: CapabilityState;
  /** Extension surfaces that could add tools, hooks or network reach (plugins, hooks, MCP servers) are quarantined. */
  readonly extensionsQuarantined?: CapabilityState;
  /**
   * How the posture facts were established. `launchFlag`: enforced by construction before any session, by fixed launch
   * controls Fusion applies on a verified runtime and re-checked before each turn. `runtimeReadback`: read back from a
   * running session. Descriptive only: routing consumes the facts themselves.
   */
  readonly postureEvidence?: Readonly<{ source: CapabilityEvidenceSource; versionVerified: boolean }>;
  readonly filesystem: Readonly<{ read: CapabilityState; write: CapabilityState }>;
  readonly shell: Readonly<{ available: CapabilityState; sandboxed: CapabilityState }>;
  readonly approvalCallback: CapabilityState;
  readonly protocolCancellation: CapabilityState;
  readonly usageReporting: CapabilityState;
  readonly modelIdentityReadback: CapabilityState;
  readonly subscriptionLaneReadback: CapabilityState;
  /** Separate, mechanically observed Writer posture; absent on all current real adapters. */
  readonly writerIsolation?: Readonly<WriterIsolationCapabilities>;
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
  | "webToolsDisabled"
  | "approvalEscalationDisabled"
  | "personalContextDisabled"
  | "extensionsQuarantined";
export type CapabilityRequirement = Readonly<Partial<Record<SimpleCapabilityKey, boolean>> & {
  readonly filesystem?: Readonly<Partial<Record<"read" | "write", boolean>>>;
  readonly shell?: Readonly<Partial<Record<"available" | "sandboxed", boolean>>>;
  readonly writerIsolation?: Readonly<Partial<Record<keyof WriterIsolationCapabilities, boolean>>>;
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
  /** Bounded error class/code of an unexpected underlying failure (e.g. `Error:EACCES`); never a message. */
  readonly causeCode?: string;
  /** Allowlisted provider failure metadata; never a raw provider message. */
  readonly providerDiagnostic?: Readonly<{
    provider: string;
    transport: string;
    classification: "schemaRejected" | "authorizationRejected" | "rateLimited" | "providerUnavailable" |
      "timeout" | "cancelled" | "providerFailure";
    httpStatus?: number;
  }>;
}

export interface TurnResultBase {
  readonly effectiveProvider: ProviderId;
  readonly effectiveModel: string;
  readonly usage?: ProviderUsage;
  readonly artifactRefs: readonly string[];
}
export type TurnResult = TurnResultBase & (
  | Readonly<{ status: "completed"; output: ResultPacket; error?: never }>
  | Readonly<{ status: "failed" | "cancelled"; output?: ResultPacket; error: FusionError }>
);

export const FINDING_SEVERITIES = ["BLOCKER", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_CONFIDENCES = ["HIGH", "MEDIUM", "LOW"] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];
export const ADJUDICATION_VERDICTS = ["CONFIRMED", "PARTIAL", "REJECTED", "UNVERIFIABLE"] as const;
export type AdjudicationVerdict = (typeof ADJUDICATION_VERDICTS)[number];
export const REQUIRED_ACTIONS = ["none", "fix", "followUp", "humanDecision"] as const;
export type RequiredAction = (typeof REQUIRED_ACTIONS)[number];

/**
 * A defect claim Fusion can check against its own observations. A fact Fusion confirms cannot be rejected by
 * assertion: `verificationCommand` claims that Fusion check does not pass, `outOfScopeChange` that the path changed
 * outside the delegated scope, `unrunClaim` that the implementer reported a check Fusion never ran.
 */
export type FindingFact =
  | Readonly<{ kind: "verificationCommand"; commandId: string }>
  | Readonly<{ kind: "outOfScopeChange"; path: string }>
  | Readonly<{ kind: "unrunClaim"; test: string }>;

/** One finding exactly as a Reviewer reports it; `id` is the Reviewer's key, unique within its report. */
export interface ReviewerFinding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly confidence: FindingConfidence;
  readonly category: string;
  readonly file?: string;
  readonly lines?: Readonly<{ start: number; end: number }>;
  readonly title: string;
  readonly evidence: readonly string[];
  /** A reproduction or realistic failure scenario. */
  readonly failureScenario: string;
  readonly suggestedFix?: string;
  readonly facts?: readonly FindingFact[];
}
/** A Reviewer's structured output. `summary` is informational; only `findings` carry authority. */
export interface ReviewReport {
  readonly findings: readonly ReviewerFinding[];
  readonly summary: string;
}
/** A validated finding with Fusion-assigned identity and provenance; the Reviewer cannot set either. */
export interface Finding extends Omit<ReviewerFinding, "id" | "facts"> {
  /** Deterministic within one review result: `r<cycle>-<reviewer key>`. */
  readonly id: string;
  readonly facts: readonly FindingFact[];
  readonly source: Readonly<{ role: AgentRole; runId: RunId; sessionId: SessionId; cycle: number }>;
}
export interface FindingAdjudication {
  readonly findingId: string;
  readonly verdict: AdjudicationVerdict;
  readonly rationale: string;
  readonly requiredAction: RequiredAction;
}
/** The Lead's structured output: exactly one adjudication per finding it was given. */
export interface AdjudicationReport {
  readonly adjudications: readonly FindingAdjudication[];
  readonly summary: string;
}
/** The persisted record. `verdictSource` is `fusionEvidence` when Fusion's own facts overrode the Lead. */
export interface AdjudicatedFinding {
  readonly finding: Finding;
  readonly verdict: AdjudicationVerdict;
  readonly rationale: string;
  readonly requiredAction: RequiredAction;
  readonly verdictSource: "lead" | "fusionEvidence";
  readonly supportedFacts: readonly FindingFact[];
}

/**
 * Bounded evidence for review and adjudication. It is built by Fusion from the caller's packet and Fusion's own
 * observations; it never contains transcripts, the implementer's self-report or rationale, or Lead reasoning.
 */
export interface ReviewEvidence {
  readonly task: Task;
  readonly architecture: Readonly<{ decisions: readonly string[]; invariants: readonly string[] }>;
  readonly scope: Readonly<{ relevantFiles: readonly string[]; allowedFiles: readonly string[]; forbiddenFiles: readonly string[] }>;
  readonly verification: Readonly<{ required: boolean; passed: boolean;
    commands: readonly Readonly<{ id: string; passed: boolean }>[] }>;
  /** `diff`: Fusion-observed change of a writer's lease. `answer`: the deliverable of a read-only task. */
  readonly change: Readonly<{ kind: "diff" | "answer"; changedPaths: readonly string[]; text: string; truncated: boolean }>;
}
export interface ReviewRequest {
  readonly kind: "review";
  readonly cycle: number;
  readonly evidence: ReviewEvidence;
  /** Findings accepted in the previous cycle, present only on a re-review after a corrective attempt. */
  readonly priorFindings: readonly Finding[];
  readonly limits: Readonly<{ maxFindings: number }>;
}
export interface AdjudicationRequest {
  readonly kind: "adjudication";
  readonly cycle: number;
  readonly evidence: ReviewEvidence;
  readonly findings: readonly Finding[];
  /** Fusion's own evaluation of each finding's checkable facts. */
  readonly fusionFacts: readonly Readonly<{ findingId: string; supported: readonly FindingFact[];
    contradicted: readonly FindingFact[] }>[];
}
export type StructuredTurnRequest = ReviewRequest | AdjudicationRequest;
/** Output is untrusted until the core validates it for the request's kind. */
export type StructuredTurnResult = TurnResultBase & (
  | Readonly<{ status: "completed"; output: unknown; error?: never }>
  | Readonly<{ status: "failed" | "cancelled"; output?: never; error: FusionError }>
);

/** One explicit verification step: an absolute native executable and an argv array, never a shell string. */
export interface VerificationCommand {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  /** Relative to the verified workspace root (`.` for the root); absolute paths and `..` are refused. */
  readonly cwd: string;
  readonly timeoutMs: number;
  /** `readOnly`: any tracked or untracked change to the workspace is a policy failure, even on exit 0. */
  readonly mutationPolicy: "readOnly" | "allowMutation";
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
  /**
   * Structured review/adjudication turn. Optional: an adapter without it is ineligible for roles that need it
   * (fresh Reviewer, adjudicating Lead), so routing fails closed rather than falling back.
   */
  runStructuredTurn?(session: Session, request: StructuredTurnRequest, signal?: AbortSignal): Promise<StructuredTurnResult>;
  cancel(session: Session): Promise<void>;
  usage(session: Session): Promise<ProviderUsage | null>;
  close(session: Session): Promise<void>;
}
