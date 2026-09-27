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
 * never is one, and nothing approves automatically. Two authorities exist: the TEST-ONLY one (O5.5C1, origin `testOnly`,
 * deterministic, for local test repositories) and, since O5.5C2, the durable HUMAN one (`approvalFromHumanRecord`, origin
 * `humanConfirmed`: a stored approval a human created by typing the exact manifest digest, re-bound to the revalidated
 * artifacts). An approval binds to one manifest digest and one delivery id, and can approve one record once.
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
  /**
   * Which authority issued it: `testOnly` (O5.5C1, tests) or `humanConfirmed` (O5.5C2: a durable approval a human created
   * by typing the exact manifest digest at an interactive terminal).
   */
  readonly origin: "testOnly" | "humanConfirmed";
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
 * O5.5C2 — the DURABLE HUMAN APPROVAL, as it is stored next to the delivery: bound to the delivery id, the manifest digest,
 * the bundle digest, the target repository identity and the baseline commit, created only from a confirmation in which a
 * human typed the exact manifest digest. It is data at rest: only `approvalFromHumanRecord`, after re-checking every
 * binding against the revalidated manifest, turns it into an approval, and that approval still only moves a `prepared`
 * record to `approved` — the applier's precheck and drift policy run unchanged. It opens no gate.
 * O5.5C4 (version 2): it also binds the checkout the delivery was prepared in (the digest of its resolved root), so the
 * human's approval is the delivery authorization for exactly one checkout.
 * v0.2: a second way to confirm, for the conversational shell (`confirmedVerifiedSummary`): the human answered an explicit
 * yes under a summary of exactly this delivery (its id, files, verification, review and manifest digest). The record binds
 * the same artifacts and checkout; only how the human confirmed differs, and it is recorded as such.
 */
export const HUMAN_APPROVAL_FORMAT = "fusion.deliveryHumanApproval" as const;
export const HUMAN_APPROVAL_VERSION = 2 as const;
export interface HumanApprovalRecord {
  readonly format: typeof HUMAN_APPROVAL_FORMAT;
  readonly version: typeof HUMAN_APPROVAL_VERSION;
  readonly deliveryId: string;
  readonly manifestSha256: string;
  readonly bundleSha256: string;
  readonly repositoryIdentity: string;
  readonly baseCommit: string;
  /** The checkout the delivery was prepared in and may be applied to (SHA-256 of its resolved root; never a path). */
  readonly checkoutSha256: string;
  /**
   * How the human confirmed at an interactive terminal: by typing the exact manifest digest (`fusion approve-delivery`), or
   * (v0.2, the shell) by an explicit yes under the summary of exactly this delivery.
   */
  readonly confirmation: HumanConfirmation;
  readonly approvedAt: string;
}
const SHA = /^[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * A durable approval from a human confirmation: `typed` must be exactly the manifest digest (optionally `sha256:`-prefixed,
 * surrounding whitespace ignored). Anything else — empty, a prefix, another digest, "y" — approves nothing.
 */
export function humanApprovalRecord(input: Readonly<{ manifest: DeliveryManifest; typed: string; approvedAt: string; checkoutSha256: string }>):
  HumanApprovalRecord {
  const manifest = validateDeliveryManifest(input.manifest);
  const digest = deliveryManifestSha256(manifest);
  const typed = typeof input.typed === "string" ? input.typed.trim() : "";
  if (typed !== digest && typed !== `sha256:${digest}`)
    failWith("InvalidInput", "The typed digest is not this delivery's exact manifest digest; nothing was approved.");
  if (!ISO.test(input.approvedAt)) failWith("InvalidInput", "An approval needs an ISO timestamp.");
  if (typeof input.checkoutSha256 !== "string" || !SHA.test(input.checkoutSha256)) failWith("InvalidInput", "An approval needs the checkout it binds.");
  return Object.freeze({ format: HUMAN_APPROVAL_FORMAT, version: HUMAN_APPROVAL_VERSION, deliveryId: manifest.deliveryId, manifestSha256: digest,
    bundleSha256: manifest.change.bundleSha256, repositoryIdentity: manifest.primary.repositoryIdentity, baseCommit: manifest.primary.baseCommit,
    checkoutSha256: input.checkoutSha256, confirmation: "typedManifestSha256", approvedAt: input.approvedAt });
}
export type HumanConfirmation = "typedManifestSha256" | "confirmedVerifiedSummary";
const CONFIRMATIONS: ReadonlySet<string> = new Set<HumanConfirmation>(["typedManifestSha256", "confirmedVerifiedSummary"]);
/** The only answers that approve under a shown summary: an explicit yes. There is no default answer. */
export const SUMMARY_APPROVAL_ANSWERS = Object.freeze(["y", "yes", "j", "ja"] as const);
/**
 * v0.2 — a durable approval from the SHELL's summary confirmation: the summary the human saw carried `shownManifestSha256`,
 * which must be exactly this manifest's digest, and the human's `answer` must be an explicit yes (`y`, `yes`, `j`, `ja`,
 * any case, surrounding whitespace ignored). Anything else — empty, "maybe", "yes please", a digest — approves nothing.
 * The record binds the same delivery id, manifest and bundle digests, repository identity, baseline and checkout as a
 * typed-digest approval; the manifest itself guarantees the verification passed under a granted acceptance and no review
 * finding is outstanding.
 */
export function summaryApprovalRecord(input: Readonly<{ manifest: DeliveryManifest; shownManifestSha256: string; answer: string; approvedAt: string;
  checkoutSha256: string }>): HumanApprovalRecord {
  const manifest = validateDeliveryManifest(input.manifest);
  const digest = deliveryManifestSha256(manifest);
  if (typeof input.shownManifestSha256 !== "string" || input.shownManifestSha256 !== digest)
    failWith("InvalidInput", "The summary that was shown is not this delivery's exact manifest; nothing was approved.");
  const answer = typeof input.answer === "string" ? input.answer.trim().toLowerCase() : "";
  if (!(SUMMARY_APPROVAL_ANSWERS as readonly string[]).includes(answer)) failWith("InvalidInput", "The answer was not an explicit yes; nothing was approved.");
  if (!ISO.test(input.approvedAt)) failWith("InvalidInput", "An approval needs an ISO timestamp.");
  if (typeof input.checkoutSha256 !== "string" || !SHA.test(input.checkoutSha256)) failWith("InvalidInput", "An approval needs the checkout it binds.");
  return Object.freeze({ format: HUMAN_APPROVAL_FORMAT, version: HUMAN_APPROVAL_VERSION, deliveryId: manifest.deliveryId, manifestSha256: digest,
    bundleSha256: manifest.change.bundleSha256, repositoryIdentity: manifest.primary.repositoryIdentity, baseCommit: manifest.primary.baseCommit,
    checkoutSha256: input.checkoutSha256, confirmation: "confirmedVerifiedSummary", approvedAt: input.approvedAt });
}
/** Validates an untrusted stored approval's exact shape (its bindings are checked by `approvalFromHumanRecord`). */
export function validateHumanApprovalRecord(value: unknown): HumanApprovalRecord {
  const keys = ["format", "version", "deliveryId", "manifestSha256", "bundleSha256", "repositoryIdentity", "baseCommit", "checkoutSha256", "confirmation",
    "approvedAt"];
  const record = value as Record<string, unknown> | null;
  if (record === null || typeof record !== "object" || Array.isArray(record) || Object.keys(record).length !== keys.length ||
      !keys.every(key => Object.hasOwn(record, key)) || record.format !== HUMAN_APPROVAL_FORMAT || record.version !== HUMAN_APPROVAL_VERSION ||
      typeof record.deliveryId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(record.deliveryId) ||
      typeof record.manifestSha256 !== "string" || !SHA.test(record.manifestSha256) || typeof record.bundleSha256 !== "string" ||
      !SHA.test(record.bundleSha256) || typeof record.repositoryIdentity !== "string" || !SHA.test(record.repositoryIdentity) ||
      typeof record.baseCommit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(record.baseCommit) ||
      typeof record.checkoutSha256 !== "string" || !SHA.test(record.checkoutSha256) || typeof record.confirmation !== "string" || !CONFIRMATIONS.has(record.confirmation) || typeof record.approvedAt !== "string" || !ISO.test(record.approvedAt))
    failWith("SecurityViolation", "The stored approval is malformed; it approves nothing.");
  return Object.freeze({ ...record }) as unknown as HumanApprovalRecord;
}
/**
 * The approval a durable human approval grants, after every binding was re-checked against the revalidated manifest and
 * the checkout it is applied in: the delivery id, the manifest digest, the bundle digest, the repository identity, the
 * baseline commit and the checkout. A stored approval for other artifacts or another checkout approves nothing.
 */
export function approvalFromHumanRecord(value: unknown, manifest: DeliveryManifest, checkoutSha256: string): DeliveryApproval {
  const record = validateHumanApprovalRecord(value);
  const checked = validateDeliveryManifest(manifest);
  if (record.deliveryId !== checked.deliveryId || record.manifestSha256 !== deliveryManifestSha256(checked) ||
      record.bundleSha256 !== checked.change.bundleSha256 || record.repositoryIdentity !== checked.primary.repositoryIdentity ||
      record.baseCommit !== checked.primary.baseCommit || record.checkoutSha256 !== checkoutSha256)
    failWith("SecurityViolation", "The stored approval does not cover these exact artifacts in this checkout; it approves nothing.");
  const approval: DeliveryApproval = Object.freeze({ format: "fusion.deliveryApproval", version: 1, deliveryId: record.deliveryId,
    manifestSha256: record.manifestSha256, approver: "interactive terminal", origin: "humanConfirmed" });
  ISSUED.add(approval);
  return approval;
}

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
