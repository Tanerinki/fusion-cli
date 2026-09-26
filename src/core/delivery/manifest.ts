import { canonicalChangePath, CHANGE_LIMITS } from "../change/contract.js";
import { failWith, FusionFailure } from "../errors.js";
import { canonicalJson, deepFreeze, sha256Hex } from "./canonical.js";

/**
 * O5.5C1 — the DELIVERY MANIFEST: everything a human approves before Fusion may write a verified private candidate's change
 * into a primary checkout, and nothing more. It carries identities, exact paths, exact before/after digests and sizes,
 * the digests of the evidence that qualified the change, and the safety policy the applier enforces — never file content,
 * never a prompt, a reply, a rationale or any other provider text (provider text is excluded from trust by construction:
 * `quality.providerText` is the constant `"excluded"`). It is canonical JSON: `deliveryManifestSha256` is the SHA-256 of
 * its canonical serialization, and an approval binds to exactly that digest.
 *
 * Supersedes the O5.5B8 read-only manifest (`app/delivery.ts`, format version 1) for delivery; version 2 adds the primary's
 * identity and clean-tree policy, the bundle digest, the quality evidence and the safety policy.
 */
export const DELIVERY_MANIFEST_FORMAT = "fusion.deliveryManifest" as const;
export const DELIVERY_MANIFEST_VERSION = 2 as const;
/** Hard caps of one delivery (the ChangeSet's own caps: a delivery never carries more than a validated change). */
export const DELIVERY_LIMITS = Object.freeze({ maxOperations: CHANGE_LIMITS.maxOperations, maxFileBytes: CHANGE_LIMITS.maxFileBytes,
  maxTotalBytes: CHANGE_LIMITS.maxTotalBytes, maxAllowedPaths: 256, maxForbiddenPaths: 64, maxVerificationCommands: 32 });
/** The path classes every delivery refuses, whatever its scope says (enforced by `deliveryPathViolation`). */
export const DELIVERY_FORBIDDEN_CLASSES = Object.freeze(["absolutePath", "pathTraversal", "gitInternals", "fusionState", "deviceName",
  "credentialFile", "credentialDirectory", "providerState"] as const);

export type DeliveryOperationKind = "create" | "update" | "delete";
export interface DeliveryManifestOperation {
  readonly index: number;
  readonly kind: DeliveryOperationKind;
  readonly path: string;
  /** The primary file's SHA-256 before delivery; `null`: it must not exist (create). */
  readonly beforeSha256: string | null;
  /** The delivered content's SHA-256; `null` for a delete. */
  readonly afterSha256: string | null;
  /** The exact byte length after delivery; `null` for a delete. */
  readonly afterBytes: number | null;
}
export interface DeliveryManifest {
  readonly format: typeof DELIVERY_MANIFEST_FORMAT;
  readonly version: typeof DELIVERY_MANIFEST_VERSION;
  readonly deliveryId: string;
  /** The run and the task request it delivers (a digest: the task text itself is not part of the manifest). */
  readonly request: Readonly<{ runId: string; taskSha256: string }>;
  /** The digest of the workflow evidence that produced the change (the run's event record). */
  readonly source: Readonly<{ workflowEvidenceSha256: string }>;
  readonly primary: Readonly<{
    /** SHA-256 over the repository's sorted root commit ids: which repository this delivery belongs to. */
    repositoryIdentity: string;
    /** The committed baseline the candidate was cloned from: HEAD must still be exactly this commit, with this tree. */
    baseCommit: string;
    baseTree: string;
    /** v0.1: the primary's working tree must be clean — no staged, unstaged or untracked change anywhere. */
    cleanTree: "required";
    /** Every touched path's expected state right before delivery: its existence and exact content digest. */
    touched: readonly Readonly<{ path: string; exists: boolean; sha256: string | null }>[];
  }>;
  readonly operations: readonly DeliveryManifestOperation[];
  readonly change: Readonly<{ changeSetSha256: string; bundleSha256: string; operationCount: number; totalBytes: number }>;
  readonly quality: Readonly<{
    verification: Readonly<{ passed: true; acceptance: "granted"; backendId: string; confinement: string;
      commands: readonly Readonly<{ id: string; status: string }>[]; evidenceSha256: string }>;
    review: Readonly<{ state: "clean" | "notRequired"; cycles: number; findings: number; outstanding: 0; labelsSha256: string | null }>;
    correction: Readonly<{ attempts: number; corrections: number }>;
    providerText: "excluded";
  }>;
  readonly safety: Readonly<{
    /** The run's write scope: every operation's path is in it. */
    allowedPaths: readonly string[];
    /** Repository-relative paths (and everything under them) no delivery may touch: the providers' workspace state. */
    forbiddenPaths: readonly string[];
    forbiddenClasses: readonly (typeof DELIVERY_FORBIDDEN_CLASSES)[number][];
    links: "refuse";
    ignoredPaths: "refuse";
    caps: Readonly<{ maxOperations: number; maxFileBytes: number; maxTotalBytes: number }>;
    /** The filesystem family the manifest was prepared on; the applier refuses another (case and separator semantics). */
    platform: "win32" | "posix";
    scope: "localWorkingTree";
  }>;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
/** Credential files by basename, lowercased: environment files, private keys and certificates, credential stores. */
const CREDENTIAL_FILE = [/^\.env(?:\..+)?$/u, /\.env$/u, /^\.envrc$/u, /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ovpn|tfstate|tfvars)$/u,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/u, /^\.(?:npmrc|yarnrc|yarnrc\.yml|pypirc|netrc|_netrc|pgpass|git-credentials|htpasswd|dockercfg|s3cfg)$/u,
  /\.local(?:\.[a-z0-9]+)?$/u];
const CREDENTIAL_DIRECTORY = /^(?:\.aws|\.ssh|\.gnupg|\.kube|\.docker|\.azure|\.gcloud)$/u;

/** The platform family a path's case and separator semantics follow. */
export const platformFamily = (platform: string = process.platform): "win32" | "posix" => platform === "win32" ? "win32" : "posix";
/** A path's comparison key: case-insensitive everywhere, so a delivery is never ambiguous on any filesystem. */
export const deliveryPathKey = (path: string): string => path.toLowerCase();

/**
 * Why a path can never be delivered, or `undefined`: not a canonical repository-relative file path (absolute, traversal,
 * backslashes, device names, `.git`, `.fusion`, control characters — the ChangeSet rule), a credential file or anything
 * under a credential directory, or a path at or under one of `forbiddenPaths`.
 */
export function deliveryPathViolation(path: unknown, forbiddenPaths: readonly string[]): (typeof DELIVERY_FORBIDDEN_CLASSES)[number] | undefined {
  try { canonicalChangePath(path); }
  catch (error) {
    if (!(error instanceof FusionFailure)) throw error;
    const text = typeof path === "string" ? path : "";
    return /^[\\/]|^[A-Za-z]:/u.test(text) ? "absolutePath" : text.split(/[\\/]/u).some(part => part === "..") ? "pathTraversal"
      : text.split(/[\\/]/u).some(part => part.toLowerCase() === ".git") ? "gitInternals"
      : text.split(/[\\/]/u).some(part => part.toLowerCase() === ".fusion") ? "fusionState" : "deviceName";
  }
  const parts = (path as string).split("/");
  if (CREDENTIAL_FILE.some(pattern => pattern.test(parts.at(-1)!.toLowerCase()))) return "credentialFile";
  if (parts.slice(0, -1).some(part => CREDENTIAL_DIRECTORY.test(part.toLowerCase()))) return "credentialDirectory";
  const key = deliveryPathKey(path as string);
  if (forbiddenPaths.some(forbidden => { const blocked = deliveryPathKey(forbidden); return key === blocked || key.startsWith(`${blocked}/`); }))
    return "providerState";
  return undefined;
}

const own = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  own(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= 0 &&
  (value as number) <= max;
const malformed = (what: string): never => failWith("InvalidInput", `The delivery manifest is malformed (${what}).`);

/**
 * Validates an untrusted value as a delivery manifest: the exact shape at every level (no missing, extra or mistyped
 * field), every identity and digest, every path against the forbidden classes and the manifest's own forbidden paths,
 * every operation against its kind, the touched preconditions against the operations, the totals and caps, the scope,
 * and the quality evidence (a passed verification under a granted acceptance, no outstanding review finding). Returns a
 * deep-frozen canonical copy; throws a typed failure otherwise. Nothing is read from any filesystem.
 */
export function validateDeliveryManifest(value: unknown): DeliveryManifest {
  if (!exactKeys(value, ["format", "version", "deliveryId", "request", "source", "primary", "operations", "change", "quality", "safety"]))
    return malformed("fields");
  if (value.format !== DELIVERY_MANIFEST_FORMAT || value.version !== DELIVERY_MANIFEST_VERSION) return malformed("format or version");
  if (typeof value.deliveryId !== "string" || !DELIVERY_ID.test(value.deliveryId)) return malformed("delivery id");
  const request = value.request, source = value.source, primary = value.primary, change = value.change, quality = value.quality, safety = value.safety;
  if (!exactKeys(request, ["runId", "taskSha256"]) || typeof request.runId !== "string" || !RUN_ID.test(request.runId) ||
      typeof request.taskSha256 !== "string" || !SHA256.test(request.taskSha256)) return malformed("request");
  if (!exactKeys(source, ["workflowEvidenceSha256"]) || typeof source.workflowEvidenceSha256 !== "string" ||
      !SHA256.test(source.workflowEvidenceSha256)) return malformed("source");
  // Safety first: the paths below are checked against it.
  if (!exactKeys(safety, ["allowedPaths", "forbiddenPaths", "forbiddenClasses", "links", "ignoredPaths", "caps", "platform", "scope"]) ||
      !Array.isArray(safety.allowedPaths) || safety.allowedPaths.length === 0 || safety.allowedPaths.length > DELIVERY_LIMITS.maxAllowedPaths ||
      !Array.isArray(safety.forbiddenPaths) || safety.forbiddenPaths.length > DELIVERY_LIMITS.maxForbiddenPaths ||
      !safety.forbiddenPaths.every(path => typeof path === "string" && /^[^\\/][^\\]*$/u.test(path) && !path.split("/").includes("..")) ||
      JSON.stringify(safety.forbiddenClasses) !== JSON.stringify(DELIVERY_FORBIDDEN_CLASSES) || safety.links !== "refuse" ||
      safety.ignoredPaths !== "refuse" || (safety.platform !== "win32" && safety.platform !== "posix") || safety.scope !== "localWorkingTree" ||
      !exactKeys(safety.caps, ["maxOperations", "maxFileBytes", "maxTotalBytes"]) || !count(safety.caps.maxOperations, DELIVERY_LIMITS.maxOperations) ||
      !count(safety.caps.maxFileBytes, DELIVERY_LIMITS.maxFileBytes) || !count(safety.caps.maxTotalBytes, DELIVERY_LIMITS.maxTotalBytes))
    return malformed("safety");
  const forbiddenPaths = safety.forbiddenPaths as string[];
  if (!safety.allowedPaths.every(path => deliveryPathViolation(path, forbiddenPaths) === undefined)) return malformed("allowed paths");
  const caps = safety.caps as { maxOperations: number; maxFileBytes: number; maxTotalBytes: number };
  // Operations: indices in order, exact kinds, no path twice (case-insensitively), every path deliverable and in scope.
  const operations = value.operations;
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > caps.maxOperations) return malformed("operations");
  const allowed = new Set((safety.allowedPaths as string[]).map(deliveryPathKey)), seen = new Set<string>();
  let total = 0;
  operations.forEach((op: unknown, index: number) => {
    if (!exactKeys(op, ["index", "kind", "path", "beforeSha256", "afterSha256", "afterBytes"]) || op.index !== index) return malformed("operation");
    if (deliveryPathViolation(op.path, forbiddenPaths) !== undefined) return malformed("operation path");
    const key = deliveryPathKey(op.path as string);
    if (seen.has(key) || !allowed.has(key)) return malformed("operation path scope");
    seen.add(key);
    const hash = (v: unknown) => v === null || (typeof v === "string" && SHA256.test(v));
    if (!hash(op.beforeSha256) || !hash(op.afterSha256)) return malformed("operation digest");
    const consistent = op.kind === "create" ? op.beforeSha256 === null && op.afterSha256 !== null && count(op.afterBytes, caps.maxFileBytes)
      : op.kind === "update" ? op.beforeSha256 !== null && op.afterSha256 !== null && count(op.afterBytes, caps.maxFileBytes)
      : op.kind === "delete" ? op.beforeSha256 !== null && op.afterSha256 === null && op.afterBytes === null : false;
    if (!consistent) return malformed("operation kind");
    total += (op.afterBytes as number | null) ?? 0;
  });
  if (total > caps.maxTotalBytes) return malformed("total bytes");
  // Primary preconditions: identity, baseline, clean tree, and exactly one touched entry per operation, in order.
  if (!exactKeys(primary, ["repositoryIdentity", "baseCommit", "baseTree", "cleanTree", "touched"]) ||
      typeof primary.repositoryIdentity !== "string" || !SHA256.test(primary.repositoryIdentity) ||
      typeof primary.baseCommit !== "string" || !OBJECT_ID.test(primary.baseCommit) || typeof primary.baseTree !== "string" ||
      !OBJECT_ID.test(primary.baseTree) || primary.baseTree.length !== primary.baseCommit.length || primary.cleanTree !== "required" ||
      !Array.isArray(primary.touched) || primary.touched.length !== operations.length)
    return malformed("primary");
  primary.touched.forEach((entry: unknown, index: number) => {
    const op = operations[index] as DeliveryManifestOperation;
    if (!exactKeys(entry, ["path", "exists", "sha256"]) || entry.path !== op.path || entry.exists !== (op.beforeSha256 !== null) ||
        entry.sha256 !== op.beforeSha256) return malformed("touched precondition");
  });
  if (!exactKeys(change, ["changeSetSha256", "bundleSha256", "operationCount", "totalBytes"]) || typeof change.changeSetSha256 !== "string" ||
      !SHA256.test(change.changeSetSha256) || typeof change.bundleSha256 !== "string" || !SHA256.test(change.bundleSha256) ||
      change.operationCount !== operations.length || change.totalBytes !== total) return malformed("change");
  // Quality: only a passed verification under a granted acceptance, with no outstanding finding, is ever deliverable.
  if (!exactKeys(quality, ["verification", "review", "correction", "providerText"]) || quality.providerText !== "excluded") return malformed("quality");
  const verification = quality.verification, review = quality.review, correction = quality.correction;
  if (!exactKeys(verification, ["passed", "acceptance", "backendId", "confinement", "commands", "evidenceSha256"]) || verification.passed !== true ||
      verification.acceptance !== "granted" || typeof verification.backendId !== "string" || !LABEL.test(verification.backendId) ||
      typeof verification.confinement !== "string" || !LABEL.test(verification.confinement) || !Array.isArray(verification.commands) ||
      verification.commands.length === 0 || verification.commands.length > DELIVERY_LIMITS.maxVerificationCommands ||
      !verification.commands.every(c => exactKeys(c, ["id", "status"]) && typeof c.id === "string" && LABEL.test(c.id) && c.status === "passed") ||
      typeof verification.evidenceSha256 !== "string" || !SHA256.test(verification.evidenceSha256)) return malformed("verification");
  if (!exactKeys(review, ["state", "cycles", "findings", "outstanding", "labelsSha256"]) || !count(review.cycles, 2) || !count(review.findings, 64) ||
      review.outstanding !== 0 || (review.state === "notRequired" ? review.cycles !== 0 || review.labelsSha256 !== null
        : review.state !== "clean" || review.cycles === 0 || typeof review.labelsSha256 !== "string" || !SHA256.test(review.labelsSha256)))
    return malformed("review");
  if (!exactKeys(correction, ["attempts", "corrections"]) || !count(correction.attempts, 2) || correction.attempts === 0 ||
      !count(correction.corrections, 1)) return malformed("correction");
  return deepFreeze(JSON.parse(canonicalJson(value)) as DeliveryManifest);
}

/** The digest an approval binds to: SHA-256 of the manifest's canonical JSON. */
export function deliveryManifestSha256(manifest: DeliveryManifest): string {
  return sha256Hex(canonicalJson(manifest));
}

/** What `fusion inspect-delivery` will show a human (O5.5C1: the data only): each exact path, its action and digests. */
export function deliveryPreview(manifest: DeliveryManifest): readonly Readonly<{ path: string; action: DeliveryOperationKind;
  beforeSha256: string | null; afterSha256: string | null; afterBytes: number | null }>[] {
  return Object.freeze(manifest.operations.map(op => Object.freeze({ path: op.path, action: op.kind, beforeSha256: op.beforeSha256,
    afterSha256: op.afterSha256, afterBytes: op.afterBytes })));
}
