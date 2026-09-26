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
 * O5.5C2 — the DELIVERY STORE: a Fusion-owned directory of prepared deliveries (by default `<repository>/.fusion/deliveries`,
 * Fusion's self-ignored state directory: never tracked, never in a provider view, never a delivery target). One directory
 * per delivery id:
 *
 *   manifest.json   IMMUTABLE  the manifest's canonical bytes (their SHA-256 is the manifest digest)
 *   bundle.json     IMMUTABLE  the serialized bundle (exact post-image bytes, base64)
 *   record.json     IMMUTABLE  the store record: id, manifest digest, bundle digest and file digest, the run reference
 *   approval.json   WRITE-ONCE the durable human approval (absent until a human approves)
 *   events.jsonl    APPEND-ONLY the lifecycle events; the state is derived from them
 *   apply.claim     CREATE-ONCE the exclusive claim of the one apply an approval allows (empty; never removed)
 *
 * Immutable files are written once: a temporary file (exclusive create, fsync), then an exclusive hard link to the final
 * name (never replaces), then the temporary removed. Re-preparing the same delivery with identical bytes is idempotent; any
 * other bytes under the same id are refused. Every read re-validates everything — sizes, shapes, the manifest's canonical
 * bytes and digest, the bundle against the manifest (every content digest recomputed), the record's bindings, the approval,
 * and each event's sequence and bindings — and a directory, file or path component that is a link or reparse point is
 * refused. The id selects a directory and is checked against the contents: never trusted alone. Corruption fails closed.
 */
export const DELIVERY_STORE_LIMITS = Object.freeze({ manifestBytes: 256 * 1024, bundleBytes: 8 * 1024 * 1024, recordBytes: 16 * 1024,
  approvalBytes: 16 * 1024, eventsBytes: 256 * 1024 });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const SHA = /^[0-9a-f]{64}$/u;
export const DELIVERY_RECORD_FORMAT = "fusion.deliveryStoreRecord" as const;

/** The run a delivery came from (digests and ids only). */
export interface DeliveryReference { readonly runId: string; readonly workflowEvidenceSha256: string }
export interface StoredDeliveryRecord {
  readonly format: typeof DELIVERY_RECORD_FORMAT;
  readonly version: 1;
  readonly deliveryId: string;
  readonly manifestSha256: string;
  readonly bundleSha256: string;
  /** SHA-256 of the stored `bundle.json` bytes. */
  readonly bundleFileSha256: string;
  readonly reference: DeliveryReference;
}
/** A delivery as loaded: every artifact revalidated, the state derived from the validated event log. */
export interface StoredDelivery {
  readonly record: StoredDeliveryRecord;
  readonly manifest: DeliveryManifest;
  readonly bundle: DeliveryBundle;
  readonly approval: HumanApprovalRecord | null;
  readonly events: readonly DeliveryEvent[];
  readonly state: DeliveryState | "incomplete";
}
export interface DeliveryStore {
  put(prepared: Readonly<{ manifest: DeliveryManifest; bundle: DeliveryBundle }>, reference: DeliveryReference, at: string): Promise<StoredDelivery>;
  load(deliveryId: string): Promise<StoredDelivery>;
  list(): Promise<readonly string[]>;
  writeApproval(deliveryId: string, approval: HumanApprovalRecord, at: string): Promise<StoredDelivery>;
  beginApply(deliveryId: string, at: string): Promise<DeliveryEvent>;
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
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(reference.runId) || !SHA.test(reference.workflowEvidenceSha256) ||
        reference.runId !== manifest.request.runId || reference.workflowEvidenceSha256 !== manifest.source.workflowEvidenceSha256)
      failWith("InvalidInput", "The delivery's run reference does not match its manifest.");
    const manifestBytes = canonicalJson(manifest), bundleBytes = serializeDeliveryBundle(bundle);
    const record: StoredDeliveryRecord = { format: DELIVERY_RECORD_FORMAT, version: 1, deliveryId: manifest.deliveryId,
      manifestSha256: sha256Hex(manifestBytes), bundleSha256: manifest.change.bundleSha256, bundleFileSha256: sha256Hex(bundleBytes),
      reference: { runId: reference.runId, workflowEvidenceSha256: reference.workflowEvidenceSha256 } };
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
          approval.repositoryIdentity !== manifest.primary.repositoryIdentity || approval.baseCommit !== manifest.primary.baseCommit)
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
    return Object.freeze({ record, manifest, bundle, approval, events: Object.freeze(events), state });
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
        checked.baseCommit !== loaded.manifest.primary.baseCommit)
      return failWith("SecurityViolation", "The approval does not bind this delivery's exact artifacts.");
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
   * Claims the one apply an approval allows: an exclusive marker (`apply.claim`, created once, never removed), then the
   * `applyStarted` event. A second claim — concurrent or later — is refused, so two processes can never both apply one
   * approval. A crash between the marker and the event leaves the delivery `approved` but unappliable (fail closed).
   */
  async beginApply(deliveryId: string, at: string): Promise<DeliveryEvent> {
    const loaded = await this.load(deliveryId);
    if (loaded.state !== "approved") return failWith("InvalidInput", `A ${loaded.state} delivery cannot be applied.`);
    const claim = join(await this.#deliveryDirectory(deliveryId, false), "apply.claim");
    try { await (await open(claim, "wx", 0o600)).close(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return failWith("WorkspaceConflict", "This delivery's apply was already claimed; an approval is used once.");
      throw error;
    }
    return this.#append(await this.load(deliveryId), { type: "applyStarted", at, observedHead: null, touchedPaths: loaded.manifest.operations.length,
      phase: null, issues: [], rollback: null });
  }

  async appendEvent(deliveryId: string, event: Omit<DeliveryEventInput, "deliveryId" | "manifestSha256" | "bundleSha256" | "repositoryIdentity" |
    "expectedHead">): Promise<DeliveryEvent> {
    if (event.type === "applyStarted") return failWith("InvalidInput", "An apply starts only through its exclusive claim.");
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

function validateRecord(value: unknown): StoredDeliveryRecord {
  const record = value as Record<string, unknown> | null;
  const keys = ["format", "version", "deliveryId", "manifestSha256", "bundleSha256", "bundleFileSha256", "reference"];
  const reference = record?.reference as Record<string, unknown> | undefined;
  if (record === null || typeof record !== "object" || Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key)) ||
      record.format !== DELIVERY_RECORD_FORMAT || record.version !== 1 || typeof record.deliveryId !== "string" || !ID.test(record.deliveryId) ||
      typeof record.manifestSha256 !== "string" || !SHA.test(record.manifestSha256) || typeof record.bundleSha256 !== "string" ||
      !SHA.test(record.bundleSha256) || typeof record.bundleFileSha256 !== "string" || !SHA.test(record.bundleFileSha256) ||
      reference === null || typeof reference !== "object" || Object.keys(reference).length !== 2 || typeof reference.runId !== "string" ||
      typeof reference.workflowEvidenceSha256 !== "string" || !SHA.test(reference.workflowEvidenceSha256))
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
