import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { canonicalChangePath } from "../core/change/contract.js";
import type { ChangeSet } from "../core/domain.js";
import { failWith } from "../core/errors.js";
import type { WorkflowResult } from "../core/workflow/types.js";
import { isContainedPath } from "../platform/events/shared.js";
import { comparablePath, type GitClient } from "../platform/workspace/git.js";

/**
 * HUMAN-APPROVED DELIVERY — the contract of the step that will one day move an accepted candidate's ChangeSet into the
 * user's checkout (`fusion apply <run-id>`). This release implements the manifest and a READ-ONLY preflight only; there
 * is no applier, and nothing here writes to the primary. See docs/o5-5b8-provider-boundary.md §17 for the full design:
 * explicit human action, candidate and baseline identity, drift check, exact paths and hashes, preview, staged atomic
 * renames with a rollback journal, no reset, no clean, no commit, no push, and an audit event.
 */
export const DELIVERY_SCHEMA_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const MAX_TARGET_BYTES = 8 * 1024 * 1024;
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export interface DeliveryOperation {
  readonly kind: "writeText" | "delete";
  readonly path: string;
  /** The primary file must have exactly this content hash before delivery; `null`: it must be absent. */
  readonly beforeSha256: string | null;
  /** The delivered content hash; `null` for a delete. */
  readonly afterSha256: string | null;
  readonly bytes: number;
}
/** Everything a human approves, and nothing more: identities, exact paths and hashes. Never file content. */
export interface DeliveryManifest {
  readonly schemaVersion: typeof DELIVERY_SCHEMA_VERSION;
  readonly runId: string;
  /** The committed baseline every candidate of the run was cloned from. */
  readonly baseCommit: string;
  /** SHA-256 of the canonical JSON of the approved ChangeSet: the content delivery will write must hash to this. */
  readonly changeSetSha256: string;
  readonly operations: readonly DeliveryOperation[];
}
export type DeliveryConflictReason = "headMoved" | "fileChanged" | "fileAppeared" | "fileMissing" | "notRegularFile" |
  "parentNotDirectory" | "outsideWorkspace" | "tooLarge";
export interface DeliveryConflict { readonly path?: string; readonly reason: DeliveryConflictReason }
export interface DeliveryPreflight {
  /** True only when every precondition holds right now. Even then nothing was applied: delivery is a separate human act. */
  readonly deliverable: boolean;
  readonly conflicts: readonly DeliveryConflict[];
  /** What a human is shown: each exact path with what would happen to it. */
  readonly preview: readonly Readonly<{ path: string; action: "create" | "modify" | "delete"; bytes: number }>[];
}

/** Canonical JSON of a ChangeSet (fixed key order), the input of `changeSetSha256`. */
export function canonicalChangeSetJson(changes: ChangeSet): string {
  return JSON.stringify({ schemaVersion: changes.schemaVersion, operations: changes.operations.map(op => op.kind === "delete"
    ? { kind: op.kind, path: op.path, expectedSha256: op.expectedSha256 }
    : { kind: op.kind, path: op.path, expectedSha256: op.expectedSha256, content: op.content }) });
}

/**
 * The delivery manifest of a finished run. Only a `completed` run whose final verification passed with a GRANTED
 * confinement acceptance qualifies: a failed, gated or offline-rehearsal result is refused, so fake-provider evidence
 * can never become a deliverable change.
 */
export function deliveryManifest(input: Readonly<{ runId: string; baseCommit: string; result: WorkflowResult }>): DeliveryManifest {
  const { runId, baseCommit, result } = input;
  if (!RUN_ID.test(runId) || !COMMIT.test(baseCommit)) failWith("InvalidInput", "A delivery needs a run ID and the committed baseline.");
  if (result.state !== "completed" || result.changeSet === undefined || result.applied === undefined || result.verification?.passed !== true)
    failWith("InvalidInput", "Only a completed, verified Writer run can be delivered.");
  if (result.verification.evidence?.acceptance !== "granted")
    failWith("SecurityViolation", "Only a run verified under a granted confinement acceptance can be delivered; a rehearsal never can.");
  const changes = result.changeSet;
  const operations = result.applied.map((entry, index): DeliveryOperation => {
    const op = changes.operations[index];
    if (op === undefined || op.path !== entry.path || op.kind !== entry.kind || op.expectedSha256 !== entry.beforeSha256)
      failWith("SecurityViolation", "The application ledger differs from the approved ChangeSet.");
    return Object.freeze({ kind: entry.kind, path: canonicalChangePath(entry.path), beforeSha256: entry.beforeSha256,
      afterSha256: entry.afterSha256, bytes: entry.bytes });
  });
  if (operations.length !== changes.operations.length) failWith("SecurityViolation", "The application ledger differs from the approved ChangeSet.");
  return Object.freeze({ schemaVersion: DELIVERY_SCHEMA_VERSION, runId, baseCommit, changeSetSha256: sha256(canonicalChangeSetJson(changes)),
    operations: Object.freeze(operations) });
}

function validManifest(value: DeliveryManifest): void {
  if (value === null || typeof value !== "object" || value.schemaVersion !== DELIVERY_SCHEMA_VERSION || !RUN_ID.test(value.runId) ||
      !COMMIT.test(value.baseCommit) || !SHA256.test(value.changeSetSha256) || !Array.isArray(value.operations) ||
      value.operations.length === 0 || value.operations.length > 256 ||
      value.operations.some(op => op === null || typeof op !== "object" || (op.kind !== "writeText" && op.kind !== "delete") ||
        !(op.beforeSha256 === null || SHA256.test(op.beforeSha256)) || !(op.afterSha256 === null || SHA256.test(op.afterSha256)) ||
        (op.kind === "delete") !== (op.afterSha256 === null) || (op.kind === "delete" && op.beforeSha256 === null) ||
        !Number.isSafeInteger(op.bytes) || op.bytes < 0))
    failWith("InvalidInput", "The delivery manifest is malformed.");
  const paths = value.operations.map(op => canonicalChangePath(op.path));
  if (new Set(paths.map(path => process.platform === "win32" ? path.toLowerCase() : path)).size !== paths.length)
    failWith("InvalidInput", "The delivery manifest names a path twice.");
}

/**
 * READ-ONLY delivery preflight against the user's checkout as it is NOW: HEAD must still be the baseline, and every
 * target must hold exactly the precondition the ChangeSet was validated against (absent, or the exact prior content),
 * be a regular file (never a link) under real directories inside the workspace. The user's other uncommitted work is
 * irrelevant; only the target paths are compared. Nothing is written, locked or refreshed.
 */
export async function deliveryPreflight(manifest: DeliveryManifest, primaryRoot: string, git: GitClient,
  signal?: AbortSignal): Promise<DeliveryPreflight> {
  validManifest(manifest);
  const conflicts: DeliveryConflict[] = [];
  const head = await git.run(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: primaryRoot, ...(signal ? { signal } : {}) });
  if (head.exitCode !== 0 || head.stdout.trim() !== manifest.baseCommit) conflicts.push({ reason: "headMoved" });
  const root = await realpath(primaryRoot);
  const preview: Array<{ path: string; action: "create" | "modify" | "delete"; bytes: number }> = [];
  for (const op of manifest.operations) {
    const parts = op.path.split("/"), target = join(root, ...parts);
    preview.push({ path: op.path, action: op.kind === "delete" ? "delete" : op.beforeSha256 === null ? "create" : "modify", bytes: op.bytes });
    if (!isContainedPath(root, target)) { conflicts.push({ path: op.path, reason: "outsideWorkspace" }); continue; }
    let parent = root, parentsOk = true;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      const info = await lstat(parent).catch(() => undefined);
      if (info === undefined) break; // a missing parent is created by delivery; only an absent target can need one
      if (!info.isDirectory() || info.isSymbolicLink() || comparablePath(await realpath(parent)) !== comparablePath(parent)) {
        parentsOk = false; break;
      }
    }
    if (!parentsOk) { conflicts.push({ path: op.path, reason: "parentNotDirectory" }); continue; }
    const info = await lstat(target).catch(() => undefined);
    if (info === undefined) {
      if (op.beforeSha256 !== null) conflicts.push({ path: op.path, reason: "fileMissing" });
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink()) { conflicts.push({ path: op.path, reason: "notRegularFile" }); continue; }
    if (op.beforeSha256 === null) { conflicts.push({ path: op.path, reason: "fileAppeared" }); continue; }
    if (info.size > MAX_TARGET_BYTES) { conflicts.push({ path: op.path, reason: "tooLarge" }); continue; }
    if (sha256(await readFile(target)) !== op.beforeSha256) conflicts.push({ path: op.path, reason: "fileChanged" });
  }
  return Object.freeze({ deliverable: conflicts.length === 0, conflicts: Object.freeze(conflicts.map(c => Object.freeze(c))),
    preview: Object.freeze(preview.map(p => Object.freeze(p))) });
}
