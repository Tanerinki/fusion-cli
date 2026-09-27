import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { canonicalChangePath } from "../../core/change/contract.js";
import { failWith } from "../../core/errors.js";
import type { CleanupReport } from "../../core/workflow/types.js";
import { isContainedPath } from "../events/shared.js";
import { readBoundedFile } from "../fs/bounded-read.js";
import { fusionTemporaryBase } from "../fs/temporary.js";
import { captureControlledTree, compareControlledTrees, type ControlledTreeSnapshot } from "../verification/controlled-tree.js";
import { comparablePath, ProcessGitClient } from "./git.js";
import { cleanPrivateRoot, cloneAt } from "./private-writer.js";
import { PROVIDER_INPUT_LIMITS, type ProviderInputDecision } from "./sensitive-input.js";
import { observeWorkspace } from "./snapshot.js";

/**
 * Fusion-owned PROVIDER VIEWS: the only directories a provider session is ever started in during a workflow.
 *
 *  - `baseline`: the committed HEAD of the primary, checked out by a private remote-less clone whose `.git` is then
 *    deleted — plain files only, never the user's `.git`, never uncommitted work, never ignored files.
 *  - `candidate`: a copy of a host-applied private candidate WITHOUT its `.git`, verified file-for-file against the tree
 *    Fusion applied. The candidate itself (Fusion's only mutable workspace) is never handed to a provider.
 *  - `workingTree`: `baseline` plus the primary's tracked changes and untracked, non-ignored files, each verified against
 *    the digest Git status observed. Only a read-only review or read-only build uses it (its subject is the user's
 *    current work); an autonomous Writer baseline never does.
 *
 * Every view excludes Fusion storage and the declared provider state/configuration paths, contains no link, has a
 * random identity recorded in an owner marker, and is fingerprinted as a whole (marker included) so any write to it is
 * detected. Removal requires the in-memory identity to match the marker: never a name prefix alone.
 *
 * A view is NOT an OS boundary: a host process can still open an absolute path elsewhere. It removes the primary as the
 * working directory and as the source tree a role reads; it does not make the primary unreachable.
 */
export const PROVIDER_VIEW_PREFIX = "fusion-provider-view-";
export const PROVIDER_VIEW_LIMITS = Object.freeze({ maxOverlayFiles: 20_000, maxOverlayBytes: 512 * 1024 * 1024,
  maxOverlayFileBytes: 64 * 1024 * 1024, maxCopyEntries: 50_000, defaultStaleAgeMs: 60 * 60_000 });
export type ProviderViewKind = "baseline" | "candidate" | "workingTree" | "folder";
/** Always excluded from a view, whatever the provider profiles declare. */
const ALWAYS_EXCLUDED = Object.freeze([".git", ".fusion"]);
const MARKER = ".fusion-owner";
const WORKSPACE = "workspace";
const VIEW_ID = /^view-[0-9a-f]{24}$/u;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export interface ProviderView {
  readonly viewId: string;
  readonly kind: ProviderViewKind;
  /** The directory a provider session runs in (`<owned root>/workspace`). */
  readonly path: string;
  /** The commit the view was built from (empty for a folder view: an ordinary folder has none). */
  readonly baseCommit: string;
  /** The view's fingerprint at creation; any later fingerprint must equal it. */
  readonly identity: string;
  /** v0.2: what the input policy did while the view was built (when one was applied). */
  readonly exposure?: ViewExposure;
}
/** v0.2: the decision of an input policy for one file of a view (see `sensitive-input.ts`). */
export type ViewInputFilter = (relPath: string, bytes: Buffer) => ProviderInputDecision;
/** What a provider could and could not read in a view: counts, and the redacted and withheld paths (bounded lists). */
export interface ViewExposure {
  readonly shared: number;
  readonly redacted: readonly Readonly<{ path: string; reason: string }>[];
  readonly redactedCount: number;
  readonly excluded: readonly Readonly<{ path: string; reason: string }>[];
  readonly excludedCount: number;
}
const MAX_EXPOSURE_LIST = 200;
/** Counts what an input policy decided, file by file (bounded path lists). */
class ExposureLedger {
  #shared = 0; #redactedCount = 0; #excludedCount = 0;
  readonly #redacted: Array<{ path: string; reason: string }> = [];
  readonly #excluded: Array<{ path: string; reason: string }> = [];
  record(path: string, decision: ProviderInputDecision): void {
    if (decision.status === "excluded") {
      this.#excludedCount++;
      if (this.#excluded.length < MAX_EXPOSURE_LIST) this.#excluded.push({ path, reason: decision.reason ?? "withheld" });
    } else if (decision.status === "redacted") {
      this.#redactedCount++;
      if (this.#redacted.length < MAX_EXPOSURE_LIST) this.#redacted.push({ path, reason: decision.reason ?? "redacted" });
    } else this.#shared++;
  }
  freeze(): ViewExposure {
    const byPath = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    return Object.freeze({ shared: this.#shared, redacted: Object.freeze([...this.#redacted].sort(byPath)), redactedCount: this.#redactedCount,
      excluded: Object.freeze([...this.#excluded].sort(byPath)), excludedCount: this.#excludedCount });
  }
}
export interface ProviderViewStoreOptions {
  /** Absolute top level of the user's primary repository. */
  readonly primaryRoot: string;
  /** A Git client without ambient configuration. */
  readonly git: ProcessGitClient;
  /** Top-level names never copied into a view (declared provider state/configuration paths). */
  readonly excludedPaths?: readonly string[];
}
interface Entry { readonly view: ProviderView; readonly root: string; released: boolean }

/** True when `child` is `parent` or inside it, compared case-insensitively on Windows. */
function inside(parent: string, child: string): boolean {
  const a = comparablePath(resolve(parent)), b = comparablePath(resolve(child));
  const separator = process.platform === "win32" ? "\\" : "/";
  return a === b || b.startsWith(`${a}${separator}`);
}

async function removeEntry(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) { await unlink(path).catch(() => rm(path, { force: true })); return; }
  // A directory created by Fusion's own clone or copy: remove it without following any link inside it.
  const pending = [path];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const name of await readdir(directory)) {
      const child = join(directory, name), childInfo = await lstat(child);
      if (childInfo.isSymbolicLink()) await unlink(child).catch(() => rm(child, { force: true }));
      else if (childInfo.isDirectory()) pending.push(child);
    }
  }
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Copies a controlled tree (no links, bounded) from `source` into `target`, skipping the excluded top-level names. */
async function copyTree(source: string, target: string, excluded: ReadonlySet<string>): Promise<void> {
  const pending = [""];
  let entries = 0;
  while (pending.length > 0) {
    const rel = pending.pop()!;
    const from = rel === "" ? source : join(source, ...rel.split("/")), to = rel === "" ? target : join(target, ...rel.split("/"));
    if (rel !== "") await mkdir(to);
    for (const name of (await readdir(from)).sort()) {
      if (rel === "" && excluded.has(name.toLowerCase())) continue;
      if (++entries > PROVIDER_VIEW_LIMITS.maxCopyEntries) failWith("SecurityViolation", "A provider view source exceeds its entry limit.");
      const childRel = rel === "" ? name : `${rel}/${name}`, info = await lstat(join(from, name));
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        failWith("SecurityViolation", "A provider view source contains a link or special file.");
      if (info.isDirectory()) pending.push(childRel);
      else await copyFile(join(from, name), join(to, name));
    }
  }
}

/** The expected tree minus the excluded top-level names (a view never contains them). */
function withoutExcluded(tree: ControlledTreeSnapshot, excluded: ReadonlySet<string>): ControlledTreeSnapshot {
  const digests: Record<string, string> = {};
  for (const [path, digest] of Object.entries(tree.digests))
    if (!excluded.has(path.split("/")[0]!.toLowerCase())) digests[path] = digest;
  return { digests, complete: tree.complete };
}

/** Applies an input policy to every file of a freshly built workspace (Fusion-owned, no links): withholds or rewrites. */
async function applyInputFilter(workspace: string, filter: ViewInputFilter): Promise<ViewExposure> {
  const ledger = new ExposureLedger();
  const pending = [""];
  while (pending.length > 0) {
    const rel = pending.pop()!;
    const directory = rel === "" ? workspace : join(workspace, ...rel.split("/"));
    for (const name of (await readdir(directory)).sort()) {
      const childRel = rel === "" ? name : `${rel}/${name}`, path = join(directory, name), info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) failWith("SecurityViolation", "A provider view contains a link or special file.");
      if (info.isDirectory()) { pending.push(childRel); continue; }
      const decision = filter(childRel, await readFile(path));
      if (decision.status === "excluded") await unlink(path);
      else if (decision.status === "redacted") await writeFile(path, decision.content ?? Buffer.alloc(0));
      ledger.record(childRel, decision);
    }
  }
  return ledger.freeze();
}

/** Fingerprint of a view's whole owned root: marker, workspace, and anything a provider added next to them. */
async function rootFingerprint(root: string): Promise<string> {
  const tree = await captureControlledTree(root, true);
  return sha256(JSON.stringify({ complete: tree.complete, digests: Object.keys(tree.digests).sort().map(key => [key, tree.digests[key]]) }));
}

export class ProviderViewStore {
  /** Every view lies strictly inside this Fusion-owned temporary directory, in its own owned root. */
  readonly viewRoot = fusionTemporaryBase();
  readonly #entries = new Map<string, Entry>();
  readonly #excluded: ReadonlySet<string>;
  constructor(private readonly options: ProviderViewStoreOptions) {
    if (!isAbsolute(options.primaryRoot)) failWith("InvalidInput", "The view store needs an absolute primary repository root.");
    if (!(options.git instanceof ProcessGitClient) || !options.git.isolatedConfig)
      failWith("SecurityViolation", "Provider views require a Git client without ambient configuration.");
    for (const name of options.excludedPaths ?? [])
      if (typeof name !== "string" || name.length === 0 || name.includes("/") || name.includes("\\") || name === "." || name === "..")
        failWith("InvalidInput", "Provider view exclusions are top-level names.");
    this.#excluded = new Set([...ALWAYS_EXCLUDED, ...(options.excludedPaths ?? [])].map(name => name.toLowerCase()));
  }
  get primaryRoot(): string { return resolve(this.options.primaryRoot); }
  /** The top-level names no view contains. */
  get excludedPaths(): readonly string[] { return [...this.#excluded].sort(); }

  /**
   * A fresh owned root with its marker; `build` fills `<root>/workspace`. A failed build removes the root. An input `filter`
   * runs over every file before the view's identity is taken, so what it withheld or redacted is part of what is verified.
   */
  async #create(ownerId: string, kind: ProviderViewKind, baseCommit: string,
    build: (workspace: string) => Promise<ViewExposure | void>, filter?: ViewInputFilter): Promise<ProviderView> {
    if (!OWNER.test(ownerId)) failWith("InvalidInput", "A provider view needs a valid owner.");
    if (kind === "folder" ? baseCommit !== "" : !COMMIT.test(baseCommit)) failWith("WorkspaceConflict", "A provider view requires a committed baseline.");
    const viewId = `view-${randomBytes(12).toString("hex")}`;
    const root = await mkdtemp(join(fusionTemporaryBase(), PROVIDER_VIEW_PREFIX));
    const workspace = join(root, WORKSPACE);
    try {
      if (inside(this.primaryRoot, root) || inside(root, this.primaryRoot))
        failWith("SecurityViolation", "A provider view can never be the primary workspace or overlap it.");
      await writeFile(join(root, MARKER), JSON.stringify({ schemaVersion: 1, kind: "providerView", viewId, viewKind: kind,
        ownerPid: process.pid, ownerId, baseCommit, createdAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
      // A build that applied the policy while copying reports its own exposure; otherwise the policy runs over the result.
      const built = await build(workspace);
      const exposure = built ?? (filter === undefined ? undefined : await applyInputFilter(workspace, filter));
      const tree = await captureControlledTree(workspace);
      if (!tree.complete) failWith("SecurityViolation", "A provider view contains a link, a special file or too much content.");
      const view: ProviderView = Object.freeze({ viewId, kind, path: workspace, baseCommit, identity: await rootFingerprint(root),
        ...(exposure === undefined ? {} : { exposure }) });
      this.#entries.set(viewId, { view, root, released: false });
      return view;
    } catch (error) {
      try { await cleanPrivateRoot(root, PROVIDER_VIEW_PREFIX); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Provider view creation and cleanup both failed."); }
      throw error;
    }
  }

  /** Removes `.git` and the excluded top-level names from a freshly checked-out workspace. */
  async #strip(workspace: string): Promise<void> {
    for (const name of await readdir(workspace))
      if (this.#excluded.has(name.toLowerCase())) await removeEntry(join(workspace, name));
  }

  async #headCommit(signal?: AbortSignal): Promise<string> {
    const observed = await observeWorkspace(this.options.git, this.primaryRoot, signal ? { signal } : {});
    if (comparablePath(observed.topLevel) !== comparablePath(await realpath(this.primaryRoot)))
      failWith("WorkspaceConflict", "Provider views require the primary repository's top level.");
    if (observed.snapshot.head === null) failWith("WorkspaceConflict", "Provider views require a committed primary repository.");
    return observed.snapshot.head;
  }

  /** The committed baseline as plain files: a private clone at HEAD whose own `.git` is deleted before any provider runs. */
  async baseline(ownerId: string, signal?: AbortSignal): Promise<ProviderView> {
    const commit = await this.#headCommit(signal);
    return this.#create(ownerId, "baseline", commit, async workspace => {
      await cloneAt(this.options.git, this.primaryRoot, workspace, commit, signal, false);
      await this.#strip(workspace);
    });
  }

  /**
   * A copy of a host-applied candidate without its `.git`, verified against the tree Fusion applied (`tree`, from
   * `PrivateWriterWorkspace.expectedTree`). The candidate path itself is never returned.
   */
  async candidate(ownerId: string, source: Readonly<{ path: string; tree: ControlledTreeSnapshot; baseCommit: string }>,
    signal?: AbortSignal): Promise<ProviderView> {
    if (!source.tree.complete) failWith("SecurityViolation", "A candidate view needs a complete candidate tree.");
    if (signal?.aborted) failWith("Cancelled", "The provider view was cancelled.");
    const expected = withoutExcluded(source.tree, this.#excluded);
    return this.#create(ownerId, "candidate", source.baseCommit, async workspace => {
      await mkdir(workspace);
      await copyTree(source.path, workspace, this.#excluded);
      const copied = await captureControlledTree(workspace);
      if (!copied.complete || compareControlledTrees(expected, copied).length !== 0)
        failWith("SecurityViolation", "The candidate view differs from the candidate Fusion applied.");
    });
  }

  /**
   * The primary's current work for a READ-ONLY review or build: the committed baseline plus every tracked change and
   * untracked, non-ignored file Git status reports, each copied only if its content still has the digest status observed.
   * Ignored files (`.env`, `node_modules`) are never copied; links and special files are omitted (the review diff notes them).
   */
  async workingTree(ownerId: string, signal?: AbortSignal, filter?: ViewInputFilter): Promise<ProviderView> {
    const observed = await observeWorkspace(this.options.git, this.primaryRoot, signal ? { signal } : {});
    const { snapshot } = observed;
    // Status paths are relative to the top level: a subdirectory would copy the wrong files.
    if (comparablePath(observed.topLevel) !== comparablePath(await realpath(this.primaryRoot)))
      failWith("WorkspaceConflict", "Provider views require the primary repository's top level.");
    if (snapshot.head === null || !snapshot.complete) failWith("WorkspaceConflict", "A working-tree view needs a committed, fully observed primary.");
    if (snapshot.entries.length > PROVIDER_VIEW_LIMITS.maxOverlayFiles) failWith("SecurityViolation", "The primary has too many changes to copy.");
    const commit = snapshot.head;
    return this.#create(ownerId, "workingTree", commit, async workspace => {
      await cloneAt(this.options.git, this.primaryRoot, workspace, commit, signal, false);
      await this.#strip(workspace);
      let bytes = 0;
      for (const entry of snapshot.entries) {
        const rel = canonicalChangePath(entry.path);
        if (this.#excluded.has(rel.split("/")[0]!.toLowerCase())) continue;
        const from = join(this.primaryRoot, ...rel.split("/")), to = join(workspace, ...rel.split("/"));
        if (!isContainedPath(this.primaryRoot, from) || !isContainedPath(workspace, to))
          failWith("SecurityViolation", "A working-tree path escapes its root.");
        const digest = snapshot.digests[entry.path];
        if (digest === "<missing>") { await removeEntry(to); continue; }
        if (digest === undefined || !digest.startsWith("sha256:")) continue;
        const content = await readBoundedFile(from, PROVIDER_VIEW_LIMITS.maxOverlayFileBytes);
        bytes += content.length;
        if (bytes > PROVIDER_VIEW_LIMITS.maxOverlayBytes) failWith("SecurityViolation", "The primary's changes exceed the view byte limit.");
        if (`sha256:${sha256(content)}` !== digest) failWith("WorkspaceConflict", "The primary changed while its working-tree view was built.");
        let parent = workspace;
        for (const part of rel.split("/").slice(0, -1)) {
          parent = join(parent, part);
          const info = await lstat(parent).catch(() => undefined);
          if (info === undefined) await mkdir(parent);
          else if (!info.isDirectory() || info.isSymbolicLink()) failWith("SecurityViolation", "A working-tree path crosses a non-directory.");
        }
        await removeEntry(to);
        await writeFile(to, content, { flag: "wx" });
      }
    }, filter);
  }

  /**
   * v0.2 — a READ-ONLY view of an ORDINARY FOLDER (no Git): a copy of exactly the listed regular files (paths relative to
   * the primary root), each re-checked to be a regular file reached through real directories, never a link. The primary is
   * only read. With an input `filter`, sensitive files are withheld or redacted before the view's identity is taken.
   */
  async folder(ownerId: string, paths: readonly string[], filter?: ViewInputFilter, signal?: AbortSignal): Promise<ProviderView> {
    if (paths.length > PROVIDER_VIEW_LIMITS.maxOverlayFiles) failWith("SecurityViolation", "The folder has too many files to copy.");
    // The input policy is applied WHILE copying: a withheld file is never written into the view, a redacted one only redacted.
    return this.#create(ownerId, "folder", "", async workspace => {
      await mkdir(workspace);
      const ledger = new ExposureLedger();
      let bytes = 0;
      for (const path of paths) {
        if (signal?.aborted) failWith("Cancelled", "The provider view was cancelled.");
        const rel = canonicalChangePath(path);
        if (this.#excluded.has(rel.split("/")[0]!.toLowerCase())) continue;
        const from = join(this.primaryRoot, ...rel.split("/")), to = join(workspace, ...rel.split("/"));
        if (!isContainedPath(this.primaryRoot, from) || !isContainedPath(workspace, to))
          failWith("SecurityViolation", "A folder path escapes its root.");
        let source = this.primaryRoot, reachable = true, size = 0;
        for (const part of rel.split("/")) {
          source = join(source, part);
          const info = await lstat(source).catch(() => undefined);
          if (info === undefined || info.isSymbolicLink() || (source !== from && !info.isDirectory()) || (source === from && !info.isFile())) {
            reachable = false; break;
          }
          size = info.size;
        }
        if (!reachable) continue;  // removed or replaced since the listing: not copied, never followed
        // Too large to share (a recorder database, a media file): withheld without being read.
        if (filter !== undefined && size > PROVIDER_INPUT_LIMITS.maxTextBytes) { ledger.record(rel, { status: "excluded", reason: "too large to share" }); continue; }
        const raw = await readBoundedFile(from, PROVIDER_VIEW_LIMITS.maxOverlayFileBytes).catch(() => undefined);
        if (raw === undefined) continue;
        const decision = filter === undefined ? undefined : filter(rel, raw);
        if (decision !== undefined) ledger.record(rel, decision);
        if (decision?.status === "excluded") continue;
        const content = decision?.status === "redacted" ? decision.content ?? Buffer.alloc(0) : raw;
        bytes += content.length;
        if (bytes > PROVIDER_VIEW_LIMITS.maxOverlayBytes) failWith("SecurityViolation", "The folder exceeds the view byte limit.");
        let parent = workspace;
        for (const part of rel.split("/").slice(0, -1)) {
          parent = join(parent, part);
          if ((await lstat(parent).catch(() => undefined)) === undefined) await mkdir(parent);
        }
        await writeFile(to, content, { flag: "wx" });
      }
      return filter === undefined ? undefined : ledger.freeze();
    });
  }

  #entry(viewId: string): Entry {
    const entry = this.#entries.get(viewId);
    if (entry === undefined || entry.released) failWith("WorkspaceConflict", "Unknown or released provider view.");
    return entry;
  }
  /** Fingerprint of the whole owned root now; equal to `identity` exactly when nothing was written to the view. */
  async fingerprint(viewId: string): Promise<string> { return rootFingerprint(this.#entry(viewId).root); }

  /** Removes a view after checking its marker names this exact view. Never throws for an incomplete removal. */
  async release(viewId: string): Promise<CleanupReport> {
    const entry = this.#entries.get(viewId);
    if (entry === undefined || entry.released) return { complete: false, reason: "unknown-view" };
    entry.released = true;
    try {
      const marker = await ownerMarker(entry.root);
      if (marker?.viewId !== viewId) return { complete: false, reason: "view-marker-mismatch" };
      await cleanPrivateRoot(entry.root, PROVIDER_VIEW_PREFIX);
    } catch { return { complete: false, reason: "view-removal-failed" }; }
    try { await lstat(entry.root); return { complete: false, reason: "view-still-present" }; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { complete: true } : { complete: false, reason: "view-unverifiable" }; }
  }

  /** Every view this store created and has not released (for crash-free teardown and tests). */
  live(): readonly ProviderView[] { return [...this.#entries.values()].filter(entry => !entry.released).map(entry => entry.view); }

  /**
   * Views left behind by a process that no longer exists (or with an unreadable marker). Detection only.
   */
  static async findStale(): Promise<readonly StaleView[]> {
    const found: StaleView[] = [];
    const root = fusionTemporaryBase();
    for (const name of await readdir(root)) {
      if (!name.startsWith(PROVIDER_VIEW_PREFIX)) continue;
      const path = join(root, name);
      let info;
      try { info = await lstat(path); } catch { continue; }
      if (info.isSymbolicLink() || !info.isDirectory()) { found.push({ path, state: "notADirectory" }); continue; }
      const marker = await ownerMarker(path).catch(() => undefined);
      if (marker === undefined) { found.push({ path, state: "unverifiable" }); continue; }
      if (!ownerGone(marker.ownerPid)) continue;
      found.push({ path, state: "ownerGone", viewId: marker.viewId, createdAtMs: Date.parse(marker.createdAt) });
    }
    return found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  /**
   * Removes stale views whose marker proves they are Fusion provider views of a dead owner and older than `minAgeMs`.
   * An unverifiable marker, a link, a live owner or a young view is left in place and reported; a failed removal is
   * reported, never hidden.
   */
  static async sweepStale(options: Readonly<{ minAgeMs?: number; nowMs?: number }> = {}): Promise<StaleSweepReport> {
    const minAgeMs = options.minAgeMs ?? PROVIDER_VIEW_LIMITS.defaultStaleAgeMs, nowMs = options.nowMs ?? Date.now();
    let removed = 0, kept = 0;
    const failures: string[] = [];
    for (const stale of await ProviderViewStore.findStale()) {
      if (stale.state !== "ownerGone" || !Number.isFinite(stale.createdAtMs) || nowMs - stale.createdAtMs! < minAgeMs) { kept++; continue; }
      const base = fusionTemporaryBase();
      if (dirname(stale.path) !== base || !basename(stale.path).startsWith(PROVIDER_VIEW_PREFIX) ||
          !stale.path.toLowerCase().startsWith(`${base.toLowerCase()}${sep}`)) { kept++; continue; }
      try {
        const marker = await ownerMarker(stale.path);
        if (marker?.viewId !== stale.viewId) { kept++; continue; }
        await cleanPrivateRoot(stale.path, PROVIDER_VIEW_PREFIX);
        removed++;
      } catch { failures.push("view-removal-failed"); }
    }
    return Object.freeze({ removed, kept, failures: Object.freeze(failures), complete: failures.length === 0 });
  }
}

export interface StaleView {
  readonly path: string;
  readonly state: "ownerGone" | "unverifiable" | "notADirectory";
  readonly viewId?: string;
  readonly createdAtMs?: number;
}
export interface StaleSweepReport {
  readonly removed: number;
  readonly kept: number;
  readonly failures: readonly string[];
  readonly complete: boolean;
}

interface Marker { readonly viewId: string; readonly ownerPid: number; readonly createdAt: string }
/** The owner marker, or undefined when it is missing, oversized, a link or not a provider-view marker. */
async function ownerMarker(root: string): Promise<Marker | undefined> {
  const path = join(root, MARKER);
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink() || info.size > 4096) return undefined;
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
  const marker = value as Partial<Marker> & { kind?: unknown; schemaVersion?: unknown };
  return marker !== null && typeof marker === "object" && marker.schemaVersion === 1 && marker.kind === "providerView" &&
    typeof marker.viewId === "string" && VIEW_ID.test(marker.viewId) && Number.isSafeInteger(marker.ownerPid) &&
    (marker.ownerPid as number) > 0 && typeof marker.createdAt === "string" ? marker as Marker : undefined;
}
function ownerGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
