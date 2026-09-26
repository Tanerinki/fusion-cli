import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalChangeSetJson } from "../core/change/contract.js";
import { approvalFromHumanRecord, DeliveryRecord, humanApprovalRecord, type DeliveryState } from "../core/delivery/approval.js";
import { canonicalJson, sha256Hex } from "../core/delivery/canonical.js";
import { unifiedDiff } from "../core/delivery/diff.js";
import type { DeliveryEventType } from "../core/delivery/lifecycle.js";
import type { DeliveryManifest, DeliveryOperationKind } from "../core/delivery/manifest.js";
import type { ChangeScope } from "../core/domain.js";
import { failWith, FusionFailure } from "../core/errors.js";
import type { WorkflowResult } from "../core/workflow/types.js";
import { LocalFilesystemDeliveryApplier, readPrimaryIdentity, type DeliveryIssue } from "../platform/delivery/applier.js";
import { defaultDeliveryStoreBase } from "../platform/delivery/state-root.js";
import { FilesystemDeliveryStore, type StoredDelivery } from "../platform/delivery/store.js";
import { isContainedPath } from "../platform/events/shared.js";
import { comparablePath, ProcessGitClient, type GitClient } from "../platform/workspace/git.js";
import { providerWorkspaceStatePaths } from "../runtime/provider-profiles.js";
import type { ControlPlane } from "./control-plane.js";
import { prepareRunDelivery } from "./delivery-composition.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED } from "./writer-gate.js";

/**
 * O5.5C2 — the delivery product layer over the O5.5C1 foundation: prepare-and-store, inspect, durable human approval and
 * gated apply. Provider-free: no step starts a provider, a model or any repository code (Git runs read-only with hooks,
 * fsmonitor and global configuration off).
 *
 * O5.5C2.1 — the store lives in Fusion's OWN application state (`defaultDeliveryStoreBase`: `%LOCALAPPDATA%\Fusion\deliveries`,
 * `$XDG_STATE_HOME/fusion/deliveries`), OUTSIDE every target repository: never in its directory, so never in a provider
 * view (views are built from the repository) and untouched by a checkout, a clean or the repository's deletion. It is
 * namespaced per repository identity (the digest of the root commits — never a path or a name), and each delivery is bound
 * to the checkout it was prepared in (the digest of that checkout's resolved root), exactly as when it lived inside it.
 */
export interface DeliveryRepository {
  /** The repository's resolved top level. */
  readonly root: string;
  readonly git: GitClient;
  /** The delivery-state base directory (the production default, or a test harness's injected root). */
  readonly storeBase: string;
}
export interface DeliveryNamespace {
  readonly store: FilesystemDeliveryStore;
  readonly repositoryIdentity: string;
  readonly checkoutSha256: string;
  /** The resolved base directory (outside the repository). */
  readonly base: string;
}

/** The checkout binding: the SHA-256 of the checkout's resolved, comparable root path (a digest, never used as a path). */
export const checkoutDigest = (root: string): string => sha256Hex(comparablePath(root));

/** `path` with its longest existing prefix resolved through links: where creating it would really land. */
async function resolvedThroughExisting(path: string): Promise<string> {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    const real = await realpath(current).catch(() => undefined);
    if (real !== undefined) return join(real, ...[...rest].reverse());
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    rest.push(basename(current));
    current = parent;
  }
}
const overlaps = (a: string, b: string): boolean => isContainedPath(a, b) || isContainedPath(b, a);

/**
 * The repository's namespace of the delivery store, `<base>/<repository identity>`. A base that overlaps the repository —
 * resolved through links, checked before anything is created and again after — is refused: no variable, seam or link can
 * put delivery state into the tree it delivers to. `create` makes the base directories.
 */
export async function openDeliveryNamespace(repository: DeliveryRepository, create: boolean, signal?: AbortSignal): Promise<DeliveryNamespace> {
  if (!isAbsolute(repository.storeBase)) failWith("InvalidInput", "The delivery store base must be an absolute path.");
  const identity = await readPrimaryIdentity(repository.root, repository.git, signal);
  const outside = async (): Promise<string> => {
    const base = await resolvedThroughExisting(repository.storeBase);
    if (overlaps(repository.root, base))
      failWith("SecurityViolation", "The delivery store must be outside the target repository; it never lives in the tree it delivers to.");
    return base;
  };
  let base = await outside();
  if (create) { await mkdir(base, { recursive: true }); base = await outside(); }
  return Object.freeze({ store: new FilesystemDeliveryStore(join(base, identity.repositoryIdentity)), repositoryIdentity: identity.repositoryIdentity,
    checkoutSha256: checkoutDigest(repository.root), base });
}

/** A delivery of THIS checkout, revalidated: one filed under another repository is corrupt; one of another checkout is refused. */
async function loadHere(namespace: DeliveryNamespace, deliveryId: string): Promise<StoredDelivery> {
  const loaded = await namespace.store.load(deliveryId);
  if (loaded.manifest.primary.repositoryIdentity !== namespace.repositoryIdentity)
    failWith("SecurityViolation", "The stored delivery is corrupt or tampered (filed under another repository); it is not used.");
  if (loaded.record.reference.checkoutSha256 !== namespace.checkoutSha256)
    failWith("InvalidInput", "That delivery was prepared in another checkout of this repository; run Fusion in that checkout.");
  return loaded;
}

/**
 * The live delivery authorization: none exists. A delivery into a primary checkout is executed only for a disposable test
 * repository a test harness registered (`ControlPlaneDeps.disposableDeliveryTargets`); no environment variable, flag or
 * configuration changes this, and it never opens `REAL_WRITER_LIVE_GATE_AUTHORIZED`.
 */
export function liveDeliveryAuthorization(): Readonly<{ authorized: false; reason: string }> {
  return Object.freeze({ authorized: false, reason: "No live delivery authorization exists (REAL_PRIMARY_APPLY is not authorized; " +
    `REAL_WRITER_LIVE_GATE_AUTHORIZED is ${String(REAL_WRITER_LIVE_GATE_AUTHORIZED)}).` });
}

/** The repository a delivery command works on, resolved with an isolated-config Git client (never the user's global config). */
export async function deliveryRepository(plane: ControlPlane): Promise<DeliveryRepository> {
  const git = plane.deps.git ?? await ProcessGitClient.fromPath(plane.deps.env, true);
  const top = await git.run(["rev-parse", "--show-toplevel"], { cwd: plane.deps.cwd });
  if (top.exitCode !== 0 || top.stdout.trim() === "")
    throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "Not inside a Git working tree. Run Fusion from a repository (or pass --cwd)." });
  return Object.freeze({ root: await realpath(top.stdout.trim()), git,
    storeBase: plane.deps.deliveryStoreRoot ?? defaultDeliveryStoreBase(plane.deps.env) });
}

/** A delivery's id: deterministic in the run, its change and its baseline, so preparing the same thing twice is idempotent. */
export function deliveryIdFor(runId: string, result: WorkflowResult, baseCommit: string): string {
  if (result.changeSet === undefined) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "The run has no change to deliver." });
  return `d-${sha256Hex(canonicalJson({ runId, baseCommit, changeSetSha256: sha256Hex(canonicalChangeSetJson(result.changeSet)) })).slice(0, 24)}`;
}

/**
 * Prepares a verified private Writer result for delivery and stores it `prepared`: the manifest and the bundle (the exact
 * validated bytes) written once, the `prepared` event appended. Refuses (nothing stored) a failed, unverified, rehearsal
 * or review-blocked result. Nothing is written into the primary: the delivery goes to Fusion's application state
 * (`storeBase`, outside the repository).
 */
export async function prepareStoredDelivery(input: Readonly<{ runId: string; taskSha256: string; workflowEvidenceSha256: string; result: WorkflowResult;
  scope: ChangeScope; baseCommit: string; primaryRoot: string; git: GitClient; storeBase: string; now?: () => Date; signal?: AbortSignal }>):
  Promise<Readonly<{ deliveryId: string; manifestSha256: string; state: DeliveryState | "incomplete" }>> {
  const deliveryId = deliveryIdFor(input.runId, input.result, input.baseCommit);
  const prepared = await prepareRunDelivery({ deliveryId, runId: input.runId, taskSha256: input.taskSha256,
    workflowEvidenceSha256: input.workflowEvidenceSha256, result: input.result, scope: input.scope, baseCommit: input.baseCommit,
    primaryRoot: input.primaryRoot, git: input.git, ...(input.signal ? { signal: input.signal } : {}) });
  const namespace = await openDeliveryNamespace({ root: await realpath(input.primaryRoot), git: input.git, storeBase: input.storeBase }, true, input.signal);
  const stored = await namespace.store.put(prepared, { runId: input.runId, workflowEvidenceSha256: input.workflowEvidenceSha256,
    checkoutSha256: namespace.checkoutSha256 }, (input.now ?? (() => new Date()))().toISOString());
  return Object.freeze({ deliveryId, manifestSha256: stored.record.manifestSha256, state: stored.state });
}

// ---------------------------------------------------------------- inspect

export interface DeliveryFileView {
  readonly kind: DeliveryOperationKind;
  readonly path: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly afterBytes: number | null;
  /** `rendered`: `diff` holds the unified diff; otherwise why no diff is shown. */
  readonly diffStatus: "rendered" | "binary" | "tooLarge" | "preimageUnavailable";
  readonly diff: readonly string[];
  readonly diffTruncated: boolean;
}
export interface DeliveryInspection {
  readonly deliveryId: string;
  readonly state: DeliveryState | "incomplete";
  readonly manifestSha256: string;
  readonly bundleSha256: string;
  readonly target: Readonly<{ repositoryIdentity: string; baseCommit: string; baseTree: string; cleanTree: "required" }>;
  readonly counts: Readonly<Record<DeliveryOperationKind, number>>;
  readonly files: readonly DeliveryFileView[];
  readonly verification: DeliveryManifest["quality"]["verification"];
  readonly review: DeliveryManifest["quality"]["review"];
  readonly correction: DeliveryManifest["quality"]["correction"];
  readonly safety: DeliveryManifest["safety"];
  readonly approval: Readonly<{ approved: boolean; manifestSha256: string; bundleSha256: string; approvedAt: string; confirmation: string }> | null;
  readonly events: readonly Readonly<{ seq: number; type: DeliveryEventType; at: string }>[];
}
const MAX_PREIMAGE_BYTES = 1024 * 1024;

/**
 * A delivery as a human reads it before approving: loaded and revalidated from the store (corruption fails closed), with a
 * unified diff per file rendered from trusted inputs only — the post-image from the validated bundle, the preimage from the
 * baseline commit's blob (`git cat-file`, no filters) accepted only when its SHA-256 equals the manifest's preimage digest.
 * Read-only: nothing is written, no event is appended, no repository code runs.
 */
export async function inspectStoredDelivery(repository: DeliveryRepository, deliveryId: string): Promise<DeliveryInspection> {
  const loaded = await loadHere(await openDeliveryNamespace(repository, false), deliveryId);
  const { manifest, bundle } = loaded;
  const files: DeliveryFileView[] = [];
  for (const op of manifest.operations) {
    const after = bundle.entries.find(entry => entry.index === op.index)?.content ?? null;
    let before: Buffer | null = null, status: DeliveryFileView["diffStatus"] = "rendered";
    if (op.beforeSha256 !== null) {
      const blob = await repository.git.run(["cat-file", "blob", `${manifest.primary.baseCommit}:${op.path}`],
        { cwd: repository.root, maxStdoutBytes: MAX_PREIMAGE_BYTES }).catch(() => undefined);
      const bytes = blob?.exitCode === 0 ? Buffer.from(blob.stdout, "utf8") : undefined;
      if (bytes === undefined || sha256Hex(bytes) !== op.beforeSha256) status = "preimageUnavailable"; else before = bytes;
    }
    if (status === "rendered" && ((before?.includes(0) ?? false) || (after?.includes(0) ?? false))) status = "binary";
    let diff: readonly string[] = [], truncated = false;
    if (status === "rendered") {
      const rendered = unifiedDiff(op.path, before?.toString("utf8") ?? null, after?.toString("utf8") ?? null);
      if (rendered.status === "tooLarge") status = "tooLarge"; else { diff = rendered.lines; truncated = rendered.truncated; }
    }
    files.push(Object.freeze({ kind: op.kind, path: op.path, beforeSha256: op.beforeSha256, afterSha256: op.afterSha256, afterBytes: op.afterBytes,
      diffStatus: status, diff, diffTruncated: truncated }));
  }
  const count = (kind: DeliveryOperationKind) => manifest.operations.filter(op => op.kind === kind).length;
  return Object.freeze({ deliveryId: manifest.deliveryId, state: loaded.state, manifestSha256: loaded.record.manifestSha256,
    bundleSha256: loaded.record.bundleSha256, target: { repositoryIdentity: manifest.primary.repositoryIdentity, baseCommit: manifest.primary.baseCommit,
      baseTree: manifest.primary.baseTree, cleanTree: manifest.primary.cleanTree },
    counts: { create: count("create"), update: count("update"), delete: count("delete") }, files: Object.freeze(files),
    verification: manifest.quality.verification, review: manifest.quality.review, correction: manifest.quality.correction, safety: manifest.safety,
    approval: loaded.approval === null ? null : { approved: loaded.events.some(e => e.type === "approved"), manifestSha256: loaded.approval.manifestSha256,
      bundleSha256: loaded.approval.bundleSha256, approvedAt: loaded.approval.approvedAt, confirmation: loaded.approval.confirmation },
    events: Object.freeze(loaded.events.map(e => Object.freeze({ seq: e.seq, type: e.type, at: e.at }))) });
}

// ---------------------------------------------------------------- approve

/** What is shown before a human confirms: loaded and revalidated; only a `prepared` delivery can be approved. */
export async function approvalCandidate(repository: DeliveryRepository, deliveryId: string): Promise<DeliveryInspection> {
  const inspection = await inspectStoredDelivery(repository, deliveryId);
  if (inspection.state !== "prepared")
    throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: `A ${inspection.state} delivery cannot be approved.` });
  return inspection;
}
/**
 * Records a durable human approval from what the human typed: it must be exactly the manifest digest that was SHOWN, and
 * the delivery — re-loaded and revalidated now — must still carry that digest, so artifacts that changed after the summary
 * was shown approve nothing. Anything else approves nothing and changes nothing.
 */
export async function recordHumanApproval(repository: DeliveryRepository, deliveryId: string,
  shownManifestSha256: string, typed: string, now: () => Date = () => new Date()): Promise<Readonly<{ approved: boolean; manifestSha256: string }>> {
  const namespace = await openDeliveryNamespace(repository, false);
  const store = namespace.store;
  const loaded = await loadHere(namespace, deliveryId);
  if (loaded.state !== "prepared")
    throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: `A ${loaded.state} delivery cannot be approved.` });
  if (loaded.record.manifestSha256 !== shownManifestSha256)
    throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
      safeMessage: "The delivery changed after its summary was shown; nothing was approved." });
  let record;
  try { record = humanApprovalRecord({ manifest: loaded.manifest, typed, approvedAt: now().toISOString() }); }
  catch { return Object.freeze({ approved: false, manifestSha256: loaded.record.manifestSha256 }); }
  const stored = await store.writeApproval(deliveryId, record, now().toISOString());
  return Object.freeze({ approved: stored.state === "approved", manifestSha256: stored.record.manifestSha256 });
}

// ---------------------------------------------------------------- apply

export interface DeliveryApplyReport {
  readonly deliveryId: string;
  /**
   * `approvalRequired`: the delivery has no durable human approval; `blocked`: stopped before its precheck (no live
   * delivery authorization for this target). In both cases nothing ran against the target and no event was appended.
   */
  readonly result: "approvalRequired" | "blocked" | "applied" | "failed" | "rolledBack" | "rollbackFailed";
  readonly phase: string | null;
  readonly issues: readonly DeliveryIssue[];
  readonly reason: string | null;
  readonly operations: readonly Readonly<{ path: string; kind: DeliveryOperationKind; applied: boolean; restored: boolean | null }>[];
  readonly observedHead: string | null;
  readonly manifestSha256: string;
  /** False when the outcome's event could not be appended to the delivery's log (the outcome itself still stands). */
  readonly evidenceRecorded: boolean;
}

/** Whether `root` is a disposable test repository a harness registered, inside the system temporary directory. */
export async function isDisposableDeliveryTarget(root: string, registered: readonly string[] | undefined): Promise<boolean> {
  if (registered === undefined || registered.length === 0) return false;
  const temp = await realpath(tmpdir()).catch(() => undefined);
  if (temp === undefined || !isContainedPath(temp, root) || comparablePath(temp) === comparablePath(root)) return false;
  const roots = await Promise.all(registered.map(entry => realpath(entry).catch(() => undefined)));
  return roots.some(entry => entry !== undefined && comparablePath(entry) === comparablePath(root));
}

/**
 * `fusion apply <id>`: (1) load and revalidate the stored artifacts, (2) require the durable human approval of exactly them,
 * (3) resolve the target repository, then — only for a registered disposable test repository, since no live delivery
 * authorization exists — (4) the applier's full precheck and (5) the apply, with its postcheck and rollback. Every step's
 * evidence is appended to the delivery's event log. Any other target stops as `blocked` before its precheck.
 */
export async function applyStoredDelivery(plane: ControlPlane, deliveryId: string, now: () => Date = () => new Date()): Promise<DeliveryApplyReport> {
  const repository = await deliveryRepository(plane);
  const namespace = await openDeliveryNamespace(repository, false);
  const store = namespace.store;
  const loaded: StoredDelivery = await loadHere(namespace, deliveryId);
  const base = { deliveryId, manifestSha256: loaded.record.manifestSha256 };
  const untouched = (result: "approvalRequired" | "blocked", reason: string): DeliveryApplyReport => Object.freeze({ ...base, result,
    phase: null, issues: [], reason, observedHead: null, evidenceRecorded: true,
    operations: loaded.manifest.operations.map(op => ({ path: op.path, kind: op.kind, applied: false, restored: null })) });
  if (loaded.state === "prepared")
    return untouched("approvalRequired", `The delivery has no human approval; run \`fusion approve-delivery ${deliveryId}\` first.`);
  if (loaded.state !== "approved" || loaded.approval === null)
    throw new FusionFailure({ kind: "InvalidInput", retryable: false,
      safeMessage: `A ${loaded.state} delivery cannot be applied (an approval is used once; prepare a new delivery).` });
  const approval = approvalFromHumanRecord(loaded.approval, loaded.manifest);
  if (!await isDisposableDeliveryTarget(repository.root, plane.deps.disposableDeliveryTargets)) return untouched("blocked", liveDeliveryAuthorization().reason);
  const touchedPaths = loaded.manifest.operations.length;
  const event = (type: DeliveryEventType, fields: Partial<{ observedHead: string | null; phase: string | null; issues: string[];
    rollback: { restored: number; failed: number } | null }> = {}) => store.appendEvent(deliveryId, { type, at: now().toISOString(),
    observedHead: fields.observedHead ?? null, touchedPaths, phase: fields.phase ?? null, issues: fields.issues ?? [], rollback: fields.rollback ?? null });
  await store.beginApply(deliveryId, now().toISOString());
  const record = new DeliveryRecord(loaded.manifest, loaded.bundle);
  record.approve(approval);
  const applier = new LocalFilesystemDeliveryApplier({ git: repository.git, requiredForbiddenPaths: providerWorkspaceStatePaths(),
    ...(plane.deps.deliveryFaults ? { faults: plane.deps.deliveryFaults } : {}),
    observer: async ({ status, observedHead }) => {
      await event(status === "started" ? "precheckStarted" : status === "passed" ? "precheckPassed" : "precheckFailed", { observedHead, phase: "precheck" });
    } });
  const outcome = await applier.apply(record, repository.root);
  const issues = outcome.issues.map(issue => issue.path === undefined ? issue.reason : `${issue.reason}:${issue.path}`);
  const restored = outcome.evidence.operations.filter(op => op.restored === true).length;
  const failedRestores = outcome.evidence.operations.filter(op => op.restored === false).length;
  // The outcome already happened: a failure to record it is reported next to it, never in place of it.
  const evidenceRecorded = await event(outcome.state, { observedHead: outcome.evidence.observedHead, phase: outcome.phase, issues,
    rollback: outcome.state === "rolledBack" || outcome.state === "rollbackFailed" ? { restored, failed: failedRestores } : null })
    .then(() => true, () => false);
  return Object.freeze({ ...base, result: outcome.state, phase: outcome.phase, issues: outcome.issues, reason: null,
    operations: outcome.evidence.operations.map(op => ({ path: op.path, kind: op.kind, applied: op.applied, restored: op.restored })),
    observedHead: outcome.evidence.observedHead, evidenceRecorded });
}
