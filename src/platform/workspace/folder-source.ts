import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { failWith } from "../../core/errors.js";

/**
 * v0.2 — an ordinary folder (no Git) as a READ-ONLY source: what is in it (a bounded, deterministic walk that never follows
 * a link) and whether it changed (a cheap fingerprint of paths, sizes and modification times).
 *
 * Only reading is supported this way. Changing files needs a Git baseline (see the conversational layer): without one Fusion
 * could neither prove what changed nor restore it.
 */
export interface FolderEntry {
  /** Path relative to the root, `/`-separated. */
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}
export interface FolderListing {
  readonly entries: readonly FolderEntry[];
  /** Directories skipped by name (dependencies, caches, version-control internals), relative paths. */
  readonly skippedDirectories: readonly string[];
  /** Links and special files never followed or read. */
  readonly skippedLinks: number;
  /** A bound was hit: the listing is not the whole folder. */
  readonly truncated: boolean;
}
export const FOLDER_LIMITS = Object.freeze({ maxFiles: 20_000, maxDepth: 24, maxDirectories: 10_000 });

/** Directories never walked: dependencies, caches, build output of tools, version-control and Fusion internals. */
const SKIPPED_DIRECTORIES = new Set([".git", ".hg", ".svn", ".fusion", "node_modules", "__pycache__", ".venv", "venv", ".cache",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".next", ".nuxt", ".gradle", ".idea", "deps", "tts"]);
/** Files that change on their own while a service runs (databases, logs, runtime stores): not part of the change fingerprint. */
const VOLATILE = /(^|\/)\.storage\/|(^|\/)\.cloud\/|\.(db|db3|sqlite|sqlite3)(-wal|-shm|-journal)?$|\.(log|pid|lock)$|\.log\.\d+$|(^|\/)\.HA_VERSION$/iu;

export const isVolatile = (path: string): boolean => VOLATILE.test(path);

/** Lists `root` read-only: regular files only, links never followed, bounded. */
export async function listFolder(root: string, signal?: AbortSignal): Promise<FolderListing> {
  const entries: FolderEntry[] = [], skippedDirectories: string[] = [];
  let skippedLinks = 0, directories = 0, truncated = false;
  const pending: Array<readonly [string, number]> = [["", 0]];
  while (pending.length > 0) {
    if (signal?.aborted) failWith("Cancelled", "The folder inventory was cancelled.");
    const [rel, depth] = pending.pop()!;
    if (++directories > FOLDER_LIMITS.maxDirectories) { truncated = true; break; }
    let names: string[];
    try { names = (await readdir(rel === "" ? root : join(root, ...rel.split("/")))).sort(); } catch { continue; }
    for (const name of names) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      let info;
      try { info = await lstat(join(root, ...childRel.split("/"))); } catch { continue; }
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) { skippedLinks++; continue; }
      if (info.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(name.toLowerCase())) { skippedDirectories.push(childRel); continue; }
        if (depth + 1 > FOLDER_LIMITS.maxDepth) { truncated = true; continue; }
        pending.push([childRel, depth + 1]);
        continue;
      }
      if (entries.length >= FOLDER_LIMITS.maxFiles) { truncated = true; continue; }
      entries.push({ path: childRel, bytes: info.size, mtimeMs: info.mtimeMs });
    }
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return Object.freeze({ entries: Object.freeze(entries), skippedDirectories: Object.freeze(skippedDirectories.sort()), skippedLinks, truncated });
}

/** The folder's change fingerprint: every non-volatile file's path, size and modification time (no content read). */
export async function folderFingerprint(root: string, signal?: AbortSignal): Promise<string> {
  const listing = await listFolder(root, signal);
  const hash = createHash("sha256");
  for (const entry of listing.entries) if (!isVolatile(entry.path)) hash.update(`${entry.path}\0${entry.bytes}\0${Math.trunc(entry.mtimeMs)}\n`);
  hash.update(`truncated=${listing.truncated}`);
  return hash.digest("hex");
}
