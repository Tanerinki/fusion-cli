import type { FusionError, FusionErrorKind, TurnResult } from "../core/domain.js";
import { FusionFailure, safeCauseCode } from "../core/errors.js";
import { DiagnosticRedactor } from "../core/policy/redaction.js";
import { BoundedReadError } from "../platform/fs/bounded-read.js";
import { StorageError, type StorageErrorKind } from "../platform/events/shared.js";
import { InvalidProcessInputError } from "../platform/process/native-executable.js";

/**
 * Stable, documented process exit statuses (docs/o5-cli.md). Distinct causes keep distinct codes where the user's
 * next action differs; 130 follows the shell convention for an interrupted command. Codes 12–14 are unfinished runs:
 * work remains, so they are never 0.
 */
export const EXIT_CODES = Object.freeze({
  success: 0,
  internal: 1,
  invalidInput: 2,
  billingOrAuth: 3,
  securityPolicy: 4,
  providerUnavailable: 5,
  providerFailure: 6,
  timeout: 7,
  workspaceConflict: 8,
  verificationFailure: 9,
  storage: 10,
  /** A readiness gate refused the command before any work, e.g. REAL_WRITER_MODE_NOT_READY or doctor BLOCKED. */
  blocked: 11,
  reviewRequired: 12,
  decisionRequired: 13,
  humanGateRequired: 14,
  /** doctor: usable parts exist but readiness is degraded. */
  degraded: 15,
  cancelled: 130,
});

export type FailureCategory =
  | "invalidInput" | "billingGuard" | "authentication" | "securityPolicy" | "providerUnavailable"
  | "spawnFailure" | "timeout" | "cancelled" | "providerFailure" | "malformedResponse" | "verification"
  | "dirtyWorkspace" | "storage" | "pathSafety" | "internal";

interface Presentation {
  readonly category: FailureCategory;
  readonly exitCode: number;
  readonly title: string;
  readonly hint: string;
}

const BY_KIND: Readonly<Record<FusionErrorKind, Presentation>> = {
  InvalidInput: { category: "invalidInput", exitCode: EXIT_CODES.invalidInput, title: "Invalid input",
    hint: "Check the arguments, paths and configuration, then retry." },
  BillingBlocked: { category: "billingGuard", exitCode: EXIT_CODES.billingOrAuth, title: "Blocked by the billing guard",
    hint: "Remove the reported API-key, gateway or provider override so the subscription login is used." },
  AuthMismatch: { category: "authentication", exitCode: EXIT_CODES.billingOrAuth, title: "Subscription authentication not confirmed",
    hint: "Sign in to the provider CLI with the intended subscription account, then retry." },
  ProviderIdentityMismatch: { category: "securityPolicy", exitCode: EXIT_CODES.securityPolicy, title: "Provider or model identity mismatch",
    hint: "The provider ran a different provider or model than configured; check the binding and provider settings." },
  SecurityViolation: { category: "securityPolicy", exitCode: EXIT_CODES.securityPolicy, title: "Security policy violation",
    hint: "The provider's posture or requested action violated the read-only policy; nothing was accepted." },
  CapabilityUnavailable: { category: "providerUnavailable", exitCode: EXIT_CODES.providerUnavailable, title: "Provider capability unavailable",
    hint: "The installed provider cannot prove a required capability; check its version or choose another binding." },
  SpawnFailure: { category: "spawnFailure", exitCode: EXIT_CODES.providerUnavailable, title: "Provider could not start",
    hint: "Verify the provider CLI is installed and its native executable exists." },
  Timeout: { category: "timeout", exitCode: EXIT_CODES.timeout, title: "Timed out",
    hint: "The provider exceeded its deadline and was stopped; retry or raise the configured timeout." },
  Cancelled: { category: "cancelled", exitCode: EXIT_CODES.cancelled, title: "Cancelled",
    hint: "The run was stopped on request; no result was accepted." },
  ProcessFailure: { category: "providerFailure", exitCode: EXIT_CODES.providerFailure, title: "Provider failed",
    hint: "The provider reported a failed turn or exited unsuccessfully." },
  ProtocolError: { category: "providerFailure", exitCode: EXIT_CODES.providerFailure, title: "Provider protocol error",
    hint: "Provider output did not follow its expected protocol; the provider CLI may have changed." },
  MalformedOutput: { category: "malformedResponse", exitCode: EXIT_CODES.providerFailure, title: "Malformed provider response",
    hint: "The provider's result was not a valid result packet; nothing was accepted." },
  VerificationFailure: { category: "verification", exitCode: EXIT_CODES.verificationFailure, title: "Verification failed",
    hint: "A Fusion-run verification command did not pass; inspect its recorded output." },
  WorkspaceConflict: { category: "dirtyWorkspace", exitCode: EXIT_CODES.workspaceConflict, title: "Workspace conflict",
    hint: "The repository state does not allow this operation; Fusion did not modify your changes." },
  InternalError: { category: "internal", exitCode: EXIT_CODES.internal, title: "Internal error",
    hint: "Fusion stopped safely; re-run with debug output and report the cause code." },
};

const STORAGE: Readonly<Record<StorageErrorKind, Presentation>> = {
  InvalidArtifactPath: { category: "pathSafety", exitCode: EXIT_CODES.storage, title: "Unsafe storage path rejected",
    hint: "A run-storage path was absolute, escaped its root, or was not a real directory/file; nothing was written there." },
  ArtifactTooLarge: { category: "storage", exitCode: EXIT_CODES.storage, title: "Artifact exceeds its size limit",
    hint: "The artifact was not stored; reduce its size or store a bounded excerpt." },
  CorruptEventLog: { category: "storage", exitCode: EXIT_CODES.storage, title: "Run event log needs inspection",
    hint: "The run's events.jsonl is incomplete or invalid; Fusion does not repair logs automatically." },
  UnsupportedSchema: { category: "storage", exitCode: EXIT_CODES.storage, title: "Unsupported run-storage schema",
    hint: "The stored run was written by a different Fusion version." },
  ArtifactError: { category: "storage", exitCode: EXIT_CODES.storage, title: "Artifact storage failed",
    hint: "The artifact was not recorded; check disk space and permissions for .fusion/." },
  StorageError: { category: "storage", exitCode: EXIT_CODES.storage, title: "Run storage failed",
    hint: "Check that the repository root exists and .fusion/ is a writable real directory." },
};

export interface PresentedFailure {
  readonly category: FailureCategory;
  readonly exitCode: number;
  readonly retryable: boolean;
  /** Concise, redacted, deterministic user-facing text. Never contains stack traces unless `debug`. */
  readonly text: string;
}

export interface PresentOptions {
  /** Adds the safe cause code and the redacted underlying message. Stack traces are never included. */
  readonly debug?: boolean;
  readonly redactor?: DiagnosticRedactor;
}

function isFusionError(value: unknown): value is FusionError {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kind === "string" && Object.hasOwn(BY_KIND, candidate.kind) &&
    typeof candidate.safeMessage === "string" && typeof candidate.retryable === "boolean";
}

function render(p: Presentation, safeMessage: string, retryable: boolean, redactor: DiagnosticRedactor,
  debugLines: readonly string[], detail?: string): PresentedFailure {
  // v0.2.3: a provider's safe failure detail (a category and allowlisted fields; never provider text) on its own line.
  const lines = [`fusion: ${p.title}: ${redactor.redactText(safeMessage)}`,
    ...(detail === undefined ? [] : [`detail: ${redactor.redactText(detail.replace(/[\x00-\x1f\x7f]/gu, " ").slice(0, 600))}`]), `hint: ${p.hint}`];
  if (retryable) lines.push("retryable: yes");
  lines.push(...debugLines.map(line => redactor.redactText(line)));
  return { category: p.category, exitCode: p.exitCode, retryable, text: lines.join("\n") };
}

/** Maps a typed failure (or an unexpected thrown value) to one deterministic presentation. */
export function presentFailure(failure: unknown, options: PresentOptions = {}): PresentedFailure {
  const redactor = options.redactor ?? DiagnosticRedactor.fromEnvironment(process.env);
  const debug = options.debug === true;
  if (failure instanceof FusionFailure) return presentFailure(failure.error, options);
  if (isFusionError(failure)) {
    return render(BY_KIND[failure.kind], failure.safeMessage, failure.retryable, redactor,
      debug && failure.causeCode ? [`debug: cause ${failure.causeCode}`] : [],
      typeof failure.failureDetail === "string" && failure.failureDetail.length > 0 ? failure.failureDetail : undefined);
  }
  const causeLines = (error: unknown): string[] => {
    if (!debug) return [];
    const lines = [`debug: cause ${safeCauseCode(error)}`];
    if (error instanceof Error) lines.push(`debug: detail ${error.message}`);
    const inner = error instanceof Error ? error.cause : undefined;
    if (inner !== undefined) lines.push(`debug: underlying ${safeCauseCode(inner)}`);
    return lines;
  };
  if (failure instanceof StorageError) return render(STORAGE[failure.kind], failure.message, false, redactor, causeLines(failure));
  if (failure instanceof InvalidProcessInputError) return render(BY_KIND.InvalidInput, failure.safeMessage, false, redactor, causeLines(failure));
  if (failure instanceof BoundedReadError) return render(BY_KIND.InvalidInput, "A file exceeded its read limit or was not a regular file.", false, redactor, causeLines(failure));
  return render(BY_KIND.InternalError, "An unexpected error stopped the run.", false, redactor, causeLines(failure));
}

/** Exit status for a provider turn: success only for a completed turn. */
export function exitCodeForTurn(result: TurnResult): number {
  return result.status === "completed" ? EXIT_CODES.success : presentFailure(result.error).exitCode;
}
