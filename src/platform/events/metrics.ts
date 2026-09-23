import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DiagnosticRedactor } from "../../core/policy/redaction.js";
import { STORAGE_SCHEMA_VERSION, assertId, atomicJson, finiteNonnegative, isRecord,
  safeShortText, schemaVersion, StorageError } from "./shared.js";
import type { LocalRunMetrics, Risk, StoredEvent } from "./types.js";

export type MetricSample = Partial<Omit<LocalRunMetrics, "schemaVersion" | "runId">>;
const counters = ["providerRunCount", "retries", "takeovers", "verificationFailures", "humanInterventions",
  "confirmedFindings", "rejectedFindings", "contextTransferredBytes", "contextTransferredTokens",
  "inputTokens", "outputTokens", "estimatedListCostUsd"] as const;
function validated(metrics: LocalRunMetrics): LocalRunMetrics {
  schemaVersion(metrics);
  assertId(metrics.runId, "r");
  if (metrics.success !== undefined && typeof metrics.success !== "boolean")
    throw new StorageError("StorageError", "Invalid success metric.");
  if (metrics.wallTimeMs !== undefined && !finiteNonnegative(metrics.wallTimeMs))
    throw new StorageError("StorageError", "Invalid wall-time metric.");
  if (metrics.risk !== undefined && !["low", "medium", "high", "critical", "unknown"].includes(metrics.risk))
    throw new StorageError("StorageError", "Invalid risk metric.");
  for (const key of counters) {
    const value = metrics[key];
    if (value !== undefined && !finiteNonnegative(value))
      throw new StorageError("StorageError", "Invalid numeric metric.");
  }
  return { schemaVersion: STORAGE_SCHEMA_VERSION, runId: metrics.runId,
    ...(metrics.success === undefined ? {} : { success: metrics.success }),
    ...(metrics.wallTimeMs === undefined ? {} : { wallTimeMs: metrics.wallTimeMs }),
    ...(metrics.risk === undefined ? {} : { risk: metrics.risk as Risk }),
    ...(metrics.workflowId === undefined ? {} : { workflowId: safeShortText(metrics.workflowId, "workflow ID") }),
    ...Object.fromEntries(counters.filter(key => metrics[key] !== undefined).map(key => [key, metrics[key]])) };
}

/** Sums only observed values. Missing data stays undefined, including cost. */
export function aggregateRunMetrics(runId: string, samples: readonly MetricSample[]): LocalRunMetrics {
  assertId(runId, "r");
  const result: Record<string, unknown> = { schemaVersion: STORAGE_SCHEMA_VERSION, runId };
  for (const sample of samples) {
    if (!isRecord(sample)) throw new StorageError("StorageError", "Invalid metric sample.");
    if (sample.success !== undefined) result.success = sample.success;
    if (sample.risk !== undefined) result.risk = sample.risk;
    if (sample.workflowId !== undefined) result.workflowId = sample.workflowId;
    if (sample.wallTimeMs !== undefined) result.wallTimeMs = sample.wallTimeMs;
    for (const key of counters) {
      const value = sample[key];
      if (value !== undefined) {
        if (!finiteNonnegative(value)) throw new StorageError("StorageError", "Invalid metric sample value.");
        result[key] = (result[key] as number | undefined ?? 0) + value;
      }
    }
  }
  return validated(result as unknown as LocalRunMetrics);
}

export function metricsFromEvents(runId: string, events: readonly StoredEvent[]): LocalRunMetrics {
  const samples: MetricSample[] = [];
  for (const event of events) {
    if (event.runId !== runId) throw new StorageError("StorageError", "Metric event belongs to another run.");
    if (event.type === "RunStarted") {
      const payload = event.payload as { workflowId?: string; risk?: Risk };
      samples.push({ ...(payload.workflowId === undefined ? {} : { workflowId: payload.workflowId }),
        ...(payload.risk === undefined ? {} : { risk: payload.risk }) });
    }
    if (event.type === "RunCompleted") {
      const payload = event.payload as { wallTimeMs?: number };
      samples.push({ success: true, ...(payload.wallTimeMs === undefined ? {} : { wallTimeMs: payload.wallTimeMs }) });
    }
    if (event.type === "RunFailed") samples.push({ success: false });
    if (event.type === "ProviderObserved") {
      const evidence = (event.payload as { evidence: { usage?: { inputTokens?: number; outputTokens?: number;
        estimatedListCostUsd?: number } } }).evidence;
      samples.push({ providerRunCount: 1, ...evidence.usage });
    }
  }
  return aggregateRunMetrics(runId, samples);
}

export class MetricsStore {
  readonly path: string;
  constructor(readonly runDirectory: string, readonly runId: string,
    private readonly redactor = DiagnosticRedactor.fromEnvironment(process.env)) {
    assertId(runId, "r"); this.path = join(runDirectory, "metrics.json");
  }
  async write(metrics: LocalRunMetrics): Promise<void> {
    if (metrics.runId !== this.runId) throw new StorageError("StorageError", "Metrics run ID mismatch.");
    const safe = validated(metrics);
    await atomicJson(this.path, { ...safe,
      ...(safe.workflowId === undefined ? {} : { workflowId: this.redactor.redactText(safe.workflowId) }) });
  }
  async read(): Promise<LocalRunMetrics | undefined> {
    let info;
    try { info = await lstat(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      throw new StorageError("StorageError", "Metrics file is invalid or oversized.");
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown; }
    catch { throw new StorageError("StorageError", "Metrics JSON is malformed."); }
    const metrics = validated(parsed as LocalRunMetrics);
    if (metrics.runId !== this.runId) throw new StorageError("StorageError", "Metrics run ID mismatch.");
    return metrics;
  }
}
