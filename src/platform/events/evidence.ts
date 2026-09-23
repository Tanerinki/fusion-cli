import { basename } from "node:path";
import type { CapabilitySnapshot, FusionErrorKind, ProviderUsage } from "../../core/domain.js";
import { DiagnosticRedactor } from "../../core/policy/redaction.js";
import type { ProcessOutcome } from "../process/supervisor.js";
import { finiteNonnegative, hashText, isRecord, safeShortText, safeTimestamp, StorageError } from "./shared.js";
import type { ProcessEvidence, ProviderEvidence } from "./types.js";

const ERROR_KINDS = new Set<FusionErrorKind>(["InvalidInput", "CapabilityUnavailable", "BillingBlocked",
  "AuthMismatch", "ProviderIdentityMismatch", "SecurityViolation", "SpawnFailure", "Timeout", "Cancelled",
  "ProcessFailure", "ProtocolError", "MalformedOutput", "VerificationFailure", "WorkspaceConflict", "InternalError"]);
export function errorKind(value: unknown): FusionErrorKind {
  if (typeof value !== "string" || !ERROR_KINDS.has(value as FusionErrorKind))
    throw new StorageError("StorageError", "Invalid error kind for persistence.");
  return value as FusionErrorKind;
}
const label = (value: unknown, name: string, redactor: DiagnosticRedactor, max = 128): string =>
  redactor.redactText(safeShortText(value, name, max));
const capabilityState = (value: unknown): boolean | "unknown" => {
  if (value === true || value === false || value === "unknown") return value;
  throw new StorageError("StorageError", "Invalid capability state.");
};
/** Explicit capability projection prevents future adapter fields becoming persisted by default. */
export function projectCapability(input: CapabilitySnapshot, redactor: DiagnosticRedactor): CapabilitySnapshot {
  const fs = isRecord(input.filesystem) ? input.filesystem : null;
  const shell = isRecord(input.shell) ? input.shell : null;
  if (!fs || !shell) throw new StorageError("StorageError", "Invalid capability snapshot.");
  if (input.webToolsDisabledEvidence !== undefined &&
      typeof input.webToolsDisabledEvidence.versionVerified !== "boolean")
    throw new StorageError("StorageError", "Invalid capability evidence version flag.");
  return {
    provider: label(input.provider, "provider ID", redactor),
    transport: label(input.transport, "transport ID", redactor),
    observedAt: safeTimestamp(input.observedAt, "capability timestamp"),
    runtimeVersion: label(input.runtimeVersion, "runtime version", redactor),
    ...(input.schemaFingerprint === undefined ? {} : { schemaFingerprint: label(input.schemaFingerprint, "schema fingerprint", redactor) }),
    persistentSessions: capabilityState(input.persistentSessions),
    structuredOutput: capabilityState(input.structuredOutput),
    ...(input.webToolsDisabled === undefined ? {} : { webToolsDisabled: capabilityState(input.webToolsDisabled) }),
    ...(input.webToolsDisabledEvidence === undefined ? {} : { webToolsDisabledEvidence: {
      source: input.webToolsDisabledEvidence.source === "launchFlag" ? "launchFlag" as const :
        input.webToolsDisabledEvidence.source === "runtimeReadback" ? "runtimeReadback" as const :
          (() => { throw new StorageError("StorageError", "Invalid capability evidence source."); })(),
      versionVerified: input.webToolsDisabledEvidence.versionVerified } }),
    filesystem: { read: capabilityState(fs.read), write: capabilityState(fs.write) },
    shell: { available: capabilityState(shell.available), sandboxed: capabilityState(shell.sandboxed) },
    approvalCallback: capabilityState(input.approvalCallback),
    protocolCancellation: capabilityState(input.protocolCancellation),
    usageReporting: capabilityState(input.usageReporting),
    modelIdentityReadback: capabilityState(input.modelIdentityReadback),
    subscriptionLaneReadback: capabilityState(input.subscriptionLaneReadback),
  };
}
export function projectUsage(input: ProviderUsage | undefined,
  redactor: DiagnosticRedactor): ProviderEvidence["usage"] {
  if (input === undefined) return undefined;
  const usage: { inputTokens?: number; outputTokens?: number; estimatedListCostUsd?: number;
    subscription?: NonNullable<ProviderUsage["subscription"]> } = {};
  for (const key of ["inputTokens", "outputTokens", "estimatedListCostUsd"] as const) {
    const value = input[key];
    if (value !== undefined) {
      if (!finiteNonnegative(value)) throw new StorageError("StorageError", "Invalid provider usage value.");
      usage[key] = value;
    }
  }
  if (input.subscription !== undefined) {
    const quota = input.subscription;
    if (!isRecord(quota) || !isRecord(quota.window) || !isRecord(quota.weekly) ||
        !finiteNonnegative(quota.observedAtMs) || !Number.isSafeInteger(quota.observedAtMs) ||
        !finiteNonnegative(quota.window.usedPercent) || quota.window.usedPercent > 100 ||
        !finiteNonnegative(quota.weekly.usedPercent) || quota.weekly.usedPercent > 100 ||
        !finiteNonnegative(quota.window.resetsAtMs) || !Number.isSafeInteger(quota.window.resetsAtMs) ||
        !finiteNonnegative(quota.weekly.resetsAtMs) || !Number.isSafeInteger(quota.weekly.resetsAtMs) ||
        !finiteNonnegative(quota.window.windowDurationMins) || quota.window.windowDurationMins <= 0)
      throw new StorageError("StorageError", "Invalid subscription quota telemetry.");
    usage.subscription = {
      tier: label(quota.tier, "subscription tier", redactor), observedAtMs: quota.observedAtMs,
      window: { usedPercent: quota.window.usedPercent, resetsAtMs: quota.window.resetsAtMs,
        windowDurationMins: quota.window.windowDurationMins },
      weekly: { usedPercent: quota.weekly.usedPercent, resetsAtMs: quota.weekly.resetsAtMs },
    };
  }
  return Object.keys(usage).length ? usage : undefined;
}
export function projectProviderEvidence(input: ProviderEvidence, redactor: DiagnosticRedactor): ProviderEvidence {
  if (!isRecord(input)) throw new StorageError("StorageError", "Invalid provider evidence.");
  const authLane = input.authLane;
  if (authLane !== undefined && !["subscription", "subscriptionToken", "api", "thirdParty", "unknown"].includes(authLane))
    throw new StorageError("StorageError", "Invalid auth lane category.");
  const posture = input.posture;
  if (posture !== undefined && posture !== "readOnly" && posture !== "writer")
    throw new StorageError("StorageError", "Invalid posture category.");
  const termination = input.termination;
  if (termination !== undefined && !["completed", "failed", "cancelled", "timeout"].includes(termination))
    throw new StorageError("StorageError", "Invalid termination category.");
  const usage = projectUsage(input.usage, redactor);
  return {
    providerId: label(input.providerId, "provider ID", redactor),
    transportId: label(input.transportId, "transport ID", redactor),
    requestedModel: label(input.requestedModel, "requested model", redactor),
    ...(input.observedModel === undefined ? {} : { observedModel: label(input.observedModel, "observed model", redactor) }),
    ...(input.runtimeVersion === undefined ? {} : { runtimeVersion: label(input.runtimeVersion, "runtime version", redactor) }),
    ...(authLane === undefined ? {} : { authLane }),
    ...(posture === undefined ? {} : { posture }),
    ...(input.capability === undefined ? {} : { capability: projectCapability(input.capability, redactor) }),
    ...(input.startedAt === undefined ? {} : { startedAt: safeTimestamp(input.startedAt, "provider start") }),
    ...(input.completedAt === undefined ? {} : { completedAt: safeTimestamp(input.completedAt, "provider completion") }),
    ...(termination === undefined ? {} : { termination }),
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Never copies stdout, stderr, argv values, environment, or full paths. */
export function processEvidenceFromOutcome(outcome: ProcessOutcome, redactor: DiagnosticRedactor,
  artifactRefs: Readonly<{ stdout?: string; stderr?: string }> = {}): ProcessEvidence {
  const flags = outcome.args.filter(arg => /^--[a-z][a-z0-9-]*$/u.test(arg)).map(arg => arg.slice(0, 80));
  const positional = outcome.args.length - outcome.args.filter(arg => arg.startsWith("-")).length;
  const termination = outcome.termination;
  const cleanup = termination?.cleanupError ? "failed" : termination?.method ?? "none";
  if (!finiteNonnegative(outcome.durationMs)) throw new StorageError("StorageError", "Invalid process duration.");
  return {
    executableName: label(basename(outcome.executable), "executable name", redactor),
    executableHash: hashText(outcome.executable.toLowerCase()),
    argumentFlags: flags,
    positionalArgumentCount: positional,
    cwdHash: hashText(outcome.cwd.toLowerCase()),
    startedAt: safeTimestamp(outcome.startedAt, "process start"),
    endedAt: safeTimestamp(outcome.endedAt, "process end"),
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    ...(termination === undefined ? {} : { cancellationReason: termination.reason }),
    killedByFusion: Boolean(termination?.forced),
    cleanup,
    ...(artifactRefs.stdout === undefined ? {} : { stdoutArtifactRef: label(artifactRefs.stdout, "stdout artifact", redactor) }),
    ...(artifactRefs.stderr === undefined ? {} : { stderrArtifactRef: label(artifactRefs.stderr, "stderr artifact", redactor) }),
    stdoutTruncated: outcome.stdoutTruncated,
    stderrTruncated: outcome.stderrTruncated,
  };
}
export function projectProcessEvidence(input: ProcessEvidence, redactor: DiagnosticRedactor): ProcessEvidence {
  if (!isRecord(input) || !Array.isArray(input.argumentFlags) || !input.argumentFlags.every(x => typeof x === "string" && /^--[a-z][a-z0-9-]*$/u.test(x)))
    throw new StorageError("StorageError", "Invalid process evidence.");
  if (!finiteNonnegative(input.durationMs) || !Number.isSafeInteger(input.positionalArgumentCount) || input.positionalArgumentCount < 0 ||
      (input.exitCode !== null && !Number.isSafeInteger(input.exitCode)) ||
      typeof input.stdoutTruncated !== "boolean" || typeof input.stderrTruncated !== "boolean" ||
      typeof input.killedByFusion !== "boolean" ||
      !["none", "taskkill", "directKill", "processGroup", "failed"].includes(input.cleanup))
    throw new StorageError("StorageError", "Invalid process evidence.");
  if (!/^[0-9a-f]{64}$/u.test(input.executableHash) || !/^[0-9a-f]{64}$/u.test(input.cwdHash) ||
      (input.cancellationReason !== undefined &&
        !["user", "timeout", "outputLimit", "protocolError", "shutdown"].includes(input.cancellationReason)))
    throw new StorageError("StorageError", "Invalid process evidence identity or cancellation.");
  return { executableName: label(input.executableName, "executable name", redactor),
    executableHash: safeShortText(input.executableHash, "executable hash", 64),
    argumentFlags: input.argumentFlags.slice(0, 128), positionalArgumentCount: input.positionalArgumentCount,
    cwdHash: safeShortText(input.cwdHash, "cwd hash", 64),
    startedAt: safeTimestamp(input.startedAt, "process start"), endedAt: safeTimestamp(input.endedAt, "process end"),
    durationMs: input.durationMs, exitCode: input.exitCode,
    signal: input.signal === null ? null : label(input.signal, "process signal", redactor),
    ...(input.cancellationReason === undefined ? {} : { cancellationReason: label(input.cancellationReason, "cancellation reason", redactor) }),
    killedByFusion: input.killedByFusion, cleanup: input.cleanup,
    ...(input.stdoutArtifactRef === undefined ? {} : { stdoutArtifactRef: label(input.stdoutArtifactRef, "stdout artifact", redactor) }),
    ...(input.stderrArtifactRef === undefined ? {} : { stderrArtifactRef: label(input.stderrArtifactRef, "stderr artifact", redactor) }),
    stdoutTruncated: input.stdoutTruncated, stderrTruncated: input.stderrTruncated };
}
