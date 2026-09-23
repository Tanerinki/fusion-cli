import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DiagnosticRedactor } from "../../core/policy/redaction.js";
import { errorKind, projectProcessEvidence, projectProviderEvidence, projectVerificationEvidence } from "./evidence.js";
import { STORAGE_SCHEMA_VERSION, assertId, enqueuePath, finiteNonnegative, isRecord, makeId, readJsonl,
  safeShortText, safeTimestamp, schemaVersion, StorageError } from "./shared.js";
import type { ArtifactKind, EventInput, EventSource, EventType, ProcessEvidence, ProviderEvidence, Risk, StoredEvent,
  VerificationEvidence } from "./types.js";

const eventTypes = new Set<EventType>(["RunStarted", "RunCompleted", "RunFailed", "ProviderObserved",
  "ProcessObserved", "ArtifactStored", "CapabilityObserved", "VerificationObserved"]);
const sources = new Set<EventSource>(["runtime", "policy", "provider", "process", "artifact", "verification"]);
const risks = new Set<Risk>(["low", "medium", "high", "critical", "unknown"]);
const artifactKinds = new Set(["text", "json", "jsonl", "binary", "copiedFile"]);
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
  }
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
