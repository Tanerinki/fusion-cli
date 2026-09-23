import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { failWith } from "../../core/errors.js";
import { isContainedPath } from "../events/shared.js";
import { type GitClient } from "./git.js";

export interface StatusEntry {
  /** Porcelain v1 XY code, e.g. " M", "A ", "??", "UU". */
  readonly code: string;
  /** Repository-relative path as reported by Git. */
  readonly path: string;
}
/** Read-only fingerprint of a Git worktree: HEAD, index, and every tracked-dirty or untracked file. */
export interface WorkspaceSnapshot {
  readonly head: string | null;
  readonly headRef: string | null;
  readonly indexDigest: string;
  readonly entries: readonly StatusEntry[];
  readonly digests: Readonly<Record<string, string>>;
  /** False when bounds prevented a complete fingerprint; a read-only policy then cannot be proven. */
  readonly complete: boolean;
}
export interface SnapshotComparison {
  readonly mutated: boolean;
  readonly complete: boolean;
  /** Sorted repository-relative paths plus `<HEAD>`, `<HEAD-REF>` and `<INDEX>` markers. */
  readonly changes: readonly string[];
}

export const SNAPSHOT_LIMITS = Object.freeze({ maxEntries: 20_000, maxHashedFileBytes: 64 * 1024 * 1024 });

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

async function fileDigest(root: string, relative: string): Promise<string> {
  const path = join(root, relative);
  if (!isContainedPath(root, path)) return "<outside-root>";
  let info;
  try { info = await lstat(path); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "<missing>" : "<unreadable>"; }
  if (info.isSymbolicLink()) {
    try { return `link:${hash(await readlink(path))}`; } catch { return "<unreadable-link>"; }
  }
  if (info.isDirectory()) return "<directory>";
  if (!info.isFile()) return "<special>";
  // Very large files are fingerprinted by size and modification time instead of content.
  if (info.size > SNAPSHOT_LIMITS.maxHashedFileBytes) return `large:${info.size}:${Math.trunc(info.mtimeMs)}`;
  const digest = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  } catch { return "<unreadable>"; }
  return `sha256:${digest.digest("hex")}`;
}

/** Parses `git status --porcelain=v1 -z --no-renames`. */
export function parseStatus(stdout: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const field of stdout.split("\0")) {
    if (field.length === 0) continue;
    if (field.length < 4 || field[2] !== " ") failWith("ProtocolError", "Git status output was not in the expected format.");
    entries.push({ code: field.slice(0, 2), path: field.slice(3) });
  }
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * Captures a snapshot without writing to the repository: optional locks are disabled in the Git environment,
 * and nothing is added to the object database.
 */
export async function captureSnapshot(git: GitClient, root: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  const options = { cwd: root, ...(signal ? { signal } : {}) };
  const head = await git.run(["rev-parse", "--verify", "--quiet", "HEAD"], options);
  if (head.exitCode !== 0 && head.exitCode !== 1) failWith("ProcessFailure", "Git could not read HEAD.");
  const ref = await git.run(["symbolic-ref", "--quiet", "HEAD"], options);
  if (ref.exitCode !== 0 && ref.exitCode !== 1) failWith("ProcessFailure", "Git could not read the HEAD reference.");
  const index = await git.run(["ls-files", "--stage", "-z"], options);
  if (index.exitCode !== 0) failWith("ProcessFailure", "Git could not read the index.");
  const status = await git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames",
    "--ignore-submodules=none"], options);
  if (status.exitCode !== 0) failWith("ProcessFailure", "Git could not read the working tree status.");
  const all = parseStatus(status.stdout);
  const entries = all.slice(0, SNAPSHOT_LIMITS.maxEntries);
  const digests: Record<string, string> = {};
  for (const entry of entries) digests[entry.path] = await fileDigest(root, entry.path);
  return { head: head.exitCode === 0 ? head.stdout.trim() : null, headRef: ref.exitCode === 0 ? ref.stdout.trim() : null,
    indexDigest: hash(index.stdout), entries, digests, complete: all.length <= SNAPSHOT_LIMITS.maxEntries };
}

export function compareSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): SnapshotComparison {
  const changes = new Set<string>();
  if (before.head !== after.head) changes.add("<HEAD>");
  if (before.headRef !== after.headRef) changes.add("<HEAD-REF>");
  if (before.indexDigest !== after.indexDigest) changes.add("<INDEX>");
  const codes = (snapshot: WorkspaceSnapshot): Map<string, string> => new Map(snapshot.entries.map(e => [e.path, e.code]));
  const a = codes(before), b = codes(after);
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(path) !== b.get(path) || before.digests[path] !== after.digests[path]) changes.add(path);
  }
  const sorted = [...changes].sort();
  return { mutated: sorted.length > 0, complete: before.complete && after.complete, changes: sorted };
}
