import { lstat, open, readdir, unlink, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { failWith, FusionFailure } from "../../core/errors.js";
import { readBoundedFile } from "../fs/bounded-read.js";
import { removeOwnedTemporary } from "../fs/temporary.js";
import { ensureFusionStorageRoot, ensureOwnedDir } from "../events/run-store.js";
import { atomicJson, enqueuePath, isContainedPath, isRecord, makeId, safeTimestamp, StorageError } from "../events/shared.js";
import { comparablePath, gitOk, parseWorktreeList, type GitClient } from "./git.js";
import { captureSnapshot } from "./snapshot.js";

export type LeaseState = "creating" | "active" | "releasing" | "released";
/** Registry record under `.fusion/leases/<leaseId>.json`. Contains no user identity. */
export interface LeaseRecord {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly state: LeaseState;
  readonly baseCommit: string;
  /** Always `.fusion/worktrees/<leaseId>`, relative to the primary workspace. */
  readonly worktree: string;
  /** Process that created the lease; a dead owner makes a non-released lease stale. */
  readonly ownerPid: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface WorkspaceLease {
  readonly leaseId: string;
  readonly ownerId: string;
  /** Absolute path of the isolated worktree. Never the primary workspace. */
  readonly path: string;
  readonly baseCommit: string;
  readonly primaryRoot: string;
}
export interface LeaseManagerOptions {
  readonly repositoryRoot: string;
  readonly git: GitClient;
  /** Test seam; defaults to a signal-0 liveness probe. */
  readonly processAlive?: (pid: number) => boolean;
  readonly ownerPid?: number;
}
export interface ReleaseOptions {
  /** Removing a lease that holds uncommitted or committed-but-unintegrated work requires explicit consent. */
  readonly discardChanges?: boolean;
  readonly signal?: AbortSignal;
}

const LEASE_ID = /^l-[0-9a-z]{10}-[0-9a-f]{32}$/u;
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
/** Refs are resolved, never interpreted by a shell; option-like, range, path and control syntax are refused. */
const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*[:\\\s])[A-Za-z0-9._/@{}~^-]{1,200}$/u;
const LOCK_REASON = "fusion-lease";
const MAX_REMOVAL_ENTRIES = 500_000;
const queues = new Map<string, { tail: Promise<void> }>();

const defaultAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
function mapStorage(error: unknown): never {
  if (error instanceof FusionFailure) throw error;
  if (error instanceof StorageError)
    failWith("SecurityViolation", "Fusion workspace storage is not a real directory inside the repository.", false, error);
  throw error;
}

/**
 * One autonomous writer per isolated Git worktree. The primary workspace is only read (never stashed, reset,
 * cleaned, checked out, merged or rebased); Fusion creates detached worktrees under its own self-ignored
 * `.fusion/worktrees/`, locks them against `git worktree prune`, and only ever removes the exact worktree it owns.
 */
export class WorkspaceLeaseManager {
  readonly #processAlive: (pid: number) => boolean;
  readonly #ownerPid: number;
  private constructor(readonly primaryRoot: string, private readonly git: GitClient,
    readonly leasesRoot: string, readonly worktreesRoot: string, options: LeaseManagerOptions) {
    this.#processAlive = options.processAlive ?? defaultAlive;
    this.#ownerPid = options.ownerPid ?? process.pid;
  }

  static async open(options: LeaseManagerOptions): Promise<WorkspaceLeaseManager> {
    if (typeof options.repositoryRoot !== "string" || !isAbsolute(options.repositoryRoot))
      failWith("InvalidInput", "Repository root must be an existing absolute directory.");
    const root = resolve(options.repositoryRoot);
    try { if (!(await lstat(root)).isDirectory()) throw new Error("not a directory"); }
    catch (error) { failWith("InvalidInput", "Repository root must be an existing absolute directory.", false, error); }
    // Git is consulted before anything is created, so a wrong path never gains a `.fusion` directory.
    const top = await options.git.run(["rev-parse", "--is-bare-repository", "--show-toplevel"], { cwd: root });
    if (top.exitCode !== 0) failWith("WorkspaceConflict", "The directory is not inside a Git working tree.");
    const [bare, toplevel] = top.stdout.split(/\r?\n/u);
    if (bare !== "false" || !toplevel) failWith("WorkspaceConflict", "Bare repositories cannot host workspace leases.");
    if (comparablePath(toplevel) !== comparablePath(root))
      failWith("WorkspaceConflict", "The repository root must be the top level of its working tree.");
    let fusion: string;
    try { fusion = await ensureFusionStorageRoot(root); } catch (error) { mapStorage(error); }
    const leases = join(fusion, "leases"), worktrees = join(fusion, "worktrees");
    try { await ensureOwnedDir(leases); await ensureOwnedDir(worktrees); } catch (error) { mapStorage(error); }
    return new WorkspaceLeaseManager(root, options.git, leases, worktrees, options);
  }

  /** Canonical, contained locations; any input that is not a Fusion lease ID is refused before path use. */
  private paths(leaseId: string): Readonly<{ record: string; worktree: string }> {
    if (typeof leaseId !== "string" || !LEASE_ID.test(leaseId)) failWith("InvalidInput", "Invalid workspace lease identifier.");
    const record = join(this.leasesRoot, `${leaseId}.json`), worktree = join(this.worktreesRoot, leaseId);
    if (!isContainedPath(this.leasesRoot, record) || !isContainedPath(this.worktreesRoot, worktree) ||
        comparablePath(worktree) === comparablePath(this.primaryRoot))
      failWith("SecurityViolation", "Workspace lease path escapes Fusion storage.");
    return { record, worktree };
  }

  private async ensureRoots(): Promise<void> {
    try { await ensureFusionStorageRoot(this.primaryRoot); await ensureOwnedDir(this.leasesRoot); await ensureOwnedDir(this.worktreesRoot); }
    catch (error) { mapStorage(error); }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    return enqueuePath(queues, comparablePath(this.primaryRoot), () => ({ tail: Promise.resolve() }), operation);
  }

  async acquire(request: Readonly<{ ownerId: string; baseRef?: string; signal?: AbortSignal }>): Promise<WorkspaceLease> {
    if (typeof request.ownerId !== "string" || !OWNER_ID.test(request.ownerId)) failWith("InvalidInput", "Invalid lease owner identifier.");
    const ref = request.baseRef ?? "HEAD";
    if (typeof ref !== "string" || !SAFE_REF.test(ref)) failWith("InvalidInput", "Invalid base reference for a workspace lease.");
    return this.serialized(async () => {
      if (request.signal?.aborted) failWith("Cancelled", "Workspace lease acquisition was cancelled.");
      await this.ensureRoots();
      const signalOption = request.signal ? { signal: request.signal } : {};
      const resolved = await this.git.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
        { cwd: this.primaryRoot, ...signalOption });
      const baseCommit = resolved.stdout.trim();
      if (resolved.exitCode !== 0 || !COMMIT.test(baseCommit))
        failWith("WorkspaceConflict", ref === "HEAD" ? "The repository has no commit to base a workspace lease on." :
          "The base reference does not name a commit.");
      const leaseId = makeId("l");
      const { record: recordPath, worktree } = this.paths(leaseId);
      const now = new Date().toISOString();
      const record: LeaseRecord = { schemaVersion: 1, leaseId, ownerId: request.ownerId, state: "creating", baseCommit,
        worktree: `.fusion/worktrees/${leaseId}`, ownerPid: this.#ownerPid, createdAt: now, updatedAt: now };
      // The record is written first so an interrupted creation is always discoverable as a stale lease.
      await this.createRecord(recordPath, record);
      try {
        await gitOk(this.git, ["worktree", "add", "--detach", "--lock", "--reason", LOCK_REASON, worktree, baseCommit],
          { cwd: this.primaryRoot, ...signalOption }, "create the lease worktree");
        await this.verifyWorktree(worktree, baseCommit);
      } catch (error) {
        try { await this.removeWorktree(record, true); } catch { /* leaves a stale, repairable record */ }
        throw error;
      }
      const active: LeaseRecord = { ...record, state: "active", updatedAt: new Date().toISOString() };
      await atomicJson(recordPath, active);
      return { leaseId, ownerId: request.ownerId, path: worktree, baseCommit, primaryRoot: this.primaryRoot };
    });
  }

  /** The single writer bound to a lease; any other owner is refused. */
  async assertOwner(leaseId: string, ownerId: string): Promise<WorkspaceLease> {
    const record = await this.get(leaseId);
    if (record.ownerId !== ownerId) failWith("WorkspaceConflict", "The workspace lease belongs to another writer.");
    if (record.state !== "active") failWith("WorkspaceConflict", "The workspace lease is not active.");
    const { worktree } = this.paths(leaseId);
    await this.assertRealDirectory(worktree);
    return { leaseId, ownerId, path: worktree, baseCommit: record.baseCommit, primaryRoot: this.primaryRoot };
  }

  async get(leaseId: string): Promise<LeaseRecord> {
    const { record } = this.paths(leaseId);
    return this.readRecord(record, leaseId);
  }

  async list(): Promise<readonly LeaseRecord[]> {
    await this.ensureRoots();
    const names = (await readdir(this.leasesRoot)).filter(name => /\.json$/u.test(name)).sort();
    const records: LeaseRecord[] = [];
    for (const name of names) {
      const leaseId = name.slice(0, -5);
      if (!LEASE_ID.test(leaseId)) continue;
      records.push(await this.readRecord(join(this.leasesRoot, name), leaseId));
    }
    return records;
  }

  /** Idempotent and scoped to the owned worktree. Refuses to discard work unless asked explicitly. */
  async release(leaseId: string, ownerId: string, options: ReleaseOptions = {}): Promise<void> {
    this.paths(leaseId);
    return this.serialized(async () => {
      const record = await this.get(leaseId);
      if (record.ownerId !== ownerId) failWith("WorkspaceConflict", "The workspace lease belongs to another writer.");
      if (record.state === "released") return;
      await this.removeWorktree(record, options.discardChanges === true, options.signal);
    });
  }

  /** A non-released lease whose owner process is gone, or whose worktree vanished, is stale. */
  async findStale(): Promise<readonly LeaseRecord[]> {
    const stale: LeaseRecord[] = [];
    for (const record of await this.list()) if (await this.isStale(record)) stale.push(record);
    return stale;
  }

  /** Targeted repair of one stale lease; never a generic prune and never a live owner's lease. */
  async repairStale(leaseId: string, options: ReleaseOptions = {}): Promise<void> {
    this.paths(leaseId);
    return this.serialized(async () => {
      const record = await this.get(leaseId);
      if (record.state === "released") return;
      if (!(await this.isStale(record))) failWith("WorkspaceConflict", "The workspace lease owner is still running.");
      await this.removeWorktree(record, options.discardChanges === true, options.signal);
    });
  }

  private async isStale(record: LeaseRecord): Promise<boolean> {
    if (record.state === "released") return false;
    if (!this.#processAlive(record.ownerPid)) return true;
    if (record.state !== "active") return false;
    try { await lstat(this.paths(record.leaseId).worktree); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  }

  private async removeWorktree(record: LeaseRecord, discard: boolean, signal?: AbortSignal): Promise<void> {
    const { record: recordPath, worktree } = this.paths(record.leaseId);
    const signalOption = signal ? { signal } : {};
    const present = await this.assertRealDirectory(worktree, true);
    if (present && !discard) {
      let snapshot;
      try { snapshot = await captureSnapshot(this.git, worktree, signal); }
      catch (error) {
        if (error instanceof FusionFailure && error.error.kind === "Cancelled") throw error;
        failWith("WorkspaceConflict", "Lease contents could not be inspected; pass discardChanges to remove it.", false, error);
      }
      if (snapshot.entries.length > 0 || snapshot.head !== record.baseCommit)
        failWith("WorkspaceConflict", "The workspace lease holds changes; pass discardChanges to remove it.");
    }
    await atomicJson(recordPath, { ...record, state: "releasing", updatedAt: new Date().toISOString() });
    // Links inside the worktree are removed as links first, so no later recursive delete can follow them.
    if (present) await this.unlinkReparsePoints(worktree);
    const listed = await gitOk(this.git, ["worktree", "list", "--porcelain", "-z"], { cwd: this.primaryRoot, ...signalOption },
      "list worktrees");
    if (parseWorktreeList(listed).some(entry => comparablePath(entry.path) === comparablePath(worktree))) {
      await this.git.run(["worktree", "unlock", worktree], { cwd: this.primaryRoot, ...signalOption });
      await gitOk(this.git, ["worktree", "remove", "--force", worktree], { cwd: this.primaryRoot, ...signalOption },
        "remove the lease worktree");
    }
    if (await this.assertRealDirectory(worktree, true)) await removeOwnedTemporary(worktree);
    await atomicJson(recordPath, { ...record, state: "released", updatedAt: new Date().toISOString() });
  }

  /** Refuses symlinks/junctions at a lease location, so removal can never operate through a reparse point. */
  private async assertRealDirectory(path: string, allowMissing = false): Promise<boolean> {
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      failWith("WorkspaceConflict", "The workspace lease directory is missing.", false, error);
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      failWith("SecurityViolation", "The workspace lease location is not a real directory; refusing to use it.");
    return true;
  }

  private async unlinkReparsePoints(root: string): Promise<void> {
    const pending = [root];
    let visited = 0;
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const name of await readdir(directory)) {
        if (++visited > MAX_REMOVAL_ENTRIES) failWith("WorkspaceConflict", "The workspace lease is too large to remove safely.");
        const path = join(directory, name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
          try { await unlink(path); } catch { await rm(path, { force: true }); }
        } else if (info.isDirectory()) pending.push(path);
      }
    }
  }

  private async verifyWorktree(worktree: string, baseCommit: string): Promise<void> {
    await this.assertRealDirectory(worktree);
    const top = await gitOk(this.git, ["rev-parse", "--show-toplevel", "HEAD"], { cwd: worktree }, "inspect the lease worktree");
    const [toplevel, head] = top.split(/\r?\n/u);
    if (!toplevel || comparablePath(toplevel) !== comparablePath(worktree) || head !== baseCommit)
      failWith("SecurityViolation", "The created lease worktree does not match the expected location or commit.");
  }

  private async createRecord(path: string, record: LeaseRecord): Promise<void> {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
  }

  private async readRecord(path: string, leaseId: string): Promise<LeaseRecord> {
    let bytes: Buffer;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
      bytes = await readBoundedFile(path, 64 * 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") failWith("WorkspaceConflict", "Unknown workspace lease.");
      failWith("WorkspaceConflict", "The workspace lease record is unreadable.", false, error);
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
    catch { failWith("WorkspaceConflict", "The workspace lease record is corrupt."); }
    if (!isRecord(value) || value.schemaVersion !== 1 || value.leaseId !== leaseId ||
        typeof value.ownerId !== "string" || !OWNER_ID.test(value.ownerId) ||
        !["creating", "active", "releasing", "released"].includes(String(value.state)) ||
        typeof value.baseCommit !== "string" || !COMMIT.test(value.baseCommit) ||
        value.worktree !== `.fusion/worktrees/${leaseId}` || !Number.isSafeInteger(value.ownerPid) ||
        (value.ownerPid as number) < 0 || Object.keys(value).length !== 9)
      failWith("WorkspaceConflict", "The workspace lease record is corrupt.");
    try { safeTimestamp(value.createdAt, "lease creation time"); safeTimestamp(value.updatedAt, "lease update time"); }
    catch { failWith("WorkspaceConflict", "The workspace lease record is corrupt."); }
    return value as unknown as LeaseRecord;
  }
}
