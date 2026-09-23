import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DiagnosticRedactor } from "../../core/policy/redaction.js";
import { ArtifactStore } from "./artifact-store.js";
import { EventStore } from "./event-store.js";
import { MetricsStore } from "./metrics.js";
import { FUSION_VERSION, STORAGE_SCHEMA_VERSION, assertId, atomicJson, enqueuePath, finiteNonnegative, hashText,
  isRecord, makeId, safeOptionalText, safeShortText, safeTimestamp, schemaVersion, StorageError } from "./shared.js";
import type { ManifestUpdate, ProviderBindingRecord, Risk, RunManifest, RunStatus } from "./types.js";

export type RunCreateOptions = Pick<ManifestUpdate, "workflowId" | "taskClass" | "risk" | "providerBindings">;
const statuses = new Set<RunStatus>(["running", "completed", "failed", "cancelled"]);
const risks = new Set<Risk>(["low", "medium", "high", "critical", "unknown"]);
const roles = new Set(["Lead", "Worker", "Explorer", "Reviewer", "Auditor"]);
const redact = (value: unknown, name: string, r: DiagnosticRedactor): string =>
  r.redactText(safeShortText(value, name));
const optionalRedact = (value: unknown, name: string, r: DiagnosticRedactor): string | undefined => {
  const text = safeOptionalText(value, name);
  return text === undefined ? undefined : r.redactText(text);
};
async function ensureOwnedDir(path: string): Promise<void> {
  try { await mkdir(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new StorageError("StorageError", "Fusion storage root is not a real directory.");
}
function projectBinding(input: ProviderBindingRecord, r: DiagnosticRedactor): ProviderBindingRecord {
  if (!isRecord(input) || !roles.has(input.role))
    throw new StorageError("StorageError", "Invalid provider binding.");
  return { role: input.role, providerId: redact(input.providerId, "provider ID", r),
    transportId: redact(input.transportId, "transport ID", r),
    requestedModel: redact(input.requestedModel, "requested model", r),
    ...(input.observedModel === undefined ? {} : { observedModel: redact(input.observedModel, "observed model", r) }),
    ...(input.capabilityRef === undefined ? {} : { capabilityRef: redact(input.capabilityRef, "capability reference", r) }) };
}
function projectManifest(input: RunManifest, r: DiagnosticRedactor): RunManifest {
  schemaVersion(input);
  assertId(input.runId, "r");
  if (!statuses.has(input.status)) throw new StorageError("StorageError", "Invalid run status.");
  if (input.risk !== undefined && !risks.has(input.risk)) throw new StorageError("StorageError", "Invalid risk category.");
  if (!isRecord(input.runtime)) throw new StorageError("StorageError", "Invalid runtime identity.");
  if (typeof input.workspaceHash !== "string" || !/^[0-9a-f]{64}$/u.test(input.workspaceHash))
    throw new StorageError("StorageError", "Invalid workspace identity.");
  if (input.status === "running" && input.completedAt !== undefined)
    throw new StorageError("StorageError", "Running manifest cannot have completion time.");
  const refs = (value: readonly string[] | undefined, name: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 10000) throw new StorageError("StorageError", `Invalid ${name}.`);
    return value.map(ref => redact(ref, name, r));
  };
  const verification = input.verification;
  if (verification !== undefined && (!isRecord(verification) ||
      (verification.passes !== undefined && (!Number.isSafeInteger(verification.passes) || !finiteNonnegative(verification.passes))) ||
      (verification.failures !== undefined && (!Number.isSafeInteger(verification.failures) || !finiteNonnegative(verification.failures)))))
    throw new StorageError("StorageError", "Invalid verification summary.");
  const termination = input.termination;
  if (termination !== undefined && (!isRecord(termination) ||
      !["completed", "failed", "cancelled", "timeout"].includes(String(termination.reason)) ||
      (termination.killedByFusion !== undefined && typeof termination.killedByFusion !== "boolean")))
    throw new StorageError("StorageError", "Invalid termination summary.");
  return { schemaVersion: STORAGE_SCHEMA_VERSION, runId: input.runId,
    createdAt: safeTimestamp(input.createdAt, "run creation time"),
    ...(input.completedAt === undefined ? {} : { completedAt: safeTimestamp(input.completedAt, "run completion time") }),
    status: input.status, fusionVersion: redact(input.fusionVersion, "Fusion version", r),
    workspaceHash: input.workspaceHash,
    runtime: { platform: redact(input.runtime.platform, "platform", r),
      nodeVersion: redact(input.runtime.nodeVersion, "Node version", r) },
    ...(optionalRedact(input.workflowId, "workflow ID", r) === undefined ? {} :
      { workflowId: optionalRedact(input.workflowId, "workflow ID", r) }),
    ...(optionalRedact(input.taskClass, "task class", r) === undefined ? {} :
      { taskClass: optionalRedact(input.taskClass, "task class", r) }),
    ...(input.risk === undefined ? {} : { risk: input.risk }),
    ...(input.providerBindings === undefined ? {} : { providerBindings:
      (() => { if (!Array.isArray(input.providerBindings) || input.providerBindings.length > 128)
        throw new StorageError("StorageError", "Invalid provider bindings.");
        return input.providerBindings.map(binding => projectBinding(binding, r)); })() }),
    ...(refs(input.capabilityRefs, "capability references") === undefined ? {} :
      { capabilityRefs: refs(input.capabilityRefs, "capability references") }),
    ...(refs(input.artifactRefs, "artifact references") === undefined ? {} :
      { artifactRefs: refs(input.artifactRefs, "artifact references") }),
    ...(termination === undefined ? {} : { termination: { reason: termination.reason,
      ...(termination.killedByFusion === undefined ? {} : { killedByFusion: termination.killedByFusion }) } }),
    ...(verification === undefined ? {} : { verification: {
      ...(verification.passes === undefined ? {} : { passes: verification.passes }),
      ...(verification.failures === undefined ? {} : { failures: verification.failures }) } }),
  } as RunManifest;
}
const manifestQueues = new Map<string, { tail: Promise<void> }>();
export const pendingManifestQueueCount = (): number => manifestQueues.size;

export class RunStore {
  readonly #redactor: DiagnosticRedactor;
  private constructor(readonly repositoryRoot: string, readonly runId: string,
    readonly directory: string, redactor: DiagnosticRedactor) {
    this.#redactor = redactor;
  }

  static async create(repositoryRoot: string, options: RunCreateOptions = {},
    redactor = DiagnosticRedactor.fromEnvironment(process.env)): Promise<RunStore> {
    if (!isAbsolute(repositoryRoot)) throw new StorageError("StorageError", "Repository root must be absolute.");
    const repo = resolve(repositoryRoot);
    const info = await lstat(repo);
    if (!info.isDirectory()) throw new StorageError("StorageError", "Repository root is not a directory.");
    const fusion = join(repo, ".fusion"), runs = join(fusion, "runs");
    await ensureOwnedDir(fusion); await ensureOwnedDir(runs);
    for (let attempt = 0; attempt < 5; attempt++) {
      const runId = makeId("r"), directory = join(runs, runId);
      try { await mkdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
      const store = new RunStore(repo, runId, directory, redactor);
      const manifest = projectManifest({ schemaVersion: STORAGE_SCHEMA_VERSION, runId,
        createdAt: new Date().toISOString(), status: "running", fusionVersion: FUSION_VERSION,
        workspaceHash: hashText(repo.toLowerCase()),
        runtime: { platform: process.platform, nodeVersion: process.version }, ...options }, redactor);
      await atomicJson(join(directory, "run.json"), manifest);
      const events = await open(join(directory, "events.jsonl"), "wx", 0o600);
      await events.close();
      for (const section of ["artifacts", "providers", "verification", "findings"])
        await ensureOwnedDir(join(directory, section));
      return store;
    }
    throw new StorageError("StorageError", "Could not allocate a unique run ID.");
  }

  static async open(repositoryRoot: string, runId: string,
    redactor = DiagnosticRedactor.fromEnvironment(process.env)): Promise<RunStore> {
    assertId(runId, "r");
    if (!isAbsolute(repositoryRoot)) throw new StorageError("StorageError", "Repository root must be absolute.");
    const repo = resolve(repositoryRoot), directory = join(repo, ".fusion", "runs", runId);
    for (const path of [repo, join(repo, ".fusion"), join(repo, ".fusion", "runs"), directory]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new StorageError("StorageError", "Run path is not a real directory.");
    }
    const store = new RunStore(repo, runId, directory, redactor);
    await store.readManifest();
    return store;
  }

  async readManifest(): Promise<RunManifest> {
    const path = join(this.directory, "run.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      throw new StorageError("StorageError", "Run manifest is invalid or oversized.");
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, "utf8")) as unknown; }
    catch { throw new StorageError("StorageError", "Run manifest JSON is malformed."); }
    const manifest = projectManifest(parsed as RunManifest, this.#redactor);
    if (manifest.runId !== this.runId) throw new StorageError("StorageError", "Run manifest identity mismatches directory.");
    return manifest;
  }

  async updateManifest(patch: ManifestUpdate): Promise<RunManifest> {
    return enqueuePath(manifestQueues, join(this.directory, "run.json"),
      () => ({ tail: Promise.resolve() }), async () => {
      const directoryInfo = await lstat(this.directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
        throw new StorageError("StorageError", "Run directory is not a real directory.");
      const old = await this.readManifest();
      if (old.status !== "running" && patch.status !== undefined && patch.status !== old.status)
        throw new StorageError("StorageError", "Terminal run status is immutable.");
      const next = projectManifest({ ...old, ...patch }, this.#redactor);
      await atomicJson(join(this.directory, "run.json"), next);
      return next;
    });
  }
  async openEvents(): Promise<EventStore> { return EventStore.open(this.directory, this.runId, this.#redactor); }
  async openArtifacts(): Promise<ArtifactStore> { return ArtifactStore.open(this.directory, this.runId, this.#redactor); }
  openMetrics(): MetricsStore { return new MetricsStore(this.directory, this.runId, this.#redactor); }
}
