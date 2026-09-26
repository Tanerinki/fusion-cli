import { failWith } from "../errors.js";
import type { DeliveryState } from "./approval.js";

/**
 * O5.5C2 — a delivery's LIFECYCLE as an append-only event log. Each event carries only bounded metadata: the delivery id,
 * the manifest and bundle digests, the target repository identity, the expected (and, once seen, observed) HEAD, the
 * touched-path count, a phase label, issue reason labels and the rollback counts — never content, provider text or a
 * credential. The state is DERIVED from the log by a strict machine; an event the machine does not allow at its position
 * makes the log corrupt, and a corrupt log is never read as any state.
 *
 * O5.5C4 (version 2) — the production apply policy: a read-only precheck runs BEFORE the single-use mutation claim, so a
 * failed precheck mutates nothing and keeps the approval (the human may fix benign drift and try again); the claim is
 * acquired only after a passed precheck, immediately before the first filesystem mutation, and consumes the approval for
 * good, whatever follows:
 *
 *   prepared -> approved -> precheckStarted -> precheckFailed -> precheckStarted -> ...        (state stays `approved`)
 *                                           -> precheckPassed -> claimAcquired -> applyStarted
 *                                                             -> applied | failed | rolledBack | rollbackFailed
 */
export const DELIVERY_EVENT_FORMAT = "fusion.deliveryEvent" as const;
export const DELIVERY_EVENT_VERSION = 2 as const;
export const DELIVERY_EVENT_TYPES = Object.freeze(["prepared", "approved", "precheckStarted", "precheckPassed", "precheckFailed", "claimAcquired",
  "applyStarted", "applied", "failed", "rolledBack", "rollbackFailed"] as const);
export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];
export const MAX_DELIVERY_EVENTS = 64;
export const MAX_EVENT_ISSUES = 16;

export interface DeliveryEvent {
  readonly format: typeof DELIVERY_EVENT_FORMAT;
  readonly version: typeof DELIVERY_EVENT_VERSION;
  readonly seq: number;
  readonly type: DeliveryEventType;
  readonly at: string;
  readonly deliveryId: string;
  readonly manifestSha256: string;
  readonly bundleSha256: string;
  readonly repositoryIdentity: string;
  readonly expectedHead: string;
  /** The primary's HEAD as the applier observed it (`null` when no apply ran yet). */
  readonly observedHead: string | null;
  readonly touchedPaths: number;
  readonly phase: string | null;
  /** Issue reason labels (with repository-relative paths), bounded. */
  readonly issues: readonly string[];
  readonly rollback: Readonly<{ restored: number; failed: number }> | null;
}
/** The fields a caller supplies; the store assigns `seq`, `format` and `version`. */
export type DeliveryEventInput = Omit<DeliveryEvent, "format" | "version" | "seq">;

/**
 * The only orders the log accepts. A failed precheck returns to `approved` (nothing was mutated); a passed precheck is
 * followed by the claim (or by `failed` when the claim could not be taken — the approval is then spent, fail closed); only a
 * claimed delivery starts its apply, and only a started apply ends applied, rolled back or with a failed rollback.
 */
const NEXT: Readonly<Record<string, readonly DeliveryEventType[]>> = Object.freeze({
  none: ["prepared"], prepared: ["approved"], approved: ["precheckStarted"], precheckStarted: ["precheckPassed", "precheckFailed"],
  precheckFailed: ["precheckStarted"], precheckPassed: ["claimAcquired", "failed"], claimAcquired: ["applyStarted", "failed"],
  applyStarted: ["applied", "failed", "rolledBack", "rollbackFailed"], applied: [], failed: [], rolledBack: [], rollbackFailed: [] });
/** Before the claim the delivery is still `approved` (retryable); from the claim on it is `applying`, then terminal. */
const STATE: Readonly<Record<DeliveryEventType, DeliveryState>> = Object.freeze({ prepared: "prepared", approved: "approved",
  precheckStarted: "approved", precheckPassed: "approved", precheckFailed: "approved", claimAcquired: "applying", applyStarted: "applying",
  applied: "applied", failed: "failed", rolledBack: "rolledBack", rollbackFailed: "rollbackFailed" });
const SHA = /^[0-9a-f]{64}$/u;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const KEYS = ["format", "version", "seq", "type", "at", "deliveryId", "manifestSha256", "bundleSha256", "repositoryIdentity", "expectedHead",
  "observedHead", "touchedPaths", "phase", "issues", "rollback"];
const corrupt = (why: string): never => failWith("SecurityViolation", `The delivery's event log is corrupt (${why}); it is not read as any state.`);

/** Validates one untrusted event and its place in the log (its `seq` and its binding to the delivery's identities). */
export function validateDeliveryEvent(value: unknown, expected: Readonly<{ seq: number; deliveryId: string; manifestSha256: string;
  bundleSha256: string; repositoryIdentity: string; expectedHead: string }>): DeliveryEvent {
  const event = value as Record<string, unknown> | null;
  if (event === null || typeof event !== "object" || Array.isArray(event) || Object.keys(event).length !== KEYS.length ||
      !KEYS.every(key => Object.hasOwn(event, key)) || event.format !== DELIVERY_EVENT_FORMAT || event.version !== DELIVERY_EVENT_VERSION)
    return corrupt("shape");
  if (event.seq !== expected.seq) return corrupt("sequence");
  if (!(DELIVERY_EVENT_TYPES as readonly unknown[]).includes(event.type) || typeof event.at !== "string" || !ISO.test(event.at)) return corrupt("type");
  if (event.deliveryId !== expected.deliveryId || event.manifestSha256 !== expected.manifestSha256 || event.bundleSha256 !== expected.bundleSha256 ||
      event.repositoryIdentity !== expected.repositoryIdentity || event.expectedHead !== expected.expectedHead) return corrupt("binding");
  if (!(event.observedHead === null || (typeof event.observedHead === "string" && OBJECT_ID.test(event.observedHead))) ||
      !Number.isSafeInteger(event.touchedPaths) || (event.touchedPaths as number) < 0 || (event.touchedPaths as number) > 256 ||
      !(event.phase === null || (typeof event.phase === "string" && /^[A-Za-z]{1,32}$/u.test(event.phase))) ||
      !Array.isArray(event.issues) || event.issues.length > MAX_EVENT_ISSUES ||
      !event.issues.every(issue => typeof issue === "string" && issue.length <= 600 && !/[\x00-\x1f\x7f]/u.test(issue)))
    return corrupt("fields");
  const rollback = event.rollback as Record<string, unknown> | null;
  if (!(rollback === null || (typeof rollback === "object" && !Array.isArray(rollback) && Object.keys(rollback).length === 2 &&
      Number.isSafeInteger(rollback.restored) && Number.isSafeInteger(rollback.failed) && (rollback.restored as number) >= 0 &&
      (rollback.failed as number) >= 0))) return corrupt("rollback");
  if (!SHA.test(expected.manifestSha256)) return corrupt("binding");
  return Object.freeze({ ...event, issues: Object.freeze([...event.issues]), ...(rollback === null ? {} : { rollback: Object.freeze({ ...rollback }) }) }) as
    unknown as DeliveryEvent;
}

/**
 * The state a validated event log describes, by the strict lifecycle machine. An empty log is `incomplete` (a preparation
 * that crashed before its first event): never a usable state.
 */
export function deliveryStateFromEvents(events: readonly DeliveryEvent[]): DeliveryState | "incomplete" {
  if (events.length > MAX_DELIVERY_EVENTS) return corrupt("too many events");
  let position = "none";
  for (const event of events) {
    if (!NEXT[position]!.includes(event.type)) return corrupt(`${event.type} after ${position}`);
    position = event.type;
  }
  return position === "none" ? "incomplete" : STATE[position as DeliveryEventType];
}
