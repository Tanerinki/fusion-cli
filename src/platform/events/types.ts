import type { AgentRole, AuthLane, CapabilitySnapshot, ProviderUsage, WorkspacePosture } from "../../core/domain.js";
import type { STORAGE_SCHEMA_VERSION } from "./shared.js";

export type Risk = "low" | "medium" | "high" | "critical" | "unknown";
export type RunStatus = "running" | "completed" | "failed" | "cancelled";
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

export type EventSource = "runtime" | "policy" | "provider" | "process" | "artifact" | "verification";
export type EventInput =
  | Readonly<{ type: "RunStarted"; source: EventSource; payload: { workflowId?: string; taskClass?: string; risk?: Risk } }>
  | Readonly<{ type: "RunCompleted"; source: EventSource; payload: { wallTimeMs?: number } }>
  | Readonly<{ type: "RunFailed"; source: EventSource; payload: { errorKind: string } }>
  | Readonly<{ type: "ProviderObserved"; source: EventSource; payload: { evidence: ProviderEvidence } }>
  | Readonly<{ type: "ProcessObserved"; source: EventSource; payload: { evidence: ProcessEvidence } }>
  | Readonly<{ type: "ArtifactStored"; source: EventSource; payload: { artifactId: string; kind: ArtifactKind; byteSize: number; sha256: string } }>
  | Readonly<{ type: "CapabilityObserved"; source: EventSource; payload: { capabilityRef: string; providerId: string } }>
  | Readonly<{ type: "VerificationObserved"; source: EventSource; payload: { evidence: VerificationEvidence } }>;
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
