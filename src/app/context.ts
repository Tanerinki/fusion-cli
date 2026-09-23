import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FusionFailure } from "../core/errors.js";
import { EventStore } from "../platform/events/event-store.js";
import { RunStore } from "../platform/events/run-store.js";
import { readBoundedFile } from "../platform/fs/bounded-read.js";
import { comparablePath, parseWorktreeList, ProcessGitClient, type GitClient } from "../platform/workspace/git.js";

/**
 * Read-only discovery for doctor, audit and run setup. Nothing here writes: no `.fusion` directory is created, Git
 * runs with optional locks off, and run storage is only read through the validating stores.
 */
export interface RepositoryState {
  readonly detected: boolean;
  readonly root?: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly unborn: boolean;
  readonly detached: boolean;
  readonly changes: Readonly<{ staged: number; unstaged: number; untracked: number; conflicted: number }>;
}
export interface RuntimeContext {
  readonly platform: string;
  readonly nodeVersion: string;
  readonly git: Readonly<{ available: boolean; client?: GitClient }>;
  readonly repository: RepositoryState;
}
const NO_REPOSITORY: RepositoryState = { detected: false, head: null, branch: null, unborn: false, detached: false,
  changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } };

export async function discoverRuntime(cwd: string, env: NodeJS.ProcessEnv, git?: GitClient): Promise<RuntimeContext> {
  let client = git;
  if (client === undefined) { try { client = await ProcessGitClient.fromPath(env); } catch { client = undefined; } }
  const base = { platform: process.platform, nodeVersion: process.version };
  if (client === undefined) return { ...base, git: { available: false }, repository: NO_REPOSITORY };
  return { ...base, git: { available: true, client }, repository: await discoverRepository(client, cwd) };
}

async function discoverRepository(git: GitClient, cwd: string): Promise<RepositoryState> {
  let top;
  try { top = await git.run(["rev-parse", "--is-bare-repository", "--show-toplevel"], { cwd: resolve(cwd) }); }
  catch { return NO_REPOSITORY; }
  const [bare, root] = top.stdout.split(/\r?\n/u);
  if (top.exitCode !== 0 || bare !== "false" || !root) return NO_REPOSITORY;
  const options = { cwd: resolve(root) };
  const head = await git.run(["rev-parse", "--verify", "--quiet", "HEAD"], options);
  const ref = await git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], options);
  // A status beyond Git's output bound leaves the counts at zero rather than failing discovery.
  const status = await git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], options)
    .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  const changes = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  if (status.exitCode === 0) for (const field of status.stdout.split("\0")) {
    if (field.length < 3) continue;
    const x = field[0], y = field[1];
    if (x === "?" && y === "?") changes.untracked++;
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) changes.conflicted++;
    else { if (x !== " ") changes.staged++; if (y !== " ") changes.unstaged++; }
  }
  return { detected: true, root: resolve(root), head: head.exitCode === 0 ? head.stdout.trim() : null,
    branch: ref.exitCode === 0 ? ref.stdout.trim() : null, unborn: head.exitCode !== 0, detached: ref.exitCode !== 0 && head.exitCode === 0,
    changes };
}

export type StorageState = "absent" | "healthy" | "degraded" | "unsafe";
export interface StorageHealth {
  readonly state: StorageState;
  readonly runs: number;
  readonly checkedRuns: number;
  readonly corruptRuns: number;
  readonly truncatedLogs: number;
  readonly notes: readonly string[];
}
const MAX_CHECKED_RUNS = 25;
const RUN_ID = /^r-[0-9a-z]{10}-[0-9a-f]{32}$/u;

/** EventStore/ArtifactStore health without writing: `.fusion` must be a real directory; recent runs must validate. */
export async function inspectStorage(root: string): Promise<StorageHealth> {
  const fusion = join(root, ".fusion");
  const kind = async (path: string): Promise<"absent" | "dir" | "unsafe"> => {
    try { const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink() ? "dir" : "unsafe"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unsafe"; }
  };
  const top = await kind(fusion);
  if (top === "absent") return { state: "absent", runs: 0, checkedRuns: 0, corruptRuns: 0, truncatedLogs: 0,
    notes: ["Fusion storage is created on the first review or build run."] };
  if (top === "unsafe") return { state: "unsafe", runs: 0, checkedRuns: 0, corruptRuns: 0, truncatedLogs: 0,
    notes: [".fusion is not a real directory (link, junction or file)."] };
  const notes: string[] = [];
  const runsKind = await kind(join(fusion, "runs"));
  if (runsKind === "unsafe") return { state: "unsafe", runs: 0, checkedRuns: 0, corruptRuns: 0, truncatedLogs: 0,
    notes: [".fusion/runs is not a real directory."] };
  const ids = runsKind === "absent" ? [] : (await readdir(join(fusion, "runs"))).filter(name => RUN_ID.test(name)).sort();
  let corrupt = 0, truncated = 0;
  const checked = ids.slice(-MAX_CHECKED_RUNS);
  for (const runId of checked) {
    try {
      const run = await RunStore.open(root, runId);
      for await (const item of EventStore.read(run.directory, runId)) if ("diagnostic" in item) truncated++;
    } catch { corrupt++; }
  }
  if (corrupt > 0) notes.push(`${corrupt} recent run(s) have an invalid manifest or event log.`);
  if (truncated > 0) notes.push(`${truncated} recent run log(s) end in a truncated line.`);
  return { state: corrupt > 0 || truncated > 0 ? "degraded" : "healthy", runs: ids.length, checkedRuns: checked.length,
    corruptRuns: corrupt, truncatedLogs: truncated, notes };
}

export interface LeaseHealth {
  readonly state: "none" | "healthy" | "attention" | "unsafe";
  readonly records: number;
  readonly active: number;
  readonly deadOwners: number;
  readonly corrupt: number;
  readonly fusionWorktrees: number;
  readonly prunableWorktrees: number;
}
const LEASE_FILE = /^l-[0-9a-z]{10}-[0-9a-f]{32}\.json$/u;
/** Lease registry and worktree state, read without opening a lease manager (which would create directories). */
export async function inspectLeases(root: string, git: GitClient, processAlive: (pid: number) => boolean = defaultAlive): Promise<LeaseHealth> {
  const dir = join(root, ".fusion", "leases");
  let names: string[] = [];
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return { state: "unsafe", records: 0, active: 0, deadOwners: 0, corrupt: 0,
      fusionWorktrees: 0, prunableWorktrees: 0 };
    names = (await readdir(dir)).filter(name => LEASE_FILE.test(name));
  } catch { names = []; }
  let active = 0, dead = 0, corrupt = 0;
  for (const name of names) {
    try {
      const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedFile(join(dir, name), 64 * 1024))) as
        { state?: unknown; ownerPid?: unknown };
      if (record.state === "active" || record.state === "creating" || record.state === "releasing") {
        active++;
        if (Number.isSafeInteger(record.ownerPid) && !processAlive(record.ownerPid as number)) dead++;
      }
    } catch { corrupt++; }
  }
  const listed = await git.run(["worktree", "list", "--porcelain", "-z"], { cwd: root });
  const worktrees = listed.exitCode === 0 ? parseWorktreeList(listed.stdout) : [];
  const leaseRoot = comparablePath(join(root, ".fusion", "worktrees"));
  const fusionWorktrees = worktrees.filter(entry => comparablePath(entry.path).startsWith(`${leaseRoot}${process.platform === "win32" ? "\\" : "/"}`));
  const prunable = worktrees.filter(entry => entry.prunable).length;
  return { state: names.length === 0 && fusionWorktrees.length === 0 ? "none" : corrupt > 0 || dead > 0 || prunable > 0 ? "attention" : "healthy",
    records: names.length, active, deadOwners: dead, corrupt, fusionWorktrees: fusionWorktrees.length, prunableWorktrees: prunable };
}
function defaultAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Requires a Git working tree; the typed failure carries an actionable message. */
export function requireRepository(context: RuntimeContext): Readonly<{ root: string; git: GitClient }> {
  if (!context.git.available || context.git.client === undefined)
    throw new FusionFailure({ kind: "CapabilityUnavailable", retryable: false, safeMessage: "Git is not available on PATH." });
  if (!context.repository.detected || context.repository.root === undefined)
    throw new FusionFailure({ kind: "InvalidInput", retryable: false,
      safeMessage: "Not inside a Git working tree. Run Fusion from a repository (or pass --cwd)." });
  return { root: context.repository.root, git: context.git.client };
}
