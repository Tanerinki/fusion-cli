import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ChangeScope, VerificationPlan } from "../../core/domain.js";
import { canonicalChangePath, validateChangeSet } from "../../core/change/contract.js";
import { failWith } from "../../core/errors.js";
import { removeOwnedTemporary } from "../fs/temporary.js";
import { VerificationEngine, type VerificationReport } from "../verification/engine.js";
import { captureControlledTree, compareControlledTrees, type ControlledTreeSnapshot } from "../verification/controlled-tree.js";
import { comparablePath, gitOk, ProcessGitClient, type GitClient } from "./git.js";
import { captureSnapshot, compareSnapshots, type WorkspaceSnapshot } from "./snapshot.js";
import { applyCandidateChanges, type MutationLedgerEntry } from "./change-applier.js";

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PRIVATE_PREFIX = "fusion-writer-private-";
const VERIFY_PREFIX = "fusion-verification-";
const MAX_CANDIDATE_FILES = 20_000;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
function safeCandidatePath(path: string): string {
  return canonicalChangePath(path);
}
function fields(stdout: string): string[] { return stdout.split("\0").filter(Boolean); }
function sameGitControl(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  return a.head === b.head && a.headRef === b.headRef && a.indexDigest === b.indexDigest &&
    JSON.stringify(a.gitState) === JSON.stringify(b.gitState);
}
async function privateGit(git: GitClient, snapshot: WorkspaceSnapshot, root: string, commit: string): Promise<void> {
  const top = await gitOk(git, ["rev-parse", "--show-toplevel", "HEAD"], { cwd: root }, "read back the private workspace");
  const [topPath, head] = top.trim().split(/\r?\n/u);
  if (!snapshot.complete || comparablePath(snapshot.gitState.gitDir) !== comparablePath(join(root, ".git")) ||
      comparablePath(snapshot.gitState.commonDir) !== comparablePath(snapshot.gitState.gitDir) ||
      comparablePath(topPath ?? "") !== comparablePath(root) || head !== commit)
    failWith("SecurityViolation", "The reconstructed repository has shared or incomplete Git state.");
}
async function cleanPrivateRoot(path: string, prefix: string): Promise<void> {
  const root = resolve(tmpdir());
  if (dirname(resolve(path)) !== root || !basename(path).startsWith(prefix) ||
      !resolve(path).toLowerCase().startsWith(`${root.toLowerCase()}${sep}`))
    failWith("SecurityViolation", "Fusion temporary cleanup target is outside its owned root.");
  let info;
  try { info = await lstat(path); }
  catch (error) { failWith("WorkspaceConflict", "Fusion temporary cleanup root is missing or unreadable.", false, error); }
  if (!info.isDirectory() || info.isSymbolicLink()) failWith("SecurityViolation", "Fusion temporary root is not a real directory.");
  const pending = [path];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const name of await readdir(directory)) {
      if (++visited > 500_000) failWith("WorkspaceConflict", "Fusion temporary cleanup exceeds its entry limit.");
      const child = join(directory, name), childInfo = await lstat(child);
      if (childInfo.isSymbolicLink()) {
        try { await unlink(child); } catch { await rm(child, { force: true }); }
      } else if (childInfo.isDirectory()) pending.push(child);
    }
  }
  await removeOwnedTemporary(path);
}
async function cloneAt(git: GitClient, primary: string, destination: string, commit: string,
  signal?: AbortSignal): Promise<void> {
  const option = signal ? { signal } : {};
  await gitOk(git, ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--no-tags", "--single-branch",
    "--", primary, destination], { cwd: dirname(destination), ...option }, "create a private repository");
  await gitOk(git, ["config", "--local", "core.autocrlf", "false"], { cwd: destination, ...option },
    "pin private checkout line endings");
  await gitOk(git, ["checkout", "--detach", commit], { cwd: destination, ...option }, "check out the pinned baseline");
  await gitOk(git, ["remote", "remove", "origin"], { cwd: destination, ...option }, "remove the private repository's push remote");
}

/**
 * Offline substrate for a future Writer adapter. The real-provider gate remains closed: this class does not grant
 * an OS sandbox or provider write posture. Neither candidate nor verifier has a linked common Git directory.
 */
export class PrivateWriterWorkspace {
  readonly #baseline: WorkspaceSnapshot;
  readonly #candidateBaseline: WorkspaceSnapshot;
  readonly #candidateTreeBaseline: ControlledTreeSnapshot;
  #closed = false;
  #busy = false;
  #changeApplication: "unused" | "complete" | "incomplete" = "unused";
  #appliedPaths: readonly string[] = [];
  #appliedTree?: ControlledTreeSnapshot;
  private constructor(readonly primaryRoot: string, readonly ownerId: string, readonly path: string,
    readonly baseCommit: string, private readonly temporaryRoot: string, private readonly git: ProcessGitClient,
    private readonly verificationPlan: VerificationPlan, baseline: WorkspaceSnapshot, candidateBaseline: WorkspaceSnapshot,
    candidateTreeBaseline: ControlledTreeSnapshot) {
    this.#baseline = baseline;
    this.#candidateBaseline = candidateBaseline;
    this.#candidateTreeBaseline = candidateTreeBaseline;
  }

  static async open(primaryRoot: string, ownerId: string, git: ProcessGitClient, verificationPlan: VerificationPlan,
    signal?: AbortSignal): Promise<PrivateWriterWorkspace> {
    if (!(git instanceof ProcessGitClient) || !git.isolatedConfig)
      failWith("SecurityViolation", "Private Writer requires a Git client without ambient user or system configuration.");
    if (!Array.isArray(verificationPlan?.commands) || verificationPlan.commands.length === 0 ||
        verificationPlan.commands.some(command => !command || typeof command !== "object" ||
          command.mutationPolicy !== "readOnly" || !Array.isArray(command.args)))
      failWith("InvalidInput", "Private Writer requires a host-configured read-only verification plan.");
    const fixedPlan: VerificationPlan = Object.freeze({ commands: Object.freeze(verificationPlan.commands.map(command =>
      Object.freeze({ ...command, args: Object.freeze([...command.args]) }))) });
    if (!OWNER.test(ownerId) || !isAbsolute(primaryRoot)) failWith("InvalidInput", "Private Writer needs an owner and absolute repository root.");
    const primary = await realpath(resolve(primaryRoot));
    const top = await gitOk(git, ["rev-parse", "--show-toplevel", "HEAD"], { cwd: primary }, "inspect the primary baseline");
    const [topPath, baseCommit] = top.trim().split(/\r?\n/u);
    if (!topPath || comparablePath(topPath) !== comparablePath(primary) || !baseCommit || !COMMIT.test(baseCommit))
      failWith("WorkspaceConflict", "Private Writer requires a committed primary repository top level.");
    const baseline = await captureSnapshot(git, primary, signal);
    if (!baseline.complete) failWith("SecurityViolation", "Primary Git state could not be completely fingerprinted.");
    const temporaryRoot = await mkdtemp(join(tmpdir(), PRIVATE_PREFIX));
    const path = join(temporaryRoot, "candidate");
    try {
      await writeFile(join(temporaryRoot, ".fusion-owner"), JSON.stringify({ schemaVersion: 1, ownerPid: process.pid,
        ownerId, primary, baseCommit }) + "\n", { flag: "wx", mode: 0o600 });
      await cloneAt(git, primary, path, baseCommit, signal);
      const candidateBaseline = await captureSnapshot(git, path);
      await privateGit(git, candidateBaseline, path, baseCommit);
      const tree = await captureControlledTree(path);
      if (!tree.complete) failWith("SecurityViolation", "Private candidate baseline contains unsafe or unbounded files.");
      const after = await captureSnapshot(git, primary, signal);
      const comparison = compareSnapshots(baseline, after);
      if (comparison.mutated || !comparison.complete)
        failWith("SecurityViolation", "Primary repository state changed while creating the private Writer workspace.");
      return new PrivateWriterWorkspace(primary, ownerId, path, baseCommit, temporaryRoot, git,
        fixedPlan, baseline, candidateBaseline, tree);
    } catch (error) {
      try { await cleanPrivateRoot(temporaryRoot, PRIVATE_PREFIX); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Private Writer creation and cleanup both failed."); }
      throw error;
    }
  }

  private assertOwner(ownerId: string): void {
    if (this.#closed || this.#busy || ownerId !== this.ownerId)
      failWith("WorkspaceConflict", "The private Writer workspace is closed, busy or owned by another Writer.");
  }
  private async assertPrimaryUnchanged(): Promise<void> {
    const current = await captureSnapshot(this.git, this.primaryRoot);
    const comparison = compareSnapshots(this.#baseline, current);
    if (comparison.mutated || !comparison.complete)
      failWith("SecurityViolation", "The primary repository changed during the private Writer run.");
  }
  private async changedPaths(): Promise<string[]> {
    const current = await captureSnapshot(this.git, this.path);
    await privateGit(this.git, current, this.path, this.baseCommit);
    if (!sameGitControl(this.#candidateBaseline, current))
      failWith("SecurityViolation", "Writer changed private Git metadata, refs, config or index state.");
    const tracked = await gitOk(this.git, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
      "HEAD", "--"], { cwd: this.path }, "list the candidate's tracked changes");
    const untracked = await gitOk(this.git, ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: this.path }, "list the candidate's untracked files");
    const names = [...new Set([...fields(tracked), ...fields(untracked)])].sort();
    if (names.length > MAX_CANDIDATE_FILES) failWith("SecurityViolation", "Candidate has too many changed paths.");
    if (process.platform === "win32" && new Set(names.map(name => name.toLowerCase())).size !== names.length)
      failWith("SecurityViolation", "Candidate has paths that collide on Windows.");
    return names.map(safeCandidatePath);
  }

  /** Only Fusion applies untrusted proposals, after validation and primary-state checks. One proposal per candidate. */
  async applyChangeSet(ownerId: string, output: unknown, scope: ChangeScope): Promise<readonly MutationLedgerEntry[]> {
    this.assertOwner(ownerId);
    if (this.#changeApplication !== "unused")
      failWith("WorkspaceConflict", "Candidate already received a ChangeSet or a failed application.");
    const changes = validateChangeSet(output, scope);
    this.#busy = true;
    this.#changeApplication = "incomplete";
    try {
      await this.assertPrimaryUnchanged();
      const pristineTree = await captureControlledTree(this.path);
      if ((await this.changedPaths()).length !== 0 || !pristineTree.complete ||
          compareControlledTrees(this.#candidateTreeBaseline, pristineTree).length !== 0)
        failWith("SecurityViolation", "Host application requires a pristine private candidate.");
      const ledger = await applyCandidateChanges(this.path, this.temporaryRoot, changes);
      const actual = await this.changedPaths();
      const approved = changes.operations.map(op => op.path).sort();
      const appliedTree = await captureControlledTree(this.path);
      const treeChanges = compareControlledTrees(this.#candidateTreeBaseline, appliedTree);
      if (JSON.stringify(actual) !== JSON.stringify(approved) || !appliedTree.complete ||
          treeChanges.some(path => !approved.includes(path) && !approved.some(file => file.startsWith(`${path}/`) &&
            appliedTree.digests[path] === "directory")))
        failWith("SecurityViolation", "Applied candidate differs from the approved ChangeSet.");
      await this.assertPrimaryUnchanged();
      this.#appliedPaths = Object.freeze(approved);
      this.#appliedTree = appliedTree;
      this.#changeApplication = "complete";
      return ledger;
    } finally { this.#busy = false; }
  }

  /** Only paths explicitly approved by the caller cross from the candidate to a fresh baseline clone. */
  async verify(ownerId: string, approvedPaths: readonly string[],
    engine = new VerificationEngine(), sourceEnv: NodeJS.ProcessEnv = process.env,
    signal?: AbortSignal): Promise<VerificationReport> {
    this.assertOwner(ownerId);
    if (this.#changeApplication === "incomplete")
      failWith("WorkspaceConflict", "An incomplete host ChangeSet cannot be verified.");
    if (!Array.isArray(approvedPaths)) failWith("InvalidInput", "Private Writer verification requires approved paths.");
    const approved = [...new Set(approvedPaths.map(safeCandidatePath))].sort();
    if (this.#changeApplication === "complete" && JSON.stringify(approved) !== JSON.stringify(this.#appliedPaths))
      failWith("SecurityViolation", "Verification paths differ from the host-applied ChangeSet.");
    if (approved.length !== approvedPaths.length || (process.platform === "win32" &&
        new Set(approved.map(path => path.toLowerCase())).size !== approved.length))
      failWith("InvalidInput", "Approved candidate paths must be unique.");
    this.#busy = true;
    let verificationRoot: string | undefined;
    let primaryError: unknown;
    try {
      await this.assertPrimaryUnchanged();
      const changed = await this.changedPaths();
      if (JSON.stringify(changed) !== JSON.stringify(approved))
        failWith("SecurityViolation", "Approved candidate paths do not exactly match the Writer change set.");
      const candidateBefore = await captureControlledTree(this.path);
      if (!candidateBefore.complete) failWith("SecurityViolation", "Candidate tree is unsafe or unbounded.");
      if (this.#appliedTree && compareControlledTrees(this.#appliedTree, candidateBefore).length !== 0)
        failWith("SecurityViolation", "Host-applied candidate changed before verification.");
      verificationRoot = await mkdtemp(join(tmpdir(), VERIFY_PREFIX));
      const verificationPath = join(verificationRoot, "repository");
      await cloneAt(this.git, this.primaryRoot, verificationPath, this.baseCommit, signal);
      await privateGit(this.git, await captureSnapshot(this.git, verificationPath), verificationPath, this.baseCommit);
      if (!(await captureControlledTree(verificationPath)).complete)
        failWith("SecurityViolation", "Verification baseline is unsafe or unbounded.");
      let copiedBytes = 0;
      for (const name of changed) {
        const source = join(this.path, name), target = join(verificationPath, name);
        let info;
        try { info = await lstat(source); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await rm(target, { force: true });
          continue;
        }
        if (!info.isFile() || info.isSymbolicLink()) failWith("SecurityViolation", "Candidate output is not a regular file.");
        copiedBytes += info.size;
        if (copiedBytes > MAX_CANDIDATE_BYTES) failWith("SecurityViolation", "Candidate output exceeds the byte limit.");
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
      }
      const candidateAfter = await captureControlledTree(this.path);
      if (!candidateAfter.complete || compareControlledTrees(candidateBefore, candidateAfter).length > 0)
        failWith("SecurityViolation", "Candidate changed while verification inputs were reconstructed.");
      const env: NodeJS.ProcessEnv = { PATH: sourceEnv.PATH, Path: sourceEnv.Path, PATHEXT: sourceEnv.PATHEXT,
        SystemRoot: sourceEnv.SystemRoot, WINDIR: sourceEnv.WINDIR, TEMP: verificationRoot, TMP: verificationRoot,
        HOME: verificationRoot, USERPROFILE: verificationRoot, APPDATA: verificationRoot, XDG_CONFIG_HOME: verificationRoot,
        GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
      const report = await engine.run(this.verificationPlan, { workspaceRoot: verificationPath, git: this.git,
        env, controlledTree: true,
        ...(signal ? { signal } : {}) });
      await this.assertPrimaryUnchanged();
      return report;
    } catch (error) { primaryError = error; throw error; }
    finally {
      try {
        if (verificationRoot !== undefined) {
          try { await cleanPrivateRoot(verificationRoot, VERIFY_PREFIX); }
          catch (cleanupError) {
            if (primaryError !== undefined)
              throw new AggregateError([primaryError, cleanupError], "Verification and cleanup both failed.");
            failWith("WorkspaceConflict", "Private verification cleanup failed.", false, cleanupError);
          }
        }
      } finally { this.#busy = false; }
    }
  }

  async close(ownerId: string, options: Readonly<{ discardChanges?: boolean }> = {}): Promise<void> {
    this.assertOwner(ownerId);
    this.#busy = true;
    try {
      if (options.discardChanges !== true && (await this.changedPaths()).length > 0)
        failWith("WorkspaceConflict", "Private Writer candidate holds changes; explicit discard is required.");
      await cleanPrivateRoot(this.temporaryRoot, PRIVATE_PREFIX);
      this.#closed = true;
    } finally { this.#busy = false; }
  }

  /** Detection only; stale directories are never removed by a scan. */
  static async findStale(): Promise<readonly string[]> {
    const stale: string[] = [];
    for (const name of await readdir(tmpdir())) {
      if (!name.startsWith(PRIVATE_PREFIX)) continue;
      const root = join(tmpdir(), name);
      try {
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const markerPath = join(root, ".fusion-owner");
        if ((await lstat(markerPath)).size > 4096) { stale.push(root); continue; }
        const marker = JSON.parse(await readFile(markerPath, "utf8")) as { ownerPid?: number };
        if (!Number.isSafeInteger(marker.ownerPid) || !marker.ownerPid) { stale.push(root); continue; }
        try { process.kill(marker.ownerPid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") stale.push(root); }
      } catch { stale.push(root); }
    }
    return stale.sort();
  }
}
