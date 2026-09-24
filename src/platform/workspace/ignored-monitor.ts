import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalChangePath } from "../../core/change/contract.js";
import { failWith } from "../../core/errors.js";
import { isContainedPath } from "../events/shared.js";
import type { GitClient } from "./git.js";
import { observeWorkspace, type WorkspaceSnapshot } from "./snapshot.js";

/**
 * Bounded monitoring of the primary checkout's IGNORED paths (`.env`, local configuration, build output, dependency
 * trees), which Git status never reports. A universal complete answer does not exist: a primary may hold a huge
 * `node_modules`. The policy is therefore explicit and its coverage is reported, never assumed:
 *
 *  - sensitive files (by name: `.env*`, keys, credential stores, `*.local`, …), files inside sensitive directories and
 *    user-declared protected paths: CONTENT hash (SHA-256, streamed, never retained) on every observation;
 *  - other ignored files: metadata (size, modification and change time, file id, mode) on every observation;
 *  - managed/cache directories (`node_modules`, `dist`, `.venv`, …): a directory-level signal only (the directory's
 *    own metadata and its direct child names) — their contents are NOT monitored, and coverage says so;
 *  - other ignored directories: a bounded walk; one that exceeds its bound falls back to the directory-level signal;
 *  - the set itself: Git's ignored listing is part of every fingerprint, so a new or removed ignored entry is a change;
 *  - Fusion's own run storage (`.fusion/`) is excluded: Fusion writes it during a run.
 *
 * Nothing here returns or persists a path, a value or file content: only one digest and coverage counts.
 */
export const IGNORED_MONITOR_LIMITS = Object.freeze({
  /** Ignored entries (at Git's `matching` granularity) considered at all; beyond this, entries are unmonitored. */
  maxListedEntries: 20_000,
  /** Files tracked by metadata or content across the whole monitored set. */
  maxMonitoredFiles: 5_000,
  /** Bytes of sensitive/protected content re-hashed per observation; beyond this they are monitored by metadata. */
  maxContentBytes: 16 * 1024 * 1024,
  /** A single sensitive/protected file above this is monitored by metadata only. */
  maxContentFileBytes: 4 * 1024 * 1024,
  /** Entries a bounded walk of one ignored (non-managed) directory may visit, and its depth. */
  maxWalkEntries: 2_000,
  maxWalkDepth: 8,
  /** Direct child names hashed for a directory-level signal. */
  maxDirectoryChildren: 10_000,
  maxProtectedPaths: 64,
});

/** Basenames of ignored files whose content is monitored. Matched lowercased. */
const SENSITIVE_FILE = [
  /^\.env(?:\..+)?$/u, /\.env$/u, /^\.envrc$/u, /^\.flaskenv$/u,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ovpn|tfvars|tfstate|tfstate\.backup|asc|gpg)$/u,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/u,
  /^\.(?:npmrc|yarnrc|yarnrc\.yml|pypirc|netrc|_netrc|pgpass|git-credentials|htpasswd|dockercfg|s3cfg)$/u,
  /(?:^|[._-])(?:secret|secrets|credential|credentials|password|passwords|passwd|token|tokens|apikey|api-key|api_key)(?:[._-]|$)/u,
  /\.local(?:\.[a-z0-9]+)?$/u, /^local\.[a-z0-9]+$/u, /^kubeconfig$/u,
];
/** Ignored directories whose files are all treated as sensitive. */
const SENSITIVE_DIRECTORY = /^(?:\.aws|\.ssh|\.gnupg|\.kube|\.docker|\.azure|\.gcloud|secrets?|\.secrets?|credentials?|private|keys?)$/u;
/** Ignored managed/cache directories: a directory-level signal only, never a content walk. */
const MANAGED_DIRECTORY = new Set(["node_modules", "bower_components", "jspm_packages", ".pnpm-store", ".yarn", ".venv", "venv",
  "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".nox", "dist", "build", "out", "target", "coverage",
  ".nyc_output", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache", ".gradle", ".vs", "obj"]);

export const sensitiveIgnoredName = (name: string): boolean => SENSITIVE_FILE.some(pattern => pattern.test(name.toLowerCase()));
export const managedIgnoredDirectory = (name: string): boolean => MANAGED_DIRECTORY.has(name.toLowerCase());

export interface IgnoredProtectionPolicy {
  /** User-declared protected paths (repository-relative files, or directories with a trailing `/`), content-monitored. */
  readonly protectedPaths?: readonly string[];
}
export type IgnoredCoverageReason = "managedDirectoryContents" | "directoryWalkBound" | "metadataOnlyFiles" | "listingBound" |
  "monitoredFileBound";
export interface IgnoredCoverage {
  /** `complete`: every ignored entry Git lists is monitored, sensitive and protected ones by content. Else `partial`. */
  readonly state: "complete" | "partial";
  readonly listed: number;
  readonly contentFiles: number;
  readonly metadataFiles: number;
  readonly sensitiveFiles: number;
  readonly protectedPaths: number;
  readonly managedDirectories: number;
  readonly truncatedDirectories: number;
  readonly unmonitoredEntries: number;
  readonly reasons: readonly IgnoredCoverageReason[];
}
export interface IgnoredObservation {
  readonly digest: string;
  readonly coverage: IgnoredCoverage;
}

/** Validates user-declared protected paths once: canonical repository-relative files, or directories ending in `/`. */
export function protectedPathsOf(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > IGNORED_MONITOR_LIMITS.maxProtectedPaths)
    failWith("InvalidInput", "Protected ignored paths must be a bounded list.");
  return Object.freeze([...new Set(value.map(entry => {
    if (typeof entry !== "string") return failWith("InvalidInput", "A protected ignored path must be text.");
    const directory = entry.endsWith("/");
    try { canonicalChangePath(directory ? entry.slice(0, -1) : entry); }
    catch { failWith("InvalidInput", "A protected ignored path must be a canonical repository-relative path."); }
    return entry;
  }))].sort());
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const metadataOf = (info: Awaited<ReturnType<typeof lstat>>): string =>
  `${info.size}:${Math.trunc(Number(info.mtimeMs))}:${Math.trunc(Number(info.ctimeMs))}:${info.ino}:${info.mode}`;

class Budget {
  files = 0; contentBytes = 0; content = 0; metadata = 0; sensitive = 0; managed = 0; truncated = 0; unmonitored = 0;
  readonly reasons = new Set<IgnoredCoverageReason>();
  /** A tentative copy: a bounded walk spends from it and is committed back only when it completes within its bound. */
  fork(): Budget { const copy = Object.assign(new Budget(), this); for (const reason of this.reasons) copy.reasons.add(reason); return copy; }
  commit(from: Budget): void {
    Object.assign(this, { files: from.files, contentBytes: from.contentBytes, content: from.content, metadata: from.metadata,
      sensitive: from.sensitive, managed: from.managed, truncated: from.truncated, unmonitored: from.unmonitored });
    for (const reason of from.reasons) this.reasons.add(reason);
  }
}

async function contentDigest(path: string): Promise<string> {
  const digest = createHash("sha256");
  try { for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer); }
  catch { return "<unreadable>"; }
  return `sha256:${digest.digest("hex")}`;
}

/** One file's record: content for sensitive/protected files within budget, metadata otherwise. Links are never followed. */
async function fileRecord(path: string, content: boolean, budget: Budget): Promise<string> {
  let info;
  try { info = await lstat(path); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "<unreadable>"; }
  if (info.isSymbolicLink()) {
    try { return `link:${sha256(await readlink(path))}`; } catch { return "<unreadable-link>"; }
  }
  if (info.isDirectory()) return "directory";
  if (!info.isFile()) return `special:${metadataOf(info)}`;
  if (++budget.files > IGNORED_MONITOR_LIMITS.maxMonitoredFiles) {
    budget.reasons.add("monitoredFileBound"); budget.unmonitored++; return "unmonitored";
  }
  if (content && info.size <= IGNORED_MONITOR_LIMITS.maxContentFileBytes &&
      budget.contentBytes + info.size <= IGNORED_MONITOR_LIMITS.maxContentBytes) {
    budget.contentBytes += info.size;
    budget.content++;
    return `${info.size}:${await contentDigest(path)}`;
  }
  if (content) budget.reasons.add("metadataOnlyFiles");
  budget.metadata++;
  return `meta:${metadataOf(info)}`;
}

/** The directory's own metadata and its sorted direct child names: detects added, removed and renamed children. */
async function directorySignal(path: string): Promise<string> {
  let info, names: string[];
  try { info = await lstat(path); names = (await readdir(path)).sort(); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "<unreadable>"; }
  if (info.isSymbolicLink() || !info.isDirectory()) return `not-directory:${metadataOf(info)}`;
  const listed = names.slice(0, IGNORED_MONITOR_LIMITS.maxDirectoryChildren);
  return `dir:${Math.trunc(Number(info.mtimeMs))}:${info.ino}:${names.length}:${sha256(listed.join("\0"))}`;
}

/**
 * A bounded walk of one ignored directory: every file is recorded (by content when `sensitive`, or when its own name is
 * sensitive), every subdirectory by its child names. Exceeding the entry or depth bound returns false and records nothing.
 */
async function walk(root: string, relative: string, sensitive: boolean, budget: Budget, records: Record<string, string>,
  maxEntries: number): Promise<boolean> {
  const local: Record<string, string> = {};
  const pending: Array<{ rel: string; depth: number; sensitive: boolean }> = [{ rel: relative, depth: 0, sensitive }];
  let visited = 0;
  const probe = budget.fork();
  while (pending.length > 0) {
    const { rel, depth, sensitive: inSensitive } = pending.pop()!;
    const path = join(root, ...rel.split("/"));
    local[`${rel}/`] = await directorySignal(path);
    let names: string[];
    try { names = (await readdir(path)).sort(); } catch { continue; }
    for (const name of names) {
      if (++visited > maxEntries) return false;
      const childRel = `${rel}/${name}`, childPath = join(path, name);
      let info;
      try { info = await lstat(childPath); } catch { local[childRel] = "<unreadable>"; continue; }
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (depth + 1 > IGNORED_MONITOR_LIMITS.maxWalkDepth) return false;
        pending.push({ rel: childRel, depth: depth + 1, sensitive: inSensitive || SENSITIVE_DIRECTORY.test(name.toLowerCase()) });
      } else {
        const content = inSensitive || sensitiveIgnoredName(name);
        if (content) probe.sensitive++;
        local[childRel] = await fileRecord(childPath, content, probe);
      }
    }
  }
  Object.assign(records, local);
  budget.commit(probe);
  return true;
}

/**
 * Observes the ignored entries Git listed (`observeWorkspace(..., { ignored: true })`) plus the protected paths.
 * Deterministic: the same filesystem state yields the same digest.
 */
export async function observeIgnored(root: string, listing: readonly string[], policy: IgnoredProtectionPolicy = {}):
  Promise<IgnoredObservation> {
  const records: Record<string, string> = Object.create(null) as Record<string, string>;
  const budget = new Budget();
  const entries = listing.filter(entry => entry !== ".fusion/" && !entry.startsWith(".fusion/") && entry !== ".fusion");
  const considered = entries.slice(0, IGNORED_MONITOR_LIMITS.maxListedEntries);
  if (entries.length > considered.length) {
    budget.reasons.add("listingBound"); budget.unmonitored += entries.length - considered.length;
  }
  const protectedPaths = policy.protectedPaths ?? [];
  for (const entry of protectedPaths) {
    const directory = entry.endsWith("/"), rel = directory ? entry.slice(0, -1) : entry;
    const path = join(root, ...rel.split("/"));
    if (!isContainedPath(root, path)) failWith("SecurityViolation", "A protected path escapes the primary workspace.");
    if (directory) {
      if (!await walk(root, rel, true, budget, records, IGNORED_MONITOR_LIMITS.maxWalkEntries * 2)) {
        records[`protected:${entry}`] = await directorySignal(path);
        budget.truncated++; budget.reasons.add("directoryWalkBound");
      }
    } else {
      budget.sensitive++;
      records[`protected:${entry}`] = await fileRecord(path, true, budget);
    }
  }
  for (const entry of considered) {
    const directory = entry.endsWith("/"), rel = directory ? entry.slice(0, -1) : entry;
    const path = join(root, ...rel.split("/"));
    if (rel.length === 0 || !isContainedPath(root, path)) failWith("SecurityViolation", "Git listed an ignored path outside the workspace.");
    const name = rel.split("/").at(-1)!;
    if (!directory) {
      const content = sensitiveIgnoredName(name) || rel.split("/").slice(0, -1).some(part => SENSITIVE_DIRECTORY.test(part.toLowerCase()));
      if (content) budget.sensitive++;
      records[entry] = await fileRecord(path, content, budget);
    } else if (managedIgnoredDirectory(name)) {
      records[entry] = await directorySignal(path);
      budget.managed++; budget.reasons.add("managedDirectoryContents");
    } else if (!await walk(root, rel, SENSITIVE_DIRECTORY.test(name.toLowerCase()), budget, records, IGNORED_MONITOR_LIMITS.maxWalkEntries)) {
      records[entry] = await directorySignal(path);
      budget.truncated++; budget.reasons.add("directoryWalkBound");
    }
  }
  const ordered = Object.keys(records).sort().map(key => [key, records[key]]);
  const reasons = [...budget.reasons].sort();
  const coverage: IgnoredCoverage = Object.freeze({ state: reasons.length === 0 ? "complete" : "partial", listed: entries.length,
    contentFiles: budget.content, metadataFiles: budget.metadata, sensitiveFiles: budget.sensitive, protectedPaths: protectedPaths.length,
    managedDirectories: budget.managed, truncatedDirectories: budget.truncated, unmonitoredEntries: budget.unmonitored,
    reasons: Object.freeze(reasons) });
  return Object.freeze({ digest: sha256(JSON.stringify({ listing: entries, records: ordered })), coverage });
}

/**
 * The primary checkout's fingerprint for an autonomous run: the Git snapshot (HEAD, index, flags, locations, config,
 * metadata, tracked and untracked files) plus the bounded ignored-path observation, from one status process. An
 * incomplete Git snapshot fails closed; a partial ignored coverage is reported (`coverage`), never hidden.
 */
export class PrimaryWorkspaceMonitor {
  #coverage: IgnoredCoverage | undefined;
  constructor(readonly root: string, private readonly git: GitClient, private readonly policy: IgnoredProtectionPolicy = {}) {}
  /** The coverage of the latest observation. */
  get coverage(): IgnoredCoverage | undefined { return this.#coverage; }
  async observe(signal?: AbortSignal): Promise<Readonly<{ snapshot: WorkspaceSnapshot; ignored: IgnoredObservation; digest: string }>> {
    const observed = await observeWorkspace(this.git, this.root, { ignored: true, ...(signal ? { signal } : {}) });
    if (!observed.snapshot.complete) failWith("SecurityViolation", "The primary workspace has too many changes to be proven unchanged.");
    const ignored = await observeIgnored(this.root, observed.ignored ?? [], this.policy);
    this.#coverage = ignored.coverage;
    return { snapshot: observed.snapshot, ignored, digest: sha256(JSON.stringify({ git: observed.snapshot, ignored: ignored.digest })) };
  }
  async fingerprint(signal?: AbortSignal): Promise<string> { return (await this.observe(signal)).digest; }
}
