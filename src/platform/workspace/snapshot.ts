import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, readdir, realpath } from "node:fs/promises";
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
  // A reftable ref store keeps refs outside `refs/` and `packed-refs`; it is covered whenever it exists.
  try { await lstat(join(commonDir, "reftable")); selected.push(join(commonDir, "reftable")); } catch { /* files ref store */ }
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

/** Runs `work` over `items` with at most `limit` in flight, keeping input order in the result. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const at = next++; results[at] = await work(items[at]!); }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * `git ls-files --stage -v -z` records are `<tag> <mode> <object> <stage>\t<path>`: without the tag they are exactly
 * `--stage` output, and tag plus path are exactly `-v` output, so one process yields both (unmerged stages included).
 */
function splitIndexListing(stdout: string): Readonly<{ stage: string; flags: string }> {
  let stage = "", flags = "";
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const space = record.indexOf(" "), tab = record.indexOf("\t");
    if (space < 1 || tab < space) failWith("ProtocolError", "Git index listing was not in the expected format.");
    stage += `${record.slice(space + 1)}\0`;
    flags += `${record.slice(0, space)} ${record.slice(tab + 1)}\0`;
  }
  return { stage, flags };
}

/** `ref: <name>` in the HEAD file names the branch (what `git symbolic-ref HEAD` reports); anything else is detached. */
async function headReference(git: GitClient, gitDir: string, options: { cwd: string; signal?: AbortSignal }): Promise<string | null> {
  let text: string;
  try { text = await readFile(join(gitDir, "HEAD"), "utf8"); }
  catch { failWith("ProcessFailure", "Git could not read the HEAD reference."); }
  const match = /^ref: (\S+)\r?\n?$/u.exec(text);
  // A reftable store leaves a placeholder in HEAD; Git itself is asked then.
  if (match === null || match[1] !== "refs/heads/.invalid") return match?.[1] ?? null;
  const ref = await git.run(["symbolic-ref", "--quiet", "HEAD"], options);
  if (ref.exitCode !== 0 && ref.exitCode !== 1) failWith("ProcessFailure", "Git could not read the HEAD reference.");
  return ref.exitCode === 0 ? ref.stdout.trim() : null;
}

export interface SnapshotOptions {
  readonly signal?: AbortSignal;
  /** Also list ignored entries (`git status --ignored=matching`); they never enter `entries` or `digests`. */
  readonly ignored?: boolean;
}
export interface WorkspaceObservation {
  readonly snapshot: WorkspaceSnapshot;
  /** `git rev-parse --show-toplevel`, as Git printed it. */
  readonly topLevel: string;
  /**
   * With `ignored`: ignored paths, sorted, at Git's `matching` granularity — a file matched by a file pattern is listed
   * itself, a directory matched by a pattern is listed once with a trailing `/` and its contents are not listed.
   */
  readonly ignored?: readonly string[];
}

/**
 * Captures a snapshot without writing to the repository: optional locks are disabled in the Git environment,
 * and nothing is added to the object database.
 */
export async function captureSnapshot(git: GitClient, root: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  return (await observeWorkspace(git, root, signal ? { signal } : {})).snapshot;
}

/**
 * One observation of a worktree in four independent Git processes, run concurrently: locations, top level and HEAD
 * (`rev-parse`), the index with its flags (`ls-files --stage -v`), the effective configuration and the status. The
 * snapshot is identical to the one the earlier seven sequential processes produced (HEAD, HEAD ref, index digest,
 * flag digest, locations, config digest, metadata digest, status entries and file digests).
 */
export async function observeWorkspace(git: GitClient, root: string, request: SnapshotOptions = {}): Promise<WorkspaceObservation> {
  const options = { cwd: root, ...(request.signal ? { signal: request.signal } : {}) };
  const [locations, index, config, status] = await Promise.all([
    git.run(["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "--verify", "--quiet", "HEAD"], options),
    git.run(["ls-files", "--stage", "-v", "-z"], options),
    git.run(["config", "--list", "--includes", "--null", "--show-origin"], { ...options, maxStdoutBytes: 8 * 1024 * 1024 }),
    git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none",
      ...(request.ignored === true ? ["--ignored=matching"] : [])], options),
  ]);
  // Exit 1 with `--verify --quiet` is an unborn HEAD; the locations are printed either way.
  if (locations.exitCode !== 0 && locations.exitCode !== 1) failWith("ProcessFailure", "Git could not read repository metadata locations.");
  const [topLevel, rawGitDir, rawCommonDir, rawHead] = locations.stdout.trim().split(/\r?\n/u);
  if (!topLevel || !rawGitDir || !rawCommonDir || (locations.exitCode === 0) !== (rawHead !== undefined && rawHead.length > 0))
    failWith("ProtocolError", "Git returned incomplete repository locations.");
  if (index.exitCode !== 0) failWith("ProcessFailure", "Git could not read the index.");
  if (config.exitCode !== 0) failWith("ProcessFailure", "Git could not read effective configuration.");
  if (status.exitCode !== 0) failWith("ProcessFailure", "Git could not read the working tree status.");
  const gitDir = await realpath(isAbsolute(rawGitDir) ? rawGitDir : resolve(root, rawGitDir));
  const commonDir = await realpath(isAbsolute(rawCommonDir) ? rawCommonDir : resolve(root, rawCommonDir));
  const listing = splitIndexListing(index.stdout);
  const parsed = parseStatus(status.stdout);
  const all = parsed.filter(entry => entry.code !== "!!");
  const entries = all.slice(0, SNAPSHOT_LIMITS.maxEntries);
  const [headRef, metadata, fileDigests] = await Promise.all([headReference(git, gitDir, options), gitMetadata(gitDir, commonDir),
    mapLimit(entries, 16, entry => fileDigest(root, entry.path))]);
  const digests: Record<string, string> = {};
  entries.forEach((entry, at) => { digests[entry.path] = fileDigests[at]!; });
  const filesProven = Object.values(digests).every(digest => !digest.startsWith("large:") &&
    !digest.startsWith("<unreadable") && digest !== "<outside-root>" && digest !== "<special>");
  const snapshot: WorkspaceSnapshot = { head: locations.exitCode === 0 ? rawHead!.trim() : null, headRef,
    indexDigest: hash(listing.stage), gitState: { gitDir, commonDir, metadataDigest: metadata.digest,
      effectiveConfigDigest: hash(config.stdout), indexFlagsDigest: hash(listing.flags) },
    entries, digests, complete: all.length <= SNAPSHOT_LIMITS.maxEntries && metadata.complete && filesProven };
  return { snapshot, topLevel, ...(request.ignored === true
    ? { ignored: parsed.filter(entry => entry.code === "!!").map(entry => entry.path).sort() } : {}) };
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
