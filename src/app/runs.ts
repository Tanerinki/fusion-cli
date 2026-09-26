import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decisionRequestOf, parseDecisionRequest, type DecisionRequest } from "../core/workflow/decision.js";
import type { WorkflowResult } from "../core/workflow/types.js";
import type { DiagnosticRedactor } from "../core/policy/redaction.js";
import type { RiskAssessment } from "../core/policy/risk.js";
import type { ArtifactStore } from "../platform/events/artifact-store.js";
import { EventStore } from "../platform/events/event-store.js";
import { RunStore } from "../platform/events/run-store.js";
import type { RunStatus, StoredEvent } from "../platform/events/types.js";
import { EventStoreWorkflowSink } from "../platform/workflow/ports.js";
import { UNFINISHED_STATES, type CommandOutcome, type DisplayState } from "./outcome.js";

const MANIFEST_STATUS: Readonly<Record<DisplayState, RunStatus>> = {
  COMPLETED: "completed", ANSWERED: "completed", REVIEW_REQUIRED: "pending", DECISION_REQUIRED: "pending",
  HUMAN_GATE_REQUIRED: "pending", CANCELLED: "cancelled", FAILED: "failed", TIMED_OUT: "failed", BLOCKED: "failed",
};
const TERMINATION: Readonly<Partial<Record<DisplayState, "completed" | "failed" | "cancelled" | "timeout">>> = {
  COMPLETED: "completed", ANSWERED: "completed", CANCELLED: "cancelled", FAILED: "failed", TIMED_OUT: "timeout", BLOCKED: "failed",
};

/**
 * Persistence for one command run. The outcome is written (artifact, closing event, manifest status) before the command
 * returns, so nothing is reported that is not recorded. Unfinished runs are `pending`, never `completed`.
 */
export class RunRecorder {
  private constructor(readonly store: RunStore, readonly events: EventStore, readonly artifacts: ArtifactStore) {}
  get runId(): string { return this.store.runId; }

  static async start(repositoryRoot: string, command: "review" | "build", redactor: DiagnosticRedactor,
    options: Readonly<{ task?: string }> = {}): Promise<RunRecorder> {
    const store = await RunStore.create(repositoryRoot, { workflowId: command }, redactor);
    const events = await store.openEvents(), artifacts = await store.openArtifacts();
    await events.append({ type: "RunStarted", source: "runtime", payload: { workflowId: command } });
    // v0.1: the HUMAN's task, recorded first (so even an interrupted run says what it was for): a bounded, redacted summary
    // and the digest of the full text. Never provider text.
    if (options.task !== undefined) await artifacts.storeJson(taskRecord(options.task), TASK_PRODUCER);
    return new RunRecorder(store, events, artifacts);
  }
  sink(): EventStoreWorkflowSink { return new EventStoreWorkflowSink(this.events, this.artifacts); }

  /** Risk assessed by the control plane itself (build requests that never reach the workflow engine). */
  async recordRisk(risk: RiskAssessment): Promise<void> {
    await this.events.append({ type: "RiskAssessed", source: "policy",
      payload: { level: risk.level, decisive: risk.decisive.slice(0, 32), revision: risk.revision } });
  }

  async finish(outcome: CommandOutcome, extras: Readonly<{ result?: WorkflowResult; risk?: RiskAssessment;
    details?: Readonly<Record<string, unknown>> }> = {}): Promise<void> {
    // v0.1: a decision a role requested is kept as its bounded, structured request (never the packet or any other text).
    const decision = extras.result === undefined ? undefined : decisionRequestOf(extras.result);
    const record = { state: outcome.state, code: outcome.code, message: outcome.message, ...(decision === undefined ? {} : { decision }),
      ...(outcome.pendingStage === undefined ? {} : { pendingStage: outcome.pendingStage }),
      ...(outcome.error === undefined ? {} : { error: { kind: outcome.error.kind, message: outcome.error.safeMessage } }),
      ...(extras.result === undefined ? {} : { workflowState: extras.result.state, delegateAttempts: extras.result.delegateAttempts,
        reviewCycles: extras.result.reviews.map(cycle => ({ cycle: cycle.cycle, outcome: cycle.outcome, findings: cycle.findings.length })) }),
      ...(extras.details === undefined ? {} : { details: extras.details }) };
    const artifact = await this.artifacts.storeJson(record, "fusion:outcome");
    if (outcome.state === "COMPLETED" || outcome.state === "ANSWERED")
      await this.events.append({ type: "RunCompleted", source: "runtime", payload: {} });
    else if (!UNFINISHED_STATES.has(outcome.state))
      await this.events.append({ type: "RunFailed", source: "runtime", payload: { errorKind: outcome.error?.kind ?? "CapabilityUnavailable" } });
    const risk = extras.result?.risk ?? extras.risk;
    const termination = TERMINATION[outcome.state];
    await this.store.updateManifest({ status: MANIFEST_STATUS[outcome.state],
      ...(MANIFEST_STATUS[outcome.state] === "pending" ? {} : { completedAt: new Date().toISOString() }),
      ...(risk === undefined ? {} : { risk: risk.level }), artifactRefs: [artifact.artifactId],
      ...(termination === undefined ? {} : { termination: { reason: termination } }) });
  }
}

export const TASK_PRODUCER = "fusion:task";
export const TASK_SUMMARY_CHARS = 200;
export interface RunTask { readonly summary: string; readonly truncated: boolean; readonly sha256: string }
function taskRecord(task: string): RunTask {
  const flat = task.replace(/\s+/gu, " ").trim();
  return { summary: flat.length > TASK_SUMMARY_CHARS ? `${flat.slice(0, TASK_SUMMARY_CHARS - 1)}…` : flat, truncated: flat.length > TASK_SUMMARY_CHARS,
    sha256: createHash("sha256").update(task, "utf8").digest("hex") };
}

export interface RunSummary {
  readonly runId: string;
  readonly command: string;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly risk?: string;
  readonly outcome?: Readonly<Record<string, unknown>>;
  readonly finalWorkflowState?: string;
  readonly transitions: number;
  /** v0.1: the provider model turns the run's evidence records (structured and agent turns; conversation turns are not runs). */
  readonly modelTurns: number;
  readonly findings: readonly Readonly<{ id: string; severity: string; title: string; verdict?: string }>[];
  readonly eventLog: "complete" | "truncated";
  /** v0.1: the human's task as recorded at the start (bounded, redacted), when the run recorded one. */
  readonly task?: RunTask;
  /** v0.1: the delivery the run prepared (its id), or that it was an offline rehearsal (never delivered). */
  readonly deliveryId?: string;
  readonly offlineRehearsal?: boolean;
  /** v0.1: the bounded decision request a role made, when the run stopped for one. */
  readonly decision?: DecisionRequest;
}
/** A bounded, redacted run summary from persisted evidence. Raw artifacts are never printed. */
export async function summarizeRun(repositoryRoot: string, runId: string, redactor: DiagnosticRedactor): Promise<RunSummary> {
  const store = await RunStore.open(repositoryRoot, runId, redactor);
  const manifest = await store.readManifest();
  const findings = new Map<string, { id: string; severity: string; title: string; verdict?: string }>();
  let finalState: string | undefined, transitions = 0, truncated = false, count = 0, modelTurns = 0;
  // Read through the validating reader (never the appender), so a truncated log is summarized, not refused.
  for await (const item of EventStore.read(store.directory, runId)) {
    if ("diagnostic" in item) { truncated = true; break; }
    if (++count > 10_000) break;
    const event: StoredEvent = item.event;
    const payload = event.payload as Record<string, unknown>;
    if (event.type === "WorkflowTransition") { transitions++; finalState = String(payload.to); }
    if (event.type === "StructuredTurnObserved" || event.type === "AgentTurnObserved") modelTurns++;
    if (event.type === "FindingRecorded")
      findings.set(String(payload.findingId), { id: String(payload.findingId), severity: String(payload.severity), title: String(payload.title) });
    if (event.type === "AdjudicationRecorded") {
      const entry = findings.get(String(payload.findingId));
      if (entry) entry.verdict = String(payload.verdict);
    }
  }
  let outcome: Record<string, unknown> | undefined, task: RunTask | undefined;
  const ref = manifest.artifactRefs?.[0];
  const artifacts = await store.openArtifacts();
  if (ref !== undefined) {
    try { outcome = JSON.parse(await readFile(await artifacts.getArtifactPath(ref), "utf8")) as Record<string, unknown>; }
    catch { outcome = undefined; }
  }
  try {
    const recorded = (await artifacts.listMetadata(64)).find(entry => entry.producer === TASK_PRODUCER && entry.kind === "json" && entry.byteSize <= 4096);
    if (recorded !== undefined) {
      const value = JSON.parse(await readFile(await artifacts.getArtifactPath(recorded.artifactId), "utf8")) as Record<string, unknown>;
      if (typeof value.summary === "string" && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.sha256))
        task = { summary: value.summary.slice(0, TASK_SUMMARY_CHARS), truncated: value.truncated === true, sha256: value.sha256 };
    }
  } catch { task = undefined; }
  const details = (outcome?.details ?? {}) as Record<string, unknown>;
  const delivery = details.delivery as Record<string, unknown> | undefined;
  const deliveryId = typeof delivery?.id === "string" && /^d-[0-9a-f]{24}$/u.test(delivery.id) ? delivery.id : undefined;
  const decision = parseDecisionRequest(outcome?.decision);
  return { runId, command: manifest.workflowId ?? "unknown", status: manifest.status, createdAt: manifest.createdAt,
    ...(manifest.completedAt === undefined ? {} : { completedAt: manifest.completedAt }),
    ...(manifest.risk === undefined ? {} : { risk: manifest.risk }), ...(outcome === undefined ? {} : { outcome }),
    ...(finalState === undefined ? {} : { finalWorkflowState: finalState }), transitions, modelTurns,
    findings: [...findings.values()], eventLog: truncated ? "truncated" : "complete", ...(task === undefined ? {} : { task }),
    ...(deliveryId === undefined ? {} : { deliveryId }), ...(details.offlineRehearsal === true ? { offlineRehearsal: true } : {}),
    ...(decision === undefined ? {} : { decision }) };
}
