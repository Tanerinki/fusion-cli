import type { DelegationPacket, FusionError, FusionErrorKind, ResultPacket, TurnResult, VerificationPlan } from "../domain.js";
import { failWith } from "../errors.js";

const MAX_TEXT = 2_000;
const MAX_ITEMS = 64;
/** Acceptance bounds for untrusted packets; anything larger is malformed rather than silently truncated. */
const MAX_PACKET_STRING = 64 * 1024;
const MAX_PACKET_ITEMS = 1_000;
const ERROR_KINDS = new Set<FusionErrorKind>(["InvalidInput", "CapabilityUnavailable", "BillingBlocked", "AuthMismatch",
  "ProviderIdentityMismatch", "SecurityViolation", "SpawnFailure", "Timeout", "Cancelled", "ProcessFailure",
  "ProtocolError", "MalformedOutput", "VerificationFailure", "WorkspaceConflict", "InternalError"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const bounded = (value: unknown): value is string[] => strings(value) && value.length <= MAX_PACKET_ITEMS &&
  value.every(item => item.length <= MAX_PACKET_STRING);

/**
 * Adapter output is untrusted: it is detached from the adapter by a structured clone (no getters, proxies or
 * later mutation), and only an exact, bounded ResultPacket shape is accepted. Anything else fails closed.
 */
export function validateResultPacket(input: unknown): ResultPacket {
  let value: unknown;
  try { value = structuredClone(input); } catch { failWith("MalformedOutput", "A role returned an invalid ResultPacket."); }
  const status = isRecord(value) ? value.result : undefined, changes = isRecord(value) ? value.changes : undefined;
  const verification = isRecord(value) ? value.verification : undefined;
  if (!isRecord(value) || !exactKeys(value, ["result", "changes", "verification", "uncertainties", "failures", "needsLeadDecision"]) ||
      !isRecord(status) || !exactKeys(status, ["status"]) || !["completed", "partial", "blocked", "failed"].includes(String(status.status)) ||
      !isRecord(changes) || !exactKeys(changes, ["files", "summary"]) || !bounded(changes.files) ||
      typeof changes.summary !== "string" || changes.summary.length > MAX_PACKET_STRING ||
      !isRecord(verification) || !exactKeys(verification, ["testsRun", "results"]) || !bounded(verification.testsRun) ||
      !bounded(verification.results) || !bounded(value.uncertainties) || !bounded(value.failures) || !bounded(value.needsLeadDecision))
    failWith("MalformedOutput", "A role returned an invalid ResultPacket.");
  return value as unknown as ResultPacket;
}

export type ValidatedTurn =
  | Readonly<{ status: "completed"; output: ResultPacket; effectiveProvider: string }>
  | Readonly<{ status: "failed" | "cancelled"; error: FusionError; effectiveProvider: string }>;
/** A TurnResult is the adapter boundary: a completed turn needs a valid packet, a failed one a typed error. */
export function validateTurnResult(value: unknown): ValidatedTurn {
  if (!isRecord(value) || typeof value.effectiveProvider !== "string")
    failWith("MalformedOutput", "A role returned an invalid turn result.");
  const turn = value as unknown as TurnResult;
  if (turn.status === "completed") return { status: "completed", output: validateResultPacket(turn.output),
    effectiveProvider: turn.effectiveProvider };
  if (turn.status !== "failed" && turn.status !== "cancelled")
    failWith("MalformedOutput", "A role returned an invalid turn status.");
  const error: unknown = turn.error;
  if (!isRecord(error) || !ERROR_KINDS.has(error.kind as FusionErrorKind) || typeof error.safeMessage !== "string" ||
      typeof error.retryable !== "boolean")
    failWith("MalformedOutput", "A role returned a failed turn without a typed error.");
  return { status: turn.status, effectiveProvider: turn.effectiveProvider, error: {
    kind: error.kind as FusionErrorKind, safeMessage: clip(error.safeMessage, 500), retryable: error.retryable,
    ...(typeof error.causeCode === "string" ? { causeCode: clip(error.causeCode, 128) } : {}) } };
}

export function validateDelegationPacket(value: unknown): DelegationPacket {
  const task = isRecord(value) ? value.task : undefined, scope = isRecord(value) ? value.scope : undefined;
  const architecture = isRecord(value) ? value.architecture : undefined, verification = isRecord(value) ? value.verification : undefined;
  if (!isRecord(value) || !isRecord(task) || typeof task.goal !== "string" || !strings(task.constraints) ||
      !strings(task.acceptanceCriteria) || !isRecord(scope) || !strings(scope.relevantFiles) || !strings(scope.allowedFiles) ||
      !strings(scope.forbiddenFiles) || !isRecord(architecture) || !strings(architecture.decisions) ||
      !strings(architecture.invariants) || !isRecord(verification) || !strings(verification.requiredTests) ||
      !strings(value.openQuestions))
    failWith("InvalidInput", "The delegation packet is malformed.");
  return value as unknown as DelegationPacket;
}

/** Bounded text for packets; model text is clipped, never forwarded wholesale. */
export function clip(text: string, max = MAX_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
const clipList = (items: readonly string[]): string[] => items.slice(0, MAX_ITEMS).map(item => clip(item));

/**
 * Packets are rebuilt from structured fields for every role. Earlier roles contribute only their bounded packet
 * fields; no transcript, stream or verifier output is forwarded.
 */
export function delegatePacket(base: DelegationPacket, contributions: Readonly<{ plan?: ResultPacket; exploration?: ResultPacket }>,
  retry?: Readonly<{ attempt: number; limit: number; reason: string; previous?: ResultPacket }>): DelegationPacket {
  const decisions = [...base.architecture.decisions];
  if (contributions.plan) decisions.push(`Lead plan: ${clip(contributions.plan.changes.summary)}`);
  if (contributions.exploration) decisions.push(`Exploration summary: ${clip(contributions.exploration.changes.summary)}`);
  const constraints = [...base.task.constraints];
  if (retry) constraints.push(`Attempt ${retry.attempt} of ${retry.limit}: ${retry.reason}`);
  return {
    task: { goal: base.task.goal, constraints: clipList(constraints), acceptanceCriteria: clipList(base.task.acceptanceCriteria) },
    scope: { relevantFiles: [...base.scope.relevantFiles], allowedFiles: [...base.scope.allowedFiles],
      forbiddenFiles: [...base.scope.forbiddenFiles] },
    architecture: { decisions: clipList(decisions), invariants: clipList(base.architecture.invariants) },
    verification: { requiredTests: [...base.verification.requiredTests] },
    openQuestions: clipList(retry?.previous ? [...base.openQuestions, ...retry.previous.failures] : base.openQuestions),
  };
}

/** The Lead reviews Fusion-observed facts; the delegate's own summary is marked as an unverified claim. */
export function reviewPacket(base: DelegationPacket, delegate: ResultPacket, changedPaths: readonly string[],
  plan: VerificationPlan, verified: boolean): DelegationPacket {
  return {
    task: { goal: base.task.goal, acceptanceCriteria: clipList(base.task.acceptanceCriteria), constraints: clipList([
      ...base.task.constraints,
      verified ? `Fusion verification passed for: ${plan.commands.map(command => command.id).join(", ")}`
        : "No Fusion verification was required for this read-only task.",
      "Approve with status completed and no failures; anything else is a rejection."]) },
    scope: { relevantFiles: clipList(changedPaths), allowedFiles: [...base.scope.allowedFiles],
      forbiddenFiles: [...base.scope.forbiddenFiles] },
    architecture: { decisions: clipList([...base.architecture.decisions,
      `Delegate summary (unverified claim): ${clip(delegate.changes.summary)}`]),
      invariants: clipList(base.architecture.invariants) },
    verification: { requiredTests: [...base.verification.requiredTests] },
    openQuestions: clipList(delegate.uncertainties),
  };
}
