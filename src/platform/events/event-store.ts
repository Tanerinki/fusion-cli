import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ADJUDICATION_VERDICTS, AGENT_ROLES, FINDING_CONFIDENCES, FINDING_SEVERITIES, REQUIRED_ACTIONS,
  type AdjudicationVerdict, type AgentRole, type FindingConfidence, type FindingSeverity, type RequiredAction } from "../../core/domain.js";
import { DECISIONS, OBLIGATION_KINDS, OBLIGATION_STATUSES, TASK_CLASSES } from "../../core/evidence/obligations.js";
import { DiagnosticRedactor } from "../../core/policy/redaction.js";
import { RISK_LEVELS, type RiskLevel } from "../../core/policy/risk.js";
import { REPRODUCTION_UNAVAILABLE, TRANSITION_REASONS, VERIFICATION_REFUSALS, WORKFLOW_STATES, type ReviewCycleOutcome, type TransitionReason,
  type WorkflowState } from "../../core/workflow/types.js";
import { errorKind, projectProcessEvidence, projectProviderEvidence, projectVerificationEvidence } from "./evidence.js";
import { STORAGE_SCHEMA_VERSION, assertId, enqueuePath, finiteNonnegative, isRecord, makeId, readJsonl,
  safeShortText, safeTimestamp, schemaVersion, StorageError } from "./shared.js";
import type { ArtifactKind, EventInput, EventSource, EventType, ProcessEvidence, ProviderEvidence, Risk, StoredEvent,
  VerificationEvidence } from "./types.js";

const eventTypes = new Set<EventType>(["RunStarted", "RunCompleted", "RunFailed", "ProviderObserved",
  "ProcessObserved", "ArtifactStored", "CapabilityObserved", "VerificationObserved", "WorkflowTransition", "RiskAssessed",
  "ReviewCycleStarted", "ReviewCycleCompleted", "ReviewStarted", "ReviewCompleted", "FindingRecorded", "AdjudicationRecorded",
  "StructuredTurnObserved", "AgentTurnObserved", "ChangeProposalRecorded", "CandidateObserved", "CandidateVerificationObserved",
  "ProviderViewObserved", "ReproductionObserved", "EvidenceDecisionRecorded"]);
const providerViewKinds = new Set<unknown>(["baseline", "candidate", "workingTree", "folder"]);
const providerViewPhases = new Set<unknown>(["created", "released"]);
const structuredTurnKinds = new Set<unknown>(["review", "adjudication", "changeProposal"]);
const agentTurnKinds = new Set<unknown>(["plan", "exploration", "delegate", "leadReview"]);
const proposalOutcomes = new Set<unknown>(["validated", "malformed", "rejected"]);
const candidatePhases = new Set<unknown>(["created", "applied", "preconditionFailed", "released"]);
const verificationRefusals = new Set<unknown>(VERIFICATION_REFUSALS);
const acceptances = new Set<unknown>(["granted", "offlineRehearsal"]);
const reproductionReasons = new Set<unknown>(REPRODUCTION_UNAVAILABLE);
const decisions = new Set<unknown>(DECISIONS), taskClasses = new Set<unknown>(TASK_CLASSES), obligationKinds = new Set<unknown>(OBLIGATION_KINDS);
const obligationStatuses = new Set<unknown>(OBLIGATION_STATUSES), obligationTiers = new Set<unknown>(["safety", "correctness"]);
/** Backend, platform, status and dependency-key labels: short, single-token, never a path. */
const EVIDENCE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const attemptNumber = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 16)
    throw new StorageError("StorageError", "Invalid Writer attempt.");
  return value as number;
};
const count = (value: unknown, max: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max)
    throw new StorageError("StorageError", "Invalid event count.");
  return value as number;
};
const evidenceLabel = (value: unknown): string => {
  if (typeof value !== "string" || !EVIDENCE_LABEL.test(value)) throw new StorageError("StorageError", "Invalid evidence label.");
  return value;
};
const optionalBoolean = (value: unknown): boolean | undefined => {
  if (value !== undefined && typeof value !== "boolean") throw new StorageError("StorageError", "Invalid event flag.");
  return value as boolean | undefined;
};
const sources = new Set<EventSource>(["runtime", "policy", "provider", "process", "artifact", "verification", "review"]);
const risks = new Set<Risk>(["low", "medium", "high", "critical", "unknown"]);
const artifactKinds = new Set(["text", "json", "jsonl", "binary", "copiedFile"]);
const workflowStates = new Set<unknown>(WORKFLOW_STATES), transitionReasons = new Set<unknown>(TRANSITION_REASONS);
const agentRoles = new Set<unknown>(AGENT_ROLES), riskLevels = new Set<unknown>(RISK_LEVELS);
const SIGNAL_CODE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/u;
const severities = new Set<unknown>(FINDING_SEVERITIES), confidences = new Set<unknown>(FINDING_CONFIDENCES);
const verdicts = new Set<unknown>(ADJUDICATION_VERDICTS), requiredActions = new Set<unknown>(REQUIRED_ACTIONS);
const cycleOutcomes = new Set<unknown>(["clean", "correction", "gate"]), verdictSources = new Set<unknown>(["lead", "fusionEvidence"]);
const FINDING_ID = /^r[0-9]{1,2}-[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u;
const cycleNumber = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 16)
    throw new StorageError("StorageError", "Invalid review cycle.");
  return value as number;
};
const findingId = (value: unknown): string => {
  if (typeof value !== "string" || !FINDING_ID.test(value)) throw new StorageError("StorageError", "Invalid finding ID.");
  return value;
};
const optionalLine = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000_000)
    throw new StorageError("StorageError", "Invalid finding line.");
  return value as number;
};
const label = (value: unknown, name: string, r: DiagnosticRedactor): string =>
  r.redactText(safeShortText(value, name));

/** Explicit projection is the persistence boundary; unknown payload keys are never serialized. */
function projectInput(input: EventInput, r: DiagnosticRedactor): EventInput {
  if (!isRecord(input) || !eventTypes.has(input.type) || !sources.has(input.source) || !isRecord(input.payload))
    throw new StorageError("StorageError", "Unsupported event input.");
  const p = input.payload as Record<string, unknown>;
  switch (input.type) {
    case "RunStarted": {
      if (p.risk !== undefined && !risks.has(p.risk as Risk))
        throw new StorageError("StorageError", "Invalid event risk.");
      return { type: input.type, source: input.source, payload: {
        ...(p.workflowId === undefined ? {} : { workflowId: label(p.workflowId, "workflow ID", r) }),
        ...(p.taskClass === undefined ? {} : { taskClass: label(p.taskClass, "task class", r) }),
        ...(p.risk === undefined ? {} : { risk: p.risk as Risk }) } };
    }
    case "RunCompleted":
      if (p.wallTimeMs !== undefined && !finiteNonnegative(p.wallTimeMs))
        throw new StorageError("StorageError", "Invalid event duration.");
      return { type: input.type, source: input.source, payload:
        p.wallTimeMs === undefined ? {} : { wallTimeMs: p.wallTimeMs as number } };
    case "RunFailed":
      return { type: input.type, source: input.source, payload: { errorKind: errorKind(p.errorKind) } };
    case "ProviderObserved":
      return { type: input.type, source: input.source,
        payload: { evidence: projectProviderEvidence(p.evidence as ProviderEvidence, r) } };
    case "ProcessObserved":
      return { type: input.type, source: input.source,
        payload: { evidence: projectProcessEvidence(p.evidence as ProcessEvidence, r) } };
    case "ArtifactStored": {
      assertId(p.artifactId, "a");
      if (!artifactKinds.has(p.kind as string) || !Number.isSafeInteger(p.byteSize) || !finiteNonnegative(p.byteSize) ||
          typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(p.sha256))
        throw new StorageError("StorageError", "Invalid artifact event.");
      return { type: input.type, source: input.source, payload: {
        artifactId: p.artifactId, kind: p.kind as ArtifactKind, byteSize: p.byteSize as number, sha256: p.sha256 } };
    }
    case "CapabilityObserved":
      return { type: input.type, source: input.source, payload: {
        capabilityRef: label(p.capabilityRef, "capability reference", r),
        providerId: label(p.providerId, "provider ID", r) } };
    case "VerificationObserved":
      return { type: input.type, source: input.source,
        payload: { evidence: projectVerificationEvidence(p.evidence as VerificationEvidence, r) } };
    case "WorkflowTransition":
      if (!workflowStates.has(p.from) || !workflowStates.has(p.to) || !transitionReasons.has(p.reason) ||
          (p.role !== undefined && !agentRoles.has(p.role)) ||
          (p.attempt !== undefined && (!Number.isSafeInteger(p.attempt) || (p.attempt as number) < 1 || (p.attempt as number) > 16)))
        throw new StorageError("StorageError", "Invalid workflow transition event.");
      return { type: input.type, source: input.source, payload: {
        from: p.from as WorkflowState, to: p.to as WorkflowState, reason: p.reason as TransitionReason,
        ...(p.role === undefined ? {} : { role: p.role as AgentRole }),
        ...(p.attempt === undefined ? {} : { attempt: p.attempt as number }) } };
    case "RiskAssessed":
      if (!riskLevels.has(p.level) || !Array.isArray(p.decisive) || p.decisive.length > 32 ||
          p.decisive.some(code => typeof code !== "string" || !SIGNAL_CODE.test(code)) ||
          !Number.isSafeInteger(p.revision) || (p.revision as number) < 0 || (p.revision as number) > 10_000)
        throw new StorageError("StorageError", "Invalid risk assessment event.");
      return { type: input.type, source: input.source, payload: {
        level: p.level as RiskLevel, decisive: [...(p.decisive as string[])], revision: p.revision as number } };
    case "ReviewCycleStarted": case "ReviewStarted":
      return { type: input.type, source: input.source, payload: { cycle: cycleNumber(p.cycle) } };
    case "ReviewCycleCompleted":
      if (!cycleOutcomes.has(p.outcome)) throw new StorageError("StorageError", "Invalid review cycle outcome.");
      return { type: input.type, source: input.source, payload: { cycle: cycleNumber(p.cycle), outcome: p.outcome as ReviewCycleOutcome } };
    case "ReviewCompleted":
      if (!Number.isSafeInteger(p.findingCount) || (p.findingCount as number) < 0 || (p.findingCount as number) > 64)
        throw new StorageError("StorageError", "Invalid review finding count.");
      return { type: input.type, source: input.source, payload: { cycle: cycleNumber(p.cycle), findingCount: p.findingCount as number } };
    case "FindingRecorded": {
      if (!severities.has(p.severity) || !confidences.has(p.confidence)) throw new StorageError("StorageError", "Invalid finding.");
      const lineStart = optionalLine(p.lineStart), lineEnd = optionalLine(p.lineEnd);
      if (p.artifactRef !== undefined) assertId(p.artifactRef, "a");
      return { type: input.type, source: input.source, payload: {
        cycle: cycleNumber(p.cycle), findingId: findingId(p.findingId), severity: p.severity as FindingSeverity,
        confidence: p.confidence as FindingConfidence, category: label(p.category, "finding category", r),
        title: r.redactText(safeShortText(p.title, "finding title", 200)),
        ...(p.file === undefined ? {} : { file: r.redactText(safeShortText(p.file, "finding file", 512)) }),
        ...(lineStart === undefined ? {} : { lineStart }), ...(lineEnd === undefined ? {} : { lineEnd }),
        ...(p.artifactRef === undefined ? {} : { artifactRef: p.artifactRef as string }) } };
    }
    case "AdjudicationRecorded":
      if (!verdicts.has(p.verdict) || !requiredActions.has(p.requiredAction) || !verdictSources.has(p.verdictSource))
        throw new StorageError("StorageError", "Invalid adjudication.");
      if (p.artifactRef !== undefined) assertId(p.artifactRef, "a");
      return { type: input.type, source: input.source, payload: {
        cycle: cycleNumber(p.cycle), findingId: findingId(p.findingId), verdict: p.verdict as AdjudicationVerdict,
        requiredAction: p.requiredAction as RequiredAction, verdictSource: p.verdictSource as "lead" | "fusionEvidence",
        ...(p.artifactRef === undefined ? {} : { artifactRef: p.artifactRef as string }) } };
    case "StructuredTurnObserved":
      if (!structuredTurnKinds.has(p.kind) || !agentRoles.has(p.role))
        throw new StorageError("StorageError", "Invalid structured turn provenance.");
      return { type: input.type, source: input.source, payload: {
        cycle: cycleNumber(p.cycle), kind: p.kind as "review" | "adjudication" | "changeProposal", role: p.role as AgentRole,
        sessionId: label(p.sessionId, "session ID", r), provider: label(p.provider, "provider ID", r),
        transport: label(p.transport, "transport ID", r), requestedModel: label(p.requestedModel, "requested model", r),
        observedModel: label(p.observedModel, "observed model", r) } };
    case "AgentTurnObserved":
      if (!agentTurnKinds.has(p.kind) || !agentRoles.has(p.role)) throw new StorageError("StorageError", "Invalid turn provenance.");
      return { type: input.type, source: input.source, payload: {
        kind: p.kind as "plan" | "exploration" | "delegate" | "leadReview", attempt: attemptNumber(p.attempt), role: p.role as AgentRole,
        sessionId: label(p.sessionId, "session ID", r), provider: label(p.provider, "provider ID", r),
        transport: label(p.transport, "transport ID", r), requestedModel: label(p.requestedModel, "requested model", r),
        observedModel: label(p.observedModel, "observed model", r) } };
    case "ChangeProposalRecorded":
      if (!proposalOutcomes.has(p.outcome)) throw new StorageError("StorageError", "Invalid change proposal outcome.");
      return { type: input.type, source: input.source, payload: { attempt: attemptNumber(p.attempt),
        outcome: p.outcome as "validated" | "malformed" | "rejected", operations: count(p.operations, 1_024) } };
    case "CandidateObserved": {
      if (!candidatePhases.has(p.phase)) throw new StorageError("StorageError", "Invalid candidate phase.");
      const complete = optionalBoolean(p.complete);
      return { type: input.type, source: input.source, payload: { attempt: attemptNumber(p.attempt),
        phase: p.phase as "created" | "applied" | "preconditionFailed" | "released",
        ...(p.changedPaths === undefined ? {} : { changedPaths: count(p.changedPaths, 10_000) }),
        ...(complete === undefined ? {} : { complete }) } };
    }
    case "ProviderViewObserved": {
      if (!providerViewKinds.has(p.kind) || !providerViewPhases.has(p.phase)) throw new StorageError("StorageError", "Invalid provider view.");
      const complete = optionalBoolean(p.complete);
      return { type: input.type, source: input.source, payload: { kind: p.kind as "baseline" | "candidate" | "workingTree" | "folder",
        phase: p.phase as "created" | "released", ...(complete === undefined ? {} : { complete }) } };
    }
    case "ReproductionObserved": {
      if (typeof p.ran !== "boolean" || (p.refusal !== undefined && !verificationRefusals.has(p.refusal)) ||
          (p.reason !== undefined && !reproductionReasons.has(p.reason)) || (p.acceptance !== undefined && !acceptances.has(p.acceptance)) ||
          (p.ran && (typeof p.passed !== "boolean" || p.reason !== undefined)) || (!p.ran && (p.reason === undefined || p.passed !== undefined)))
        throw new StorageError("StorageError", "Invalid reproduction.");
      const commands = commandOutcomes(p.commands);
      return { type: input.type, source: input.source, payload: { ran: p.ran,
        ...(p.passed === undefined ? {} : { passed: p.passed as boolean }),
        ...(p.commandsRun === undefined ? {} : { commandsRun: count(p.commandsRun, 64) }),
        ...(p.refusal === undefined ? {} : { refusal: p.refusal as string }), ...(p.reason === undefined ? {} : { reason: p.reason as string }),
        ...(p.backendId === undefined ? {} : { backendId: evidenceLabel(p.backendId) }),
        ...(p.confinement === undefined ? {} : { confinement: evidenceLabel(p.confinement) }),
        ...(p.platformRequirement === undefined ? {} : { platformRequirement: evidenceLabel(p.platformRequirement) }),
        ...(p.acceptance === undefined ? {} : { acceptance: p.acceptance as "granted" | "offlineRehearsal" }),
        ...(commands === undefined ? {} : { commands }) } };
    }
    case "EvidenceDecisionRecorded": {
      if (!decisions.has(p.decision) || typeof p.deliverable !== "boolean" || !taskClasses.has(p.taskClass) || typeof p.sensitive !== "boolean" ||
          (p.objective !== undefined && p.objective !== "review" && p.objective !== "falsify") || typeof p.overflowed !== "boolean" ||
          !Array.isArray(p.obligations) || p.obligations.length > 16)
        throw new StorageError("StorageError", "Invalid evidence decision.");
      const obligations = (p.obligations as unknown[]).map(entry => {
        const o = isRecord(entry) ? entry : {};
        if (!obligationKinds.has(o.kind) || !obligationTiers.has(o.tier) || !obligationStatuses.has(o.status) || Object.keys(o).length !== 3)
          throw new StorageError("StorageError", "Invalid evidence obligation.");
        return { kind: o.kind as never, tier: o.tier as never, status: o.status as never };
      });
      if (p.artifactRef !== undefined) assertId(p.artifactRef, "a");
      return { type: input.type, source: input.source, payload: { decision: p.decision as never, deliverable: p.deliverable,
        taskClass: p.taskClass as never, sensitive: p.sensitive, ...(p.objective === undefined ? {} : { objective: p.objective as "review" | "falsify" }),
        obligations, claims: count(p.claims, 64), evidence: count(p.evidence, 512), overflowed: p.overflowed,
        ...(p.artifactRef === undefined ? {} : { artifactRef: p.artifactRef as string }) } };
    }
    case "CandidateVerificationObserved": {
      if (typeof p.passed !== "boolean" || (p.refusal !== undefined && !verificationRefusals.has(p.refusal)) ||
          (p.acceptance !== undefined && !acceptances.has(p.acceptance)) ||
          (p.commands !== undefined && (!Array.isArray(p.commands) || p.commands.length > 64)))
        throw new StorageError("StorageError", "Invalid candidate verification.");
      const commands = (p.commands as unknown[] | undefined)?.map(entry => {
        const c = isRecord(entry) ? entry : {};
        if (typeof c.id !== "string" || !COMMAND_ID.test(c.id) || !(c.exitCode === null || Number.isSafeInteger(c.exitCode)))
          throw new StorageError("StorageError", "Invalid candidate verification command.");
        return { id: c.id, status: evidenceLabel(c.status), exitCode: c.exitCode as number | null };
      });
      const prepared = optionalBoolean(p.dependencyPrepared), cacheHit = optionalBoolean(p.dependencyCacheHit);
      return { type: input.type, source: input.source, payload: { attempt: attemptNumber(p.attempt), passed: p.passed,
        commandsRun: count(p.commandsRun, 64), ...(p.refusal === undefined ? {} : { refusal: p.refusal as string }),
        ...(p.backendId === undefined ? {} : { backendId: evidenceLabel(p.backendId) }),
        ...(p.confinement === undefined ? {} : { confinement: evidenceLabel(p.confinement) }),
        ...(p.platformRequirement === undefined ? {} : { platformRequirement: evidenceLabel(p.platformRequirement) }),
        ...(p.acceptance === undefined ? {} : { acceptance: p.acceptance as "granted" | "offlineRehearsal" }),
        ...(p.dependencyKey === undefined ? {} : { dependencyKey: evidenceLabel(p.dependencyKey) }),
        ...(prepared === undefined ? {} : { dependencyPrepared: prepared }),
        ...(cacheHit === undefined ? {} : { dependencyCacheHit: cacheHit }),
        ...(commands === undefined ? {} : { commands }) } };
    }
  }
}

/** Per-command verification outcomes of an event: known command ids, a status label and an exit code; nothing else. */
function commandOutcomes(value: unknown): Array<{ id: string; status: string; exitCode: number | null }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) throw new StorageError("StorageError", "Invalid verification commands.");
  return value.map(entry => {
    const c = isRecord(entry) ? entry : {};
    if (typeof c.id !== "string" || !COMMAND_ID.test(c.id) || !(c.exitCode === null || Number.isSafeInteger(c.exitCode)))
      throw new StorageError("StorageError", "Invalid verification command.");
    return { id: c.id, status: evidenceLabel(c.status), exitCode: c.exitCode as number | null };
  });
}

export type EventReadItem = Readonly<{ event: StoredEvent }> |
  Readonly<{ diagnostic: "TruncatedFinalLine"; line: number }>;
type WriteState = { tail: Promise<void>; sequence?: number; poisoned: boolean };
const writeStates = new Map<string, WriteState>();
export const pendingEventQueueCount = (): number => writeStates.size;

export class EventStore {
  #poisoned = false;
  private constructor(readonly runDirectory: string, readonly runId: string,
    private readonly redactor: DiagnosticRedactor) {}
  get path(): string { return join(this.runDirectory, "events.jsonl"); }

  private static async scan(runDirectory: string, runId: string): Promise<number> {
    const path = join(runDirectory, "events.jsonl");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new StorageError("StorageError", "Event log is not a regular file.");
    let last = 0;
    for await (const item of EventStore.read(runDirectory, runId)) {
      if ("diagnostic" in item) throw new StorageError("CorruptEventLog", "Truncated final event prevents append.", item.line);
      last = item.event.sequence;
    }
    return last;
  }

  static async open(runDirectory: string, runId: string,
    redactor = DiagnosticRedactor.fromEnvironment(process.env)): Promise<EventStore> {
    assertId(runId, "r");
    const path = join(runDirectory, "events.jsonl");
    await enqueuePath<void, WriteState>(writeStates, path,
      () => ({ tail: Promise.resolve(), poisoned: false }), async state => {
      state.sequence = await EventStore.scan(runDirectory, runId);
      state.poisoned = false;
    });
    return new EventStore(runDirectory, runId, redactor);
  }

  async append(input: EventInput): Promise<StoredEvent> {
    if (this.#poisoned) throw new StorageError("CorruptEventLog", "Event log needs inspection after a failed append.");
    return enqueuePath<StoredEvent, WriteState>(writeStates, this.path,
      () => ({ tail: Promise.resolve(), poisoned: false }), async state => {
      if (state.poisoned) throw new StorageError("CorruptEventLog", "Event log needs inspection after a failed append.");
      state.sequence ??= await EventStore.scan(this.runDirectory, this.runId);
      const projected = projectInput(input, this.redactor);
      const event: StoredEvent = { schemaVersion: STORAGE_SCHEMA_VERSION, eventId: makeId("e"),
        runId: this.runId, sequence: state.sequence + 1, timestamp: new Date().toISOString(),
        type: projected.type, source: projected.source, payload: projected.payload };
      const line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line, "utf8") > 1024 * 1024)
        throw new StorageError("StorageError", "Event exceeds JSONL line limit.");
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new StorageError("StorageError", "Event log is not a regular file.");
      const handle = await open(this.path, "a");
      try { await handle.writeFile(line, "utf8"); await handle.sync(); }
      catch (error) { state.poisoned = true; this.#poisoned = true; throw error; }
      finally { await handle.close(); }
      state.sequence = event.sequence;
      return event;
    });
  }

  static async *read(runDirectory: string, runId: string): AsyncGenerator<EventReadItem> {
    assertId(runId, "r");
    let expected = 1;
    for await (const item of readJsonl(join(runDirectory, "events.jsonl"))) {
      if ("diagnostic" in item) { yield { diagnostic: item.diagnostic, line: item.line }; return; }
      const value = item.value;
      schemaVersion(value);
      if (!isRecord(value)) throw new StorageError("CorruptEventLog", "Event record is not an object.", item.line);
      assertId(value.eventId, "e");
      if (value.runId !== runId || value.sequence !== expected || !eventTypes.has(value.type as EventType) ||
          !sources.has(value.source as EventSource) || !isRecord(value.payload) ||
          Object.keys(value).length !== 8)
        throw new StorageError("CorruptEventLog", "Event identity, sequence or shape is invalid.", item.line);
      safeTimestamp(value.timestamp, "event timestamp");
      let projected: EventInput;
      try { projected = projectInput({ type: value.type, source: value.source,
        payload: value.payload } as EventInput, new DiagnosticRedactor()); }
      catch { throw new StorageError("CorruptEventLog", "Event payload is invalid.", item.line); }
      if (!isDeepStrictEqual(projected.payload, value.payload))
        throw new StorageError("CorruptEventLog", "Event payload has unsupported fields.", item.line);
      expected++;
      yield { event: value as unknown as StoredEvent };
    }
  }
  readEvents(): AsyncGenerator<EventReadItem> { return EventStore.read(this.runDirectory, this.runId); }
  async listEvents(limit = 1000): Promise<Readonly<{ events: readonly StoredEvent[]; diagnostic?: { kind: "TruncatedFinalLine"; line: number } }>> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new StorageError("StorageError", "Invalid event read limit.");
    const events: StoredEvent[] = [];
    for await (const item of this.readEvents()) {
      if ("diagnostic" in item) return { events, diagnostic: { kind: item.diagnostic, line: item.line } };
      if (events.length >= limit) throw new StorageError("StorageError", "Event read limit exceeded.");
      events.push(item.event);
    }
    return { events };
  }
}
