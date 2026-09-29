import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { validateHumanApprovalRecord, type DeliveryState, type HumanApprovalRecord } from "../../core/delivery/approval.js";
import { parseDeliveryBundle, serializeDeliveryBundle, validateDeliveryBundle, type DeliveryBundle } from "../../core/delivery/bundle.js";
import { canonicalJson, sha256Hex } from "../../core/delivery/canonical.js";
import { DELIVERY_EVENT_FORMAT, DELIVERY_EVENT_VERSION, deliveryStateFromEvents, MAX_DELIVERY_EVENTS, validateDeliveryEvent,
  type DeliveryEvent, type DeliveryEventInput } from "../../core/delivery/lifecycle.js";
import { deliveryManifestSha256, validateDeliveryManifest, type DeliveryManifest } from "../../core/delivery/manifest.js";
import { failWith, FusionFailure } from "../../core/errors.js";
import { BoundedReadError, readBoundedFile } from "../fs/bounded-read.js";
import { comparablePath } from "../workspace/git.js";

/**
 * O5.5C2 — the DELIVERY STORE: a Fusion-owned directory of prepared deliveries. O5.5C2.1: its production root is Fusion's
 * application state outside every target repository (`state-root.ts`, one namespace per repository identity; see
 * `app/delivery-service.ts`); tests inject a temporary root. One directory per delivery id:
 *
 *   manifest.json   IMMUTABLE  the manifest's canonical bytes (their SHA-256 is the manifest digest)
 *   bundle.json     IMMUTABLE  the serialized bundle (exact post-image bytes, base64)
 *   record.json     IMMUTABLE  the store record: id, manifest digest, bundle digest and file digest, the run reference
 *   approval.json   WRITE-ONCE the durable human approval (absent until a human approves)
 *   events.jsonl    APPEND-ONLY the lifecycle events; the state is derived from them
 *   apply.lock      TRANSIENT   O5.5C4: the exclusive lock of one apply attempt (removed when the attempt ends)
 *   apply.claim     CREATE-ONCE O5.5C4: the single-use MUTATION claim, taken after a passed precheck, immediately before the
 *                               first filesystem mutation; bound to the delivery, manifest, bundle and checkout; never removed
 *
 * Immutable files are written once: a temporary file (exclusive create, fsync), then an exclusive hard link to the final
 * name (never replaces), then the temporary removed. Re-preparing the same delivery with identical bytes is idempotent; any
 * other bytes under the same id are refused. Every read re-validates everything — sizes, shapes, the manifest's canonical
 * bytes and digest, the bundle against the manifest (every content digest recomputed), the record's bindings, the approval,
 * and each event's sequence and bindings — and a directory, file or path component that is a link or reparse point is
 * refused. The id selects a directory and is checked against the contents: never trusted alone. Corruption fails closed.
 */
export const DELIVERY_STORE_LIMITS = Object.freeze({ manifestBytes: 256 * 1024, bundleBytes: 8 * 1024 * 1024, recordBytes: 16 * 1024,
  approvalBytes: 16 * 1024, eventsBytes: 256 * 1024, claimBytes: 4 * 1024 });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const SHA = /^[0-9a-f]{64}$/u;
export const DELIVERY_RECORD_FORMAT = "fusion.deliveryStoreRecord" as const;
/** Version 2 (O5.5C2.1): the reference binds the checkout the delivery was prepared in. */
export const DELIVERY_RECORD_VERSION = 2 as const;

/** The run a delivery came from and the checkout it was prepared in (ids and digests only, never a path). */
export interface DeliveryReference { readonly runId: string; readonly workflowEvidenceSha256: string; readonly checkoutSha256: string }
export interface StoredDeliveryRecord {
  readonly format: typeof DELIVERY_RECORD_FORMAT;
  readonly version: typeof DELIVERY_RECORD_VERSION;
  readonly deliveryId: string;
  readonly manifestSha256: string;
  readonly bundleSha256: string;
  /** SHA-256 of the stored `bundle.json` bytes. */
  readonly bundleFileSha256: string;
  readonly reference: DeliveryReference;
}
/** O5.5C4: the single-use mutation claim, bound to exactly one delivery, its artifacts and its checkout. */
export const DELIVERY_CLAIM_FORMAT = "fusion.deliveryApplyClaim" as const;
export interface DeliveryApplyClaim {
  readonly format: typeof DELIVERY_CLAIM_FORMAT;
  readonly version: 1;
  readonly deliveryId: string;
  readonly manifestSha256: string;
  readonly bundleSha256: string;
  readonly checkoutSha256: string;
  readonly claimedAt: string;
}
/** A delivery as loaded: every artifact revalidated, the state derived from the validated event log. */
export interface StoredDelivery {
  readonly record: StoredDeliveryRecord;
  readonly manifest: DeliveryManifest;
  readonly bundle: DeliveryBundle;
  readonly approval: HumanApprovalRecord | null;
  readonly events: readonly DeliveryEvent[];
  readonly state: DeliveryState | "incomplete";
  /** The mutation claim, once taken: the approval is spent. */
  readonly claim: DeliveryApplyClaim | null;
  /** An apply attempt holds (or an interrupted one left) the attempt lock. */
  readonly attemptLocked: boolean;
}
export interface DeliveryStore {
  put(prepared: Readonly<{ manifest: DeliveryManifest; bundle: DeliveryBundle }>, reference: DeliveryReference, at: string): Promise<StoredDelivery>;
  load(deliveryId: string): Promise<StoredDelivery>;
  list(): Promise<readonly string[]>;
  writeApproval(deliveryId: string, approval: HumanApprovalRecord, at: string): Promise<StoredDelivery>;
  acquireAttempt(deliveryId: string): Promise<StoredDelivery>;
  acquireRecoveryAttempt(deliveryId: string): Promise<StoredDelivery>;
  releaseAttempt(deliveryId: string): Promise<void>;
  claimMutation(deliveryId: string, checkoutSha256: string, at: string): Promise<DeliveryEvent>;
  appendEvent(deliveryId: string, event: Omit<DeliveryEventInput, "deliveryId" | "manifestSha256" | "bundleSha256" | "repositoryIdentity" |
    "expectedHead">): Promise<DeliveryEvent>;
}

const corrupt = (what: string): never => failWith("SecurityViolation", `The stored delivery is corrupt or tampered (${what}); it is not used.`);
const missing = (): never => failWith("InvalidInput", "No delivery with that id exists in this repository's delivery store.");

export class FilesystemDeliveryStore implements DeliveryStore {
  readonly root: string;
  constructor(root: string) {
    if (typeof root !== "string" || !isAbsolute(root)) failWith("InvalidInput", "The delivery store root must be an absolute path.");
    this.root = resolve(root);
  }

  async list(): Promise<readonly string[]> {
    if (!await this.#realDirectory(this.root, false)) return [];
    return (await readdir(this.root)).filter(name => ID.test(name)).sort();
  }

  async put(prepared: Readonly<{ manifest: DeliveryManifest; bundle: DeliveryBundle }>, reference: DeliveryReference, at: string): Promise<StoredDelivery> {
    const manifest = validateDeliveryManifest(prepared.manifest);
    const bundle = validateDeliveryBundle(prepared.bundle, manifest);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(reference.runId) || !SHA.test(reference.workflowEvidenceSha256) || !SHA.test(reference.checkoutSha256) ||
        reference.runId !== manifest.request.runId || reference.workflowEvidenceSha256 !== manifest.source.workflowEvidenceSha256)
      failWith("InvalidInput", "The delivery's run reference does not match its manifest.");
    const manifestBytes = canonicalJson(manifest), bundleBytes = serializeDeliveryBundle(bundle);
    const record: StoredDeliveryRecord = { format: DELIVERY_RECORD_FORMAT, version: DELIVERY_RECORD_VERSION, deliveryId: manifest.deliveryId,
      manifestSha256: sha256Hex(manifestBytes), bundleSha256: manifest.change.bundleSha256, bundleFileSha256: sha256Hex(bundleBytes),
      reference: { runId: reference.runId, workflowEvidenceSha256: reference.workflowEvidenceSha256, checkoutSha256: reference.checkoutSha256 } };
    await this.#realDirectory(this.root, true);
    const dir = await this.#deliveryDirectory(manifest.deliveryId, true);
    await writeOnce(join(dir, "manifest.json"), manifestBytes, DELIVERY_STORE_LIMITS.manifestBytes);
    await writeOnce(join(dir, "bundle.json"), bundleBytes, DELIVERY_STORE_LIMITS.bundleBytes);
    await writeOnce(join(dir, "record.json"), canonicalJson(record), DELIVERY_STORE_LIMITS.recordBytes);
    const loaded = await this.load(manifest.deliveryId, true);
    if (loaded.events.length > 0) return loaded;
    await this.#append(loaded, { type: "prepared", at, observedHead: null, touchedPaths: manifest.operations.length, phase: null, issues: [], rollback: null });
    return this.load(manifest.deliveryId);
  }

  async load(deliveryId: string, allowIncomplete = false): Promise<StoredDelivery> {
    if (typeof deliveryId !== "string" || !ID.test(deliveryId)) return failWith("InvalidInput", "That is not a delivery id.");
    if (!await this.#realDirectory(this.root, false)) return missing();
    const dir = await this.#deliveryDirectory(deliveryId, false);
    const manifestBytes = await readStored(join(dir, "manifest.json"), DELIVERY_STORE_LIMITS.manifestBytes, true);
    const bundleBytes = await readStored(join(dir, "bundle.json"), DELIVERY_STORE_LIMITS.bundleBytes, true);
    const recordBytes = await readStored(join(dir, "record.json"), DELIVERY_STORE_LIMITS.recordBytes, true);
    let manifest: DeliveryManifest, bundle: DeliveryBundle, record: StoredDeliveryRecord;
    try {
      manifest = validateDeliveryManifest(JSON.parse(manifestBytes!.toString("utf8")));
      if (canonicalJson(manifest) !== manifestBytes!.toString("utf8")) return corrupt("manifest bytes are not canonical");
      bundle = validateDeliveryBundle(parseDeliveryBundle(bundleBytes!.toString("utf8")), manifest);
      record = validateRecord(JSON.parse(recordBytes!.toString("utf8")));
    } catch (error) {
      if (error instanceof FusionFailure && error.error.safeMessage.startsWith("The stored delivery is corrupt")) throw error;
      return corrupt("an artifact failed validation");
    }
    const manifestSha256 = deliveryManifestSha256(manifest);
    if (manifest.deliveryId !== deliveryId || record.deliveryId !== deliveryId || record.manifestSha256 !== manifestSha256 ||
        sha256Hex(manifestBytes!) !== manifestSha256 || record.bundleSha256 !== manifest.change.bundleSha256 ||
        record.bundleFileSha256 !== sha256Hex(bundleBytes!) || record.reference.runId !== manifest.request.runId ||
        record.reference.workflowEvidenceSha256 !== manifest.source.workflowEvidenceSha256)
      return corrupt("the record does not bind these artifacts");
    const approvalBytes = await readStored(join(dir, "approval.json"), DELIVERY_STORE_LIMITS.approvalBytes, false);
    let approval: HumanApprovalRecord | null = null;
    if (approvalBytes !== undefined) {
      try { approval = validateHumanApprovalRecord(JSON.parse(approvalBytes.toString("utf8"))); }
      catch { return corrupt("the stored approval failed validation"); }
      if (canonicalJson(approval) !== approvalBytes.toString("utf8")) return corrupt("the stored approval is not canonical");
      if (approval.deliveryId !== deliveryId || approval.manifestSha256 !== manifestSha256 || approval.bundleSha256 !== manifest.change.bundleSha256 ||
          approval.repositoryIdentity !== manifest.primary.repositoryIdentity || approval.baseCommit !== manifest.primary.baseCommit ||
          approval.checkoutSha256 !== record.reference.checkoutSha256)
        return corrupt("the stored approval does not bind these artifacts");
    }
    const eventBytes = await readStored(join(dir, "events.jsonl"), DELIVERY_STORE_LIMITS.eventsBytes, false);
    const lines = eventBytes === undefined ? [] : eventBytes.toString("utf8").split("\n");
    if (lines.length > 0 && lines.at(-1) !== "") return corrupt("the last event is torn");
    const expected = { deliveryId, manifestSha256, bundleSha256: manifest.change.bundleSha256, repositoryIdentity: manifest.primary.repositoryIdentity,
      expectedHead: manifest.primary.baseCommit };
    const events = lines.slice(0, -1).map((line, index) => {
      let value: unknown;
      try { value = JSON.parse(line); } catch { return corrupt("an event is not JSON"); }
      const event = validateDeliveryEvent(value, { ...expected, seq: index + 1 });
      if (canonicalJson(event) !== line) return corrupt("an event is not canonical");
      return event;
    });
    const state = deliveryStateFromEvents(events);
    if (state === "incomplete" && !allowIncomplete) return corrupt("the delivery was never completely prepared");
    // The approval and the log agree: an approved (or later) delivery has exactly its approval on disk, a prepared one none.
    const approvedInLog = events.some(event => event.type === "approved");
    if (approvedInLog !== (approval !== null) && !(approval !== null && !approvedInLog && state === "prepared"))
      return corrupt("the approval and the event log disagree");
    // The claim and the log agree: a claimed delivery has exactly its claim on disk; a claim without its event is allowed
    // only right after a passed precheck (a crash between the claim and its event), then the delivery can never be applied.
    const claimBytes = await readStored(join(dir, CLAIM_FILE), DELIVERY_STORE_LIMITS.claimBytes, false);
    let claim: DeliveryApplyClaim | null = null;
    if (claimBytes !== undefined) {
      try { claim = validateClaim(JSON.parse(claimBytes.toString("utf8"))); } catch { return corrupt("the apply claim failed validation"); }
      if (canonicalJson(claim) !== claimBytes.toString("utf8") || claim.deliveryId !== deliveryId || claim.manifestSha256 !== manifestSha256 ||
          claim.bundleSha256 !== record.bundleSha256 || claim.checkoutSha256 !== record.reference.checkoutSha256)
        return corrupt("the apply claim does not bind these artifacts");
    }
    const types = events.map(event => event.type), passed = types.lastIndexOf("precheckPassed");
    const claimedInLog = types.includes("claimAcquired");
    if (claimedInLog && claim === null) return corrupt("the log records a claim that does not exist");
    if (claim !== null && !claimedInLog && !(passed >= 0 && (passed === types.length - 1 || (passed === types.length - 2 && types.at(-1) === "failed"))))
      return corrupt("an apply claim exists without a passed precheck");
    const lock = await lstat(join(dir, LOCK_FILE)).catch(() => undefined);
    if (lock !== undefined && (!lock.isFile() || lock.isSymbolicLink())) return corrupt("the attempt lock is not a regular file");
    return Object.freeze({ record, manifest, bundle, approval, events: Object.freeze(events), state, claim, attemptLocked: lock !== undefined });
  }

  /**
   * Stores the durable human approval (write-once), then the `approved` event. The approval must bind exactly this
   * delivery's revalidated artifacts, and only a `prepared` delivery can be approved.
   */
  async writeApproval(deliveryId: string, approval: HumanApprovalRecord, at: string): Promise<StoredDelivery> {
    const loaded = await this.load(deliveryId);
    if (loaded.state !== "prepared") return failWith("InvalidInput", `A ${loaded.state} delivery cannot be approved again.`);
    const checked = validateHumanApprovalRecord(approval);
    if (checked.deliveryId !== deliveryId || checked.manifestSha256 !== loaded.record.manifestSha256 ||
        checked.bundleSha256 !== loaded.record.bundleSha256 || checked.repositoryIdentity !== loaded.manifest.primary.repositoryIdentity ||
        checked.baseCommit !== loaded.manifest.primary.baseCommit || checked.checkoutSha256 !== loaded.record.reference.checkoutSha256)
      return failWith("SecurityViolation", "The approval does not bind this delivery's exact artifacts and checkout.");
    const dir = await this.#deliveryDirectory(deliveryId, false);
    // A crash between the approval file and its event leaves the stored approval pending: it (already bound to these exact
    // artifacts by a human's confirmation) is completed by the event, never replaced.
    if (loaded.approval === null) await writeOnce(join(dir, "approval.json"), canonicalJson(checked), DELIVERY_STORE_LIMITS.approvalBytes);
    const withApproval = await this.load(deliveryId);
    await this.#append(withApproval, { type: "approved", at, observedHead: null, touchedPaths: loaded.manifest.operations.length, phase: null,
      issues: [], rollback: null });
    return this.load(deliveryId);
  }

  /**
   * O5.5C4: takes the exclusive lock of ONE apply attempt (`apply.lock`, created with `wx`). Only an approved, unclaimed
   * delivery can be attempted; a concurrent attempt — or one left by an interrupted attempt — is refused with nothing changed.
   * The lock serializes the attempt's events; it is released when the attempt ends (`releaseAttempt`).
   */
  async acquireAttempt(deliveryId: string): Promise<StoredDelivery> {
    const loaded = await this.load(deliveryId);
    if (loaded.state !== "approved")
      return failWith("InvalidInput", `A ${loaded.state} delivery cannot be applied (an approval is spent by its one claimed apply; prepare a new delivery).`);
    if (loaded.claim !== null)
      return failWith("InvalidInput", "This delivery's mutation claim was already taken; an approval is spent by its one claimed apply.");
    try { await (await open(join(await this.#deliveryDirectory(deliveryId, false), LOCK_FILE), "wx", 0o600)).close(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return failWith("WorkspaceConflict", "Another apply of this delivery is running, or an earlier attempt was interrupted before its claim; nothing was changed.");
      throw error;
    }
    return this.load(deliveryId);
  }
  /**
   * v0.6 I1: takes the attempt lock to RECOVER an interrupted apply — a delivery durably in `applying` (its single-use
   * claim taken and `applyStarted` recorded, but no terminal event) whose owning process died. Any attempt lock the dead
   * process left is replaced (an interrupted mutating state is not a live writer). Single-writer safety against a LIVE
   * concurrent process is added by the v0.6 run lease (PR I2); this method assumes the interrupted owner is gone, which
   * on a single machine an `applying` state with a stale lock indicates. Only an `applying` delivery is recoverable here.
   */
  async acquireRecoveryAttempt(deliveryId: string): Promise<StoredDelivery> {
    const loaded = await this.load(deliveryId);
    if (loaded.state !== "applying" || loaded.claim === null)
      return failWith("InvalidInput", `A ${loaded.state} delivery is not an interrupted apply to recover.`);
    const lock = join(await this.#deliveryDirectory(deliveryId, false), LOCK_FILE);
    const handle = await open(lock, "w", 0o600); // takeover: the interrupted owner is gone
    await handle.close();
    return this.load(deliveryId);
  }
  /** Releases the attempt lock (idempotent). */
  async releaseAttempt(deliveryId: string): Promise<void> {
    await unlink(join(await this.#deliveryDirectory(deliveryId, false), LOCK_FILE)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  /**
   * O5.5C4: takes the SINGLE-USE MUTATION CLAIM — only right after a passed precheck, immediately before the first
   * filesystem mutation — and records `claimAcquired`. The claim (`apply.claim`, `wx`, never removed) binds the delivery,
   * the manifest and bundle digests and the checkout; from here on the approval is spent, whatever follows.
   */
  async claimMutation(deliveryId: string, checkoutSha256: string, at: string): Promise<DeliveryEvent> {
    const loaded = await this.load(deliveryId);
    if (loaded.events.at(-1)?.type !== "precheckPassed" || loaded.claim !== null)
      return failWith("InvalidInput", "A mutation claim is taken only right after a passed precheck, once.");
    if (checkoutSha256 !== loaded.record.reference.checkoutSha256)
      return failWith("SecurityViolation", "The mutation claim must bind the checkout the delivery was prepared in.");
    const claim: DeliveryApplyClaim = { format: DELIVERY_CLAIM_FORMAT, version: 1, deliveryId, manifestSha256: loaded.record.manifestSha256,
      bundleSha256: loaded.record.bundleSha256, checkoutSha256, claimedAt: at };
    const path = join(await this.#deliveryDirectory(deliveryId, false), CLAIM_FILE);
    let handle;
    try { handle = await open(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return failWith("WorkspaceConflict", "The mutation claim was already taken.");
      throw error;
    }
    try { await handle.writeFile(canonicalJson(claim), "utf8"); await handle.sync(); } finally { await handle.close(); }
    return this.#append(await this.load(deliveryId), { type: "claimAcquired", at, observedHead: null, touchedPaths: loaded.manifest.operations.length,
      phase: "claim", issues: [], rollback: null });
  }

  async appendEvent(deliveryId: string, event: Omit<DeliveryEventInput, "deliveryId" | "manifestSha256" | "bundleSha256" | "repositoryIdentity" |
    "expectedHead">): Promise<DeliveryEvent> {
    if (event.type === "claimAcquired" || event.type === "prepared" || event.type === "approved")
      return failWith("InvalidInput", "That event is recorded only by its own store operation.");
    return this.#append(await this.load(deliveryId), event);
  }

  async #append(loaded: StoredDelivery, input: Omit<DeliveryEventInput, "deliveryId" | "manifestSha256" | "bundleSha256" | "repositoryIdentity" |
    "expectedHead">): Promise<DeliveryEvent> {
    if (loaded.events.length >= MAX_DELIVERY_EVENTS) return failWith("InvalidInput", "The delivery's event log is full.");
    const event: DeliveryEvent = { format: DELIVERY_EVENT_FORMAT, version: DELIVERY_EVENT_VERSION, seq: loaded.events.length + 1, type: input.type,
      at: input.at, deliveryId: loaded.record.deliveryId, manifestSha256: loaded.record.manifestSha256, bundleSha256: loaded.record.bundleSha256,
      repositoryIdentity: loaded.manifest.primary.repositoryIdentity, expectedHead: loaded.manifest.primary.baseCommit, observedHead: input.observedHead,
      touchedPaths: input.touchedPaths, phase: input.phase, issues: [...input.issues].slice(0, 16), rollback: input.rollback };
    // The event must be one the lifecycle allows right now (the whole log is re-derived with it).
    deliveryStateFromEvents([...loaded.events, validateDeliveryEvent(JSON.parse(canonicalJson(event)), { seq: event.seq,
      deliveryId: event.deliveryId, manifestSha256: event.manifestSha256, bundleSha256: event.bundleSha256, repositoryIdentity: event.repositoryIdentity,
      expectedHead: event.expectedHead })]);
    const path = join(await this.#deliveryDirectory(loaded.record.deliveryId, false), "events.jsonl");
    const info = await lstat(path).catch(() => undefined);
    if (info !== undefined && (!info.isFile() || info.isSymbolicLink())) return corrupt("the event log is not a regular file");
    const handle = await open(path, info === undefined ? "wx" : "a", 0o600);
    try { await handle.appendFile(`${canonicalJson(event)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    return event;
  }

  /** The store root (or a delivery directory) as a real directory — never a link or reparse point; created only when asked. */
  async #realDirectory(path: string, create: boolean): Promise<boolean> {
    let info = await lstat(path).catch(() => undefined);
    if (info === undefined) {
      if (!create) return false;
      await mkdir(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
      info = await lstat(path);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || comparablePath(await realpath(path)) !== comparablePath(path))
      return corrupt("a store directory is a link, a reparse point or not a directory");
    return true;
  }
  async #deliveryDirectory(deliveryId: string, create: boolean): Promise<string> {
    const dir = join(this.root, deliveryId);
    if (!await this.#realDirectory(dir, create)) return missing();
    return dir;
  }
}

const LOCK_FILE = "apply.lock", CLAIM_FILE = "apply.claim";
function validateClaim(value: unknown): DeliveryApplyClaim {
  const claim = value as Record<string, unknown> | null;
  const keys = ["format", "version", "deliveryId", "manifestSha256", "bundleSha256", "checkoutSha256", "claimedAt"];
  if (claim === null || typeof claim !== "object" || Array.isArray(claim) || Object.keys(claim).length !== keys.length ||
      !keys.every(key => Object.hasOwn(claim, key)) || claim.format !== DELIVERY_CLAIM_FORMAT || claim.version !== 1 ||
      typeof claim.deliveryId !== "string" || !ID.test(claim.deliveryId) || typeof claim.manifestSha256 !== "string" || !SHA.test(claim.manifestSha256) ||
      typeof claim.bundleSha256 !== "string" || !SHA.test(claim.bundleSha256) || typeof claim.checkoutSha256 !== "string" ||
      !SHA.test(claim.checkoutSha256) || typeof claim.claimedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(claim.claimedAt))
    return corrupt("the apply claim is malformed");
  return Object.freeze({ ...claim }) as unknown as DeliveryApplyClaim;
}

function validateRecord(value: unknown): StoredDeliveryRecord {
  const record = value as Record<string, unknown> | null;
  const keys = ["format", "version", "deliveryId", "manifestSha256", "bundleSha256", "bundleFileSha256", "reference"];
  const reference = record?.reference as Record<string, unknown> | undefined;
  if (record === null || typeof record !== "object" || Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key)) ||
      record.format !== DELIVERY_RECORD_FORMAT || record.version !== DELIVERY_RECORD_VERSION || typeof record.deliveryId !== "string" || !ID.test(record.deliveryId) ||
      typeof record.manifestSha256 !== "string" || !SHA.test(record.manifestSha256) || typeof record.bundleSha256 !== "string" ||
      !SHA.test(record.bundleSha256) || typeof record.bundleFileSha256 !== "string" || !SHA.test(record.bundleFileSha256) ||
      reference === null || typeof reference !== "object" || Object.keys(reference).length !== 3 || typeof reference.runId !== "string" ||
      typeof reference.workflowEvidenceSha256 !== "string" || !SHA.test(reference.workflowEvidenceSha256) ||
      typeof reference.checkoutSha256 !== "string" || !SHA.test(reference.checkoutSha256))
    return corrupt("the store record is malformed");
  return Object.freeze({ ...record, reference: Object.freeze({ ...reference }) }) as unknown as StoredDeliveryRecord;
}

/** A stored file: a regular file (never a link), within its bound; `undefined` when absent and not required. */
async function readStored(path: string, maxBytes: number, required: boolean): Promise<Buffer | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return required ? corrupt("an artifact is missing") : undefined;
  if (!info.isFile() || info.isSymbolicLink()) return corrupt("an artifact is not a regular file");
  try { return await readBoundedFile(path, maxBytes); }
  catch (error) { if (error instanceof BoundedReadError) return corrupt(`an artifact is ${error.reason === "tooLarge" ? "too large" : "not a regular file"}`); throw error; }
}

/**
 * Writes `content` to `path` exactly once: a temporary file (exclusive create, fsync), then an exclusive hard link (never
 * replaces). An existing file with identical bytes is accepted (idempotent); different bytes are refused. Where hard links
 * are unavailable, the temporary file is renamed after re-checking that the name is still free (a narrow race, documented).
 */
async function writeOnce(path: string, content: string, maxBytes: number): Promise<void> {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > maxBytes) failWith("InvalidInput", "A delivery artifact exceeds its size bound.");
  const existing = await readStored(path, maxBytes, false);
  if (existing !== undefined) {
    if (!existing.equals(bytes)) failWith("SecurityViolation", "A different delivery already uses this id; stored artifacts are never replaced.");
    return;
  }
  const temporary = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    try { await link(temporary, path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const raced = await readStored(path, maxBytes, true);
        if (!raced!.equals(bytes)) failWith("SecurityViolation", "A different delivery already uses this id; stored artifacts are never replaced.");
        return;
      }
      if (await lstat(path).catch(() => undefined) !== undefined) failWith("SecurityViolation", "A stored artifact appeared concurrently.");
      await rename(temporary, path);
    }
  } finally { await unlink(temporary).catch(() => undefined); }
}
