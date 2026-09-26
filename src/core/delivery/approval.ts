import { failWith } from "../errors.js";
import { validateDeliveryBundle, type DeliveryBundle } from "./bundle.js";
import { deliveryManifestSha256, validateDeliveryManifest, type DeliveryManifest } from "./manifest.js";

/**
 * O5.5C1 — the HUMAN APPROVAL BOUNDARY of a delivery. A delivery record starts `prepared`; only an approval bound to its
 * exact manifest digest moves it to `approved`; only an approved record may start applying (`applying`), which consumes the
 * approval; the applier ends it in exactly one terminal state:
 *
 *   prepared --approve--> approved --begin--> applying --> applied | failed | rolledBack | rollbackFailed
 *
 * `failed`: refused before any write (precheck or staging). `rolledBack`: a write happened and every touched path was
 * restored and verified. `rollbackFailed`: a write happened and at least one touched path could not be restored.
 *
 * An approval is an object ISSUED by an approval authority in this process (held in a private WeakSet): a parsed,
 * copied, deserialized or provider-produced record with the same fields is never an approval, a manifest's existence
 * never is one, and nothing approves automatically. O5.5C1 has exactly one authority, the TEST-ONLY one (origin
 * `testOnly`, deterministic, for local test repositories): no human approval authority and no CLI exist yet, so no real
 * delivery can be approved. An approval binds to one manifest digest and one delivery id, and can approve one record once.
 */
export const DELIVERY_STATES = Object.freeze(["prepared", "approved", "applying", "applied", "failed", "rolledBack", "rollbackFailed"] as const);
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export type DeliveryTerminalState = "applied" | "failed" | "rolledBack" | "rollbackFailed";
const TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = Object.freeze({
  prepared: ["approved"], approved: ["applying"], applying: ["applied", "failed", "rolledBack", "rollbackFailed"],
  applied: [], failed: [], rolledBack: [], rollbackFailed: [] });

export interface DeliveryApproval {
  readonly format: "fusion.deliveryApproval";
  readonly version: 1;
  readonly deliveryId: string;
  /** The exact manifest digest the human approved. */
  readonly manifestSha256: string;
  /** Who approved (a label, never a credential). */
  readonly approver: string;
  /** Which authority issued it. O5.5C1: only `testOnly`. */
  readonly origin: "testOnly";
}
const ISSUED = new WeakSet<object>();
/** Approvals already bound to a record: an approval approves one record once. */
const BOUND = new WeakSet<object>();
const APPROVER = /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/u;

/**
 * TEST-ONLY approval authority (O5.5C1): a deterministic approval of exactly one manifest digest, for deliveries into local
 * test repositories. Not wired into any command; a human approval authority is a later milestone.
 */
export function issueTestOnlyApproval(input: Readonly<{ deliveryId: string; manifestSha256: string; approver: string }>): DeliveryApproval {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(input.deliveryId) || !/^[0-9a-f]{64}$/u.test(input.manifestSha256) ||
      !APPROVER.test(input.approver)) failWith("InvalidInput", "A delivery approval needs a delivery id, a manifest digest and an approver label.");
  const approval: DeliveryApproval = Object.freeze({ format: "fusion.deliveryApproval", version: 1, deliveryId: input.deliveryId,
    manifestSha256: input.manifestSha256, approver: input.approver, origin: "testOnly" });
  ISSUED.add(approval);
  return approval;
}
/** Whether a value is an approval an authority of this process issued (never a look-alike). */
export const isIssuedApproval = (value: unknown): value is DeliveryApproval => value !== null && typeof value === "object" && ISSUED.has(value);

/**
 * One delivery: the validated manifest and bundle (private copies), their digests, its state and the approval that moved
 * it. The state machine refuses every transition it does not list.
 */
export class DeliveryRecord {
  readonly manifest: DeliveryManifest;
  readonly bundle: DeliveryBundle;
  readonly manifestSha256: string;
  #state: DeliveryState = "prepared";
  #approval: DeliveryApproval | undefined;
  readonly #history: DeliveryState[] = ["prepared"];

  constructor(manifest: unknown, bundle: unknown) {
    this.manifest = validateDeliveryManifest(manifest);
    this.bundle = validateDeliveryBundle(bundle, this.manifest);
    this.manifestSha256 = deliveryManifestSha256(this.manifest);
  }
  get state(): DeliveryState { return this.#state; }
  get approval(): DeliveryApproval | undefined { return this.#approval; }
  get history(): readonly DeliveryState[] { return Object.freeze([...this.#history]); }

  /** A human approval of exactly this manifest: `prepared` → `approved`. */
  approve(approval: unknown): void {
    if (this.#state !== "prepared") failWith("InvalidInput", `A ${this.#state} delivery cannot be approved.`);
    if (!isIssuedApproval(approval))
      failWith("SecurityViolation", "Not an approval: only an approval issued by Fusion's approval authority can approve a delivery.");
    if (approval.manifestSha256 !== this.manifestSha256 || approval.deliveryId !== this.manifest.deliveryId)
      failWith("SecurityViolation", "The approval is for another manifest than this delivery's.");
    if (BOUND.has(approval)) failWith("SecurityViolation", "The approval was already used for a delivery.");
    BOUND.add(approval);
    this.#approval = approval;
    this.#move("approved");
  }
  /** The applier starts: `approved` → `applying`; the approval is consumed. */
  beginApplying(): DeliveryApproval {
    if (this.#state !== "approved" || this.#approval === undefined)
      failWith("SecurityViolation", `Only an approved delivery can be applied (this one is ${this.#state}).`);
    this.#move("applying");
    return this.#approval;
  }
  /** The applier's verdict: `applying` → one terminal state. */
  finish(state: DeliveryTerminalState): void {
    if (this.#state !== "applying") failWith("InternalError", `A ${this.#state} delivery cannot finish.`);
    this.#move(state);
  }
  #move(to: DeliveryState): void {
    if (!TRANSITIONS[this.#state].includes(to)) failWith("InternalError", `A delivery cannot move from ${this.#state} to ${to}.`);
    this.#state = to;
    this.#history.push(to);
  }
}
