import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { BaselineFileHash, ChangeSet } from "../../core/domain.js";
import { canonicalChangePath, CHANGE_LIMITS } from "../../core/change/contract.js";
import { failWith } from "../../core/errors.js";

export interface MutationLedgerEntry {
  readonly kind: "writeText" | "delete";
  readonly path: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly bytes: number;
}
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function safeTarget(root: string, path: string, createParents: boolean): Promise<string> {
  canonicalChangePath(path);
  const target = join(root, ...path.split("/"));
  if (!inside(root, target)) failWith("SecurityViolation", "Change target escapes the candidate workspace.");
  let cursor = root;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (await realpath(root)) !== root)
    failWith("SecurityViolation", "Candidate root is not an ordinary directory.");
  for (const part of path.split("/").slice(0, -1)) {
    cursor = join(cursor, part);
    let info;
    try { info = await lstat(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !createParents) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await mkdir(cursor);
      info = await lstat(cursor);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(cursor)) !== cursor)
      failWith("SecurityViolation", "Change parent is a symlink, junction or non-directory.");
  }
  return target;
}
async function currentHash(root: string, path: string, createParents: boolean): Promise<string | null> {
  const target = await safeTarget(root, path, createParents);
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
    failWith("SecurityViolation", "Change target is not a bounded regular file.");
  const bytes = await readFile(target);
  const after = await lstat(target);
  if (!after.isFile() || after.isSymbolicLink() || info.dev !== after.dev || info.ino !== after.ino ||
      info.size !== after.size || info.mtimeMs !== after.mtimeMs)
    failWith("WorkspaceConflict", "Change target changed while checking its hash.");
  return digest(bytes);
}

function ownedRoot(candidateRoot: string, privateRoot: string): Readonly<{ root: string; ownerRoot: string }> {
  const root = resolve(candidateRoot), ownerRoot = resolve(privateRoot);
  if (dirname(root) !== ownerRoot || basename(root) !== "candidate" ||
      !basename(ownerRoot).startsWith("fusion-writer-private-") ||
      dirname(ownerRoot) !== resolve(tmpdir()) || !inside(ownerRoot, root))
    failWith("SecurityViolation", "Host applier requires the owned private candidate.");
  return { root, ownerRoot };
}
function ownedCandidate(candidateRoot: string, privateRoot: string, changes: ChangeSet): Readonly<{ root: string; ownerRoot: string }> {
  const { root, ownerRoot } = ownedRoot(candidateRoot, privateRoot);
  if (changes.schemaVersion !== 1 || !Array.isArray(changes.operations) || changes.operations.length === 0 ||
      changes.operations.length > CHANGE_LIMITS.maxOperations)
    failWith("InvalidInput", "Host applier requires a bounded canonical ChangeSet.");
  for (const op of changes.operations) canonicalChangePath(op.path);
  return { root, ownerRoot };
}

/**
 * The operations whose SHA-256 precondition does not hold in the candidate, read without any mutation (the same
 * link-refusing reads as the applier). A stale proposal is thereby told apart from an unsafe target, which still throws.
 */
export async function mismatchedPreconditions(candidateRoot: string, privateRoot: string, changes: ChangeSet): Promise<readonly string[]> {
  const { root } = ownedCandidate(candidateRoot, privateRoot, changes);
  const stale: string[] = [];
  for (const op of changes.operations) if (await currentHash(root, op.path, false) !== op.expectedSha256) stale.push(op.path);
  return Object.freeze(stale);
}

/**
 * The current SHA-256 of each given path in the owned candidate (`null`: absent), in the given order, read without any
 * mutation through the same link-refusing reads as the applier: the preconditions a read-only Change Author is handed.
 */
export async function observedPreconditions(candidateRoot: string, privateRoot: string, paths: readonly string[]):
  Promise<readonly BaselineFileHash[]> {
  const { root } = ownedRoot(candidateRoot, privateRoot);
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 1024)
    failWith("InvalidInput", "A baseline observation requires a bounded file list.");
  const observed: BaselineFileHash[] = [];
  for (const path of paths) observed.push(Object.freeze({ path: canonicalChangePath(path), sha256: await currentHash(root, path, false) }));
  return Object.freeze(observed);
}

/** This function is called only through an owned PrivateWriterWorkspace. It never receives the primary root. */
export async function applyCandidateChanges(candidateRoot: string, privateRoot: string, changes: ChangeSet):
  Promise<readonly MutationLedgerEntry[]> {
  const { root, ownerRoot } = ownedCandidate(candidateRoot, privateRoot, changes);
  const staged = await mkdtemp(join(ownerRoot, "fusion-stage-"));
  const files = new Map<string, string>();
  try {
    // Preflight every precondition before the first candidate mutation.
    for (const op of changes.operations) {
      const before = await currentHash(root, op.path, false);
      if (before !== op.expectedSha256)
        failWith("WorkspaceConflict", "ChangeSet expected hash does not match the candidate.");
      if (op.kind === "writeText") {
        const stage = join(staged, randomUUID());
        await writeFile(stage, op.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        files.set(op.path, stage);
      }
    }
    const ledger: MutationLedgerEntry[] = [];
    for (const op of changes.operations) {
      // Recheck parents and hash immediately before each individual mutation.
      const target = await safeTarget(root, op.path, op.kind === "writeText");
      const before = await currentHash(root, op.path, false);
      if (before !== op.expectedSha256)
        failWith("WorkspaceConflict", "Change target changed immediately before host mutation.");
      if (op.kind === "delete") {
        await unlink(target);
        ledger.push(Object.freeze({ kind: op.kind, path: op.path, beforeSha256: before,
          afterSha256: null, bytes: 0 }));
      } else {
        await rename(files.get(op.path)!, target);
        const after = await currentHash(root, op.path, false);
        const expected = digest(Buffer.from(op.content, "utf8"));
        if (after !== expected) failWith("WorkspaceConflict", "Host write did not produce the expected content hash.");
        ledger.push(Object.freeze({ kind: op.kind, path: op.path, beforeSha256: before,
          afterSha256: expected, bytes: Buffer.byteLength(op.content, "utf8") }));
      }
    }
    return Object.freeze(ledger);
  } finally {
    if (dirname(resolve(staged)) !== ownerRoot || !basename(staged).startsWith("fusion-stage-"))
      failWith("SecurityViolation", "Host staging cleanup target escaped its private root.");
    await rm(staged, { recursive: true, force: true });
  }
}
