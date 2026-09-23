import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
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
  /** Hashes only; Git config values and hook contents never enter evidence. */
  readonly gitState: Readonly<{ gitDir: string; commonDir: string; metadataDigest: string;
    effectiveConfigDigest: string; indexFlagsDigest: string }>;
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

export const SNAPSHOT_LIMITS = Object.freeze({ maxEntries: 20_000, maxHashedFileBytes: 64 * 1024 * 1024,
  maxGitMetadataEntries: 20_000, maxGitMetadataBytes: 256 * 1024 * 1024 });

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

/** Selected Git control state, including refs, hooks, excludes, attributes and the raw index (which carries flags). */
async function gitMetadata(gitDir: string, commonDir: string): Promise<{ digest: string; complete: boolean }> {
  const selected = [join(gitDir, "HEAD"), join(gitDir, "index"), join(gitDir, "config.worktree"),
    join(gitDir, "commondir"), join(commonDir, "config"), join(commonDir, "packed-refs"),
    join(commonDir, "refs"), join(commonDir, "hooks"), join(commonDir, "info"),
    join(commonDir, "objects", "info", "alternates")];
  const digest = createHash("sha256");
  let entries = 0, bytes = 0, complete = true;
  const visit = async (path: string): Promise<void> => {
    if (++entries > SNAPSHOT_LIMITS.maxGitMetadataEntries) { complete = false; return; }
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { digest.update(`${path}\0missing\0`); return; }
      complete = false; return;
    }
    digest.update(`${path}\0${info.mode}\0`);
    if (info.isSymbolicLink()) {
      try { digest.update(`link:${await readlink(path)}\0`); } catch { complete = false; }
    } else if (info.isDirectory()) {
      let names: string[];
      try { names = (await readdir(path)).sort(); } catch { complete = false; return; }
      for (const name of names) { if (!complete) break; await visit(join(path, name)); }
    } else if (info.isFile()) {
      bytes += info.size;
      if (bytes > SNAPSHOT_LIMITS.maxGitMetadataBytes || info.size > SNAPSHOT_LIMITS.maxHashedFileBytes) {
        complete = false; return;
      }
      try { for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer); }
      catch { complete = false; }
    } else complete = false;
  };
  for (const path of selected) { if (!complete) break; await visit(path); }
  return { digest: digest.digest("hex"), complete };
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
  const flags = await git.run(["ls-files", "-v", "-z"], options);
  if (flags.exitCode !== 0) failWith("ProcessFailure", "Git could not read index flags.");
  const locations = await git.run(["rev-parse", "--git-dir", "--git-common-dir"], options);
  if (locations.exitCode !== 0) failWith("ProcessFailure", "Git could not read repository metadata locations.");
  const [rawGitDir, rawCommonDir] = locations.stdout.trim().split(/\r?\n/u);
  if (!rawGitDir || !rawCommonDir) failWith("ProtocolError", "Git returned incomplete repository locations.");
  const gitDir = await realpath(isAbsolute(rawGitDir) ? rawGitDir : resolve(root, rawGitDir));
  const commonDir = await realpath(isAbsolute(rawCommonDir) ? rawCommonDir : resolve(root, rawCommonDir));
  const config = await git.run(["config", "--list", "--includes", "--null", "--show-origin"],
    { ...options, maxStdoutBytes: 8 * 1024 * 1024 });
  if (config.exitCode !== 0) failWith("ProcessFailure", "Git could not read effective configuration.");
  const metadata = await gitMetadata(gitDir, commonDir);
  const status = await git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames",
    "--ignore-submodules=none"], options);
  if (status.exitCode !== 0) failWith("ProcessFailure", "Git could not read the working tree status.");
  const all = parseStatus(status.stdout);
  const entries = all.slice(0, SNAPSHOT_LIMITS.maxEntries);
  const digests: Record<string, string> = {};
  for (const entry of entries) digests[entry.path] = await fileDigest(root, entry.path);
  const filesProven = Object.values(digests).every(digest => !digest.startsWith("large:") &&
    !digest.startsWith("<unreadable") && digest !== "<outside-root>" && digest !== "<special>");
  return { head: head.exitCode === 0 ? head.stdout.trim() : null, headRef: ref.exitCode === 0 ? ref.stdout.trim() : null,
    indexDigest: hash(index.stdout), gitState: { gitDir, commonDir, metadataDigest: metadata.digest,
      effectiveConfigDigest: hash(config.stdout), indexFlagsDigest: hash(flags.stdout) },
    entries, digests, complete: all.length <= SNAPSHOT_LIMITS.maxEntries && metadata.complete && filesProven };
}

export function compareSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): SnapshotComparison {
  const changes = new Set<string>();
  if (before.head !== after.head) changes.add("<HEAD>");
  if (before.headRef !== after.headRef) changes.add("<HEAD-REF>");
  if (before.indexDigest !== after.indexDigest) changes.add("<INDEX>");
  if (before.gitState.gitDir !== after.gitState.gitDir || before.gitState.commonDir !== after.gitState.commonDir)
    changes.add("<GIT-DIRECTORY>");
  if (before.gitState.metadataDigest !== after.gitState.metadataDigest) changes.add("<GIT-METADATA>");
  if (before.gitState.effectiveConfigDigest !== after.gitState.effectiveConfigDigest) changes.add("<GIT-CONFIG>");
  if (before.gitState.indexFlagsDigest !== after.gitState.indexFlagsDigest) changes.add("<INDEX-FLAGS>");
  const codes = (snapshot: WorkspaceSnapshot): Map<string, string> => new Map(snapshot.entries.map(e => [e.path, e.code]));
  const a = codes(before), b = codes(after);
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(path) !== b.get(path) || before.digests[path] !== after.digests[path]) changes.add(path);
  }
  const sorted = [...changes].sort();
  return { mutated: sorted.length > 0, complete: before.complete && after.complete, changes: sorted };
}
