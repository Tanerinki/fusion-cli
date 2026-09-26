import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { BaselineFileHash, ChangeScope, VerificationPlan } from "../../core/domain.js";
import { canonicalChangePath, validateChangeSet } from "../../core/change/contract.js";
import { failWith } from "../../core/errors.js";
import { fusionTemporaryBase, removeOwnedTemporary } from "../fs/temporary.js";
import { VerificationEngine, type VerificationReport } from "../verification/engine.js";
import { captureControlledTree, compareControlledTrees, type ControlledTreeSnapshot } from "../verification/controlled-tree.js";
import { buildVerifierEnvironment } from "../verification/verifier-environment.js";
import { assessPlatformRequirement, detectPlatformSignals, type PlatformAssessment } from "../../core/policy/platform.js";
import { readBoundedFile } from "../fs/bounded-read.js";
import { parseStrictJson } from "../process/strict-json.js";
import { DEPENDENCY_CONTROL_FILES, sha256Hex, type DependencyRequirement } from "../verification/dependency-policy.js";
import type { VerificationService, VerificationServiceResult } from "../verification/selection.js";
import { comparablePath, gitOk, ProcessGitClient, type GitClient } from "./git.js";
import { captureSnapshot, compareSnapshots, observeWorkspace, type WorkspaceObservation, type WorkspaceSnapshot } from "./snapshot.js";
import { applyCandidateChanges, mismatchedPreconditions, observedPreconditions, type MutationLedgerEntry } from "./change-applier.js";
import { observeChange } from "./change.js";

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PRIVATE_PREFIX = "fusion-writer-private-";
const VERIFY_PREFIX = "fusion-verification-";
const MAX_CANDIDATE_FILES = 20_000;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
function safeCandidatePath(path: string): string {
  return canonicalChangePath(path);
}
function sameGitControl(a: WorkspaceSnapshot, b: WorkspaceSnapshot): boolean {
  return a.head === b.head && a.headRef === b.headRef && a.indexDigest === b.indexDigest &&
    JSON.stringify(a.gitState) === JSON.stringify(b.gitState);
}
/** The observed repository is a private, unshared clone whose top level is `root` and whose HEAD is `commit`. */
function privateGit(observation: WorkspaceObservation, root: string, commit: string): void {
  const { snapshot, topLevel } = observation;
  if (!snapshot.complete || comparablePath(snapshot.gitState.gitDir) !== comparablePath(join(root, ".git")) ||
      comparablePath(snapshot.gitState.commonDir) !== comparablePath(snapshot.gitState.gitDir) ||
      comparablePath(topLevel) !== comparablePath(root) || snapshot.head !== commit)
    failWith("SecurityViolation", "The reconstructed repository has shared or incomplete Git state.");
}
export async function cleanPrivateRoot(path: string, prefix: string): Promise<void> {
  const root = fusionTemporaryBase();
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
/**
 * A remote-less private clone of `commit` (no local hardlinks, no shared object store). A clone whose `.git` is deleted
 * right after checkout (a provider view) passes `removeRemote: false`: there is no repository left to hold a remote.
 */
export async function cloneAt(git: GitClient, primary: string, destination: string, commit: string,
  signal?: AbortSignal, removeRemote = true): Promise<void> {
  const option = signal ? { signal } : {};
  await gitOk(git, ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--no-tags", "--single-branch",
    "--", primary, destination], { cwd: dirname(destination), ...option }, "create a private repository");
  await gitOk(git, ["config", "--local", "core.autocrlf", "false"], { cwd: destination, ...option },
    "pin private checkout line endings");
  await gitOk(git, ["checkout", "--detach", commit], { cwd: destination, ...option }, "check out the pinned baseline");
  if (removeRemote)
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
    private readonly verificationPlan: VerificationPlan | undefined, baseline: WorkspaceSnapshot, candidateBaseline: WorkspaceSnapshot,
    candidateTreeBaseline: ControlledTreeSnapshot) {
    this.#baseline = baseline;
    this.#candidateBaseline = candidateBaseline;
    this.#candidateTreeBaseline = candidateTreeBaseline;
  }

  /**
   * `verificationPlan` is the host-configured plan for the TRUSTED-HOST `verify` only; a candidate that is verified in
   * confinement (`verifyConfined`, which takes its own plan) passes `undefined`, and its trusted-host `verify` refuses.
   */
  static async open(primaryRoot: string, ownerId: string, git: ProcessGitClient, verificationPlan: VerificationPlan | undefined,
    signal?: AbortSignal): Promise<PrivateWriterWorkspace> {
    if (!(git instanceof ProcessGitClient) || !git.isolatedConfig)
      failWith("SecurityViolation", "Private Writer requires a Git client without ambient user or system configuration.");
    if (verificationPlan !== undefined && (!Array.isArray(verificationPlan?.commands) || verificationPlan.commands.length === 0 ||
        verificationPlan.commands.some(command => !command || typeof command !== "object" ||
          command.mutationPolicy !== "readOnly" || !Array.isArray(command.args))))
      failWith("InvalidInput", "Private Writer requires a host-configured read-only verification plan.");
    const fixedPlan: VerificationPlan | undefined = verificationPlan === undefined ? undefined
      : Object.freeze({ commands: Object.freeze(verificationPlan.commands.map(command =>
        Object.freeze({ ...command, args: Object.freeze([...command.args]) }))) });
    if (!OWNER.test(ownerId) || !isAbsolute(primaryRoot)) failWith("InvalidInput", "Private Writer needs an owner and absolute repository root.");
    const primary = await realpath(resolve(primaryRoot));
    // One observation yields the top level, the committed HEAD and the primary's baseline fingerprint.
    const observed = await observeWorkspace(git, primary, signal ? { signal } : {});
    const baseline = observed.snapshot, baseCommit = baseline.head;
    if (comparablePath(observed.topLevel) !== comparablePath(primary) || baseCommit === null || !COMMIT.test(baseCommit))
      failWith("WorkspaceConflict", "Private Writer requires a committed primary repository top level.");
    if (!baseline.complete) failWith("SecurityViolation", "Primary Git state could not be completely fingerprinted.");
    const temporaryRoot = await mkdtemp(join(fusionTemporaryBase(), PRIVATE_PREFIX));
    const path = join(temporaryRoot, "candidate");
    try {
      await writeFile(join(temporaryRoot, ".fusion-owner"), JSON.stringify({ schemaVersion: 1, ownerPid: process.pid,
        ownerId, primary, baseCommit }) + "\n", { flag: "wx", mode: 0o600 });
      await cloneAt(git, primary, path, baseCommit, signal);
      const candidateObservation = await observeWorkspace(git, path);
      const candidateBaseline = candidateObservation.snapshot;
      privateGit(candidateObservation, path, baseCommit);
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
  /**
   * Tracked and untracked paths changed relative to the baseline commit, from the same status observation that proves
   * the private Git state: the index is proven identical to the checkout's (which equals HEAD), so status's tracked
   * entries are exactly `git diff HEAD`'s and its untracked entries exactly `ls-files --others --exclude-standard`.
   */
  private async changedPaths(): Promise<string[]> {
    const observation = await observeWorkspace(this.git, this.path);
    const current = observation.snapshot;
    privateGit(observation, this.path, this.baseCommit);
    if (!sameGitControl(this.#candidateBaseline, current))
      failWith("SecurityViolation", "Writer changed private Git metadata, refs, config or index state.");
    const names = [...new Set(current.entries.map(entry => entry.path))].sort();
    if (names.length > MAX_CANDIDATE_FILES) failWith("SecurityViolation", "Candidate has too many changed paths.");
    if (process.platform === "win32" && new Set(names.map(name => name.toLowerCase())).size !== names.length)
      failWith("SecurityViolation", "Candidate has paths that collide on Windows.");
    return names.map(safeCandidatePath);
  }

  /** Paths the candidate changed relative to its baseline (untracked included), after checking its private Git state. */
  async observedChanges(ownerId: string): Promise<readonly string[]> {
    this.assertOwner(ownerId);
    return Object.freeze(await this.changedPaths());
  }

  /**
   * Content fingerprint of the candidate: its Git control state plus every file, ignored and untracked included. An
   * incomplete fingerprint fails closed.
   */
  async fingerprint(ownerId: string): Promise<string> {
    this.assertOwner(ownerId);
    const snapshot = await captureSnapshot(this.git, this.path);
    const tree = await captureControlledTree(this.path);
    if (!snapshot.complete || !tree.complete) failWith("SecurityViolation", "The candidate cannot be completely fingerprinted.");
    return sha256Hex(Buffer.from(JSON.stringify({ snapshot, tree: tree.digests }), "utf8"));
  }

  /**
   * The candidate's controlled tree (every file except `.git`) exactly as Fusion expects it — the host-applied tree once
   * a ChangeSet was applied, the pristine checkout before — after proving the files on disk still match it. A provider
   * view of the candidate is a copy verified against this tree.
   */
  async expectedTree(ownerId: string): Promise<ControlledTreeSnapshot> {
    this.assertOwner(ownerId);
    if (this.#changeApplication === "incomplete") failWith("WorkspaceConflict", "An incomplete host ChangeSet has no expected tree.");
    const expected = this.#appliedTree ?? this.#candidateTreeBaseline;
    const current = await captureControlledTree(this.path);
    if (!current.complete || compareControlledTrees(expected, current).length !== 0)
      failWith("SecurityViolation", "The candidate differs from the tree Fusion applied.");
    return expected;
  }

  /** Bounded review diff of the candidate against its baseline commit, untracked files included. Never writes. */
  async diff(ownerId: string, signal?: AbortSignal): Promise<Readonly<{ changedPaths: readonly string[]; text: string; truncated: boolean }>> {
    this.assertOwner(ownerId);
    return observeChange(this.git, this.path, this.baseCommit, signal);
  }

  /**
   * The current SHA-256 of each given file in this still pristine candidate (`null`: absent): the preconditions a
   * read-only Change Author is handed. Nothing is mutated.
   */
  async baselineHashes(ownerId: string, paths: readonly string[]): Promise<readonly BaselineFileHash[]> {
    this.assertOwner(ownerId);
    if (this.#changeApplication !== "unused")
      failWith("WorkspaceConflict", "Candidate already received a ChangeSet or a failed application.");
    return observedPreconditions(this.path, this.temporaryRoot, paths);
  }

  /**
   * The validated ChangeSet's operations whose SHA-256 precondition does not hold in this pristine candidate. Nothing
   * is mutated: a stale proposal is refused before host application, never partially applied.
   */
  async preconditionMismatches(ownerId: string, output: unknown, scope: ChangeScope): Promise<readonly string[]> {
    this.assertOwner(ownerId);
    if (this.#changeApplication !== "unused")
      failWith("WorkspaceConflict", "Candidate already received a ChangeSet or a failed application.");
    return mismatchedPreconditions(this.path, this.temporaryRoot, validateChangeSet(output, scope));
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

  private approvedPaths(approvedPaths: readonly string[]): string[] {
    if (this.#changeApplication === "incomplete")
      failWith("WorkspaceConflict", "An incomplete host ChangeSet cannot be verified.");
    if (!Array.isArray(approvedPaths)) failWith("InvalidInput", "Private Writer verification requires approved paths.");
    const approved = [...new Set(approvedPaths.map(safeCandidatePath))].sort();
    if (this.#changeApplication === "complete" && JSON.stringify(approved) !== JSON.stringify(this.#appliedPaths))
      failWith("SecurityViolation", "Verification paths differ from the host-applied ChangeSet.");
    if (approved.length !== approvedPaths.length || (process.platform === "win32" &&
        new Set(approved.map(path => path.toLowerCase())).size !== approved.length))
      failWith("InvalidInput", "Approved candidate paths must be unique.");
    return approved;
  }

  /**
   * Rebuilds a fresh baseline clone and copies ONLY the approved candidate files into it. `atBaseline` runs on the
   * clone before any candidate file lands (e.g. to read the committed dependency manifests).
   */
  private async reconstruct(approved: readonly string[], verificationRoot: string, signal?: AbortSignal,
    atBaseline?: (path: string) => Promise<void>): Promise<Readonly<{ verificationPath: string; changed: readonly string[] }>> {
    await this.assertPrimaryUnchanged();
    const changed = await this.changedPaths();
    if (JSON.stringify(changed) !== JSON.stringify(approved))
      failWith("SecurityViolation", "Approved candidate paths do not exactly match the Writer change set.");
    const candidateBefore = await captureControlledTree(this.path);
    if (!candidateBefore.complete) failWith("SecurityViolation", "Candidate tree is unsafe or unbounded.");
    if (this.#appliedTree && compareControlledTrees(this.#appliedTree, candidateBefore).length !== 0)
      failWith("SecurityViolation", "Host-applied candidate changed before verification.");
    const verificationPath = join(verificationRoot, "repository");
    await cloneAt(this.git, this.primaryRoot, verificationPath, this.baseCommit, signal);
    privateGit(await observeWorkspace(this.git, verificationPath), verificationPath, this.baseCommit);
    if (!(await captureControlledTree(verificationPath)).complete)
      failWith("SecurityViolation", "Verification baseline is unsafe or unbounded.");
    await atBaseline?.(verificationPath);
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
    return { verificationPath, changed };
  }

  /**
   * TRUSTED-HOST verification for explicitly human-approved flows: the reconstructed candidate runs as native host
   * processes. It is never the autonomous Writer path — that is `verifyConfined`, which has no host fallback.
   */
  async verify(ownerId: string, approvedPaths: readonly string[],
    engine = new VerificationEngine(), sourceEnv: NodeJS.ProcessEnv = process.env,
    signal?: AbortSignal): Promise<VerificationReport> {
    this.assertOwner(ownerId);
    if (this.verificationPlan === undefined)
      failWith("InvalidInput", "This candidate has no host-configured plan; it is verified only in confinement.");
    const hostPlan = this.verificationPlan;
    const approved = this.approvedPaths(approvedPaths);
    this.#busy = true;
    let verificationRoot: string | undefined;
    let primaryError: unknown;
    try {
      verificationRoot = await mkdtemp(join(fusionTemporaryBase(), VERIFY_PREFIX));
      const { verificationPath } = await this.reconstruct(approved, verificationRoot, signal);
      const { env } = buildVerifierEnvironment(sourceEnv, verificationRoot);
      const report = await engine.run(hostPlan, { workspaceRoot: verificationPath, git: this.git,
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

  /**
   * AUTONOMOUS Writer verification. The reconstructed candidate (baseline clone + approved files only) is handed to the
   * verification service for the `autonomousWriter` purpose, which selects only an OS-confined backend whose platform
   * semantics satisfy the task and which has the needed dependency lane — never the trusted host, never a fallback.
   *
   * Platform: the host declaration (`declaredPlatform`) is escalated by deterministic signals from the changed paths,
   * their bounded text and the root package.json; a model suggestion can only escalate. Dependencies: the approved
   * identity is the COMMITTED baseline's manifests, read before any candidate file lands; a ChangeSet that touches a
   * dependency control file is refused unless the host passes an explicit `approvedDependencyIdentity` for it.
   */
  async verifyConfined(ownerId: string, approvedPaths: readonly string[], service: VerificationService,
    options: ConfinedVerificationOptions, signal?: AbortSignal): Promise<ConfinedVerificationOutcome> {
    this.assertOwner(ownerId);
    const approved = this.approvedPaths(approvedPaths);
    const plan = fixedReadOnlyPlan(options.plan);
    if (options.dependencies !== undefined && options.dependencies !== "none" && options.dependencies !== "npm-lockfile")
      failWith("InvalidInput", "Unknown dependency lane.");
    const touchesDependencies = approved.some(path => DEPENDENCY_CONTROL_FILES.includes(path.toLowerCase()));
    if (touchesDependencies && options.approvedDependencyIdentity === undefined)
      failWith("SecurityViolation", "The ChangeSet changes dependency manifests; the new dependency identity needs explicit host approval.");
    this.#busy = true;
    let verificationRoot: string | undefined;
    let primaryError: unknown;
    try {
      verificationRoot = await mkdtemp(join(fusionTemporaryBase(), VERIFY_PREFIX));
      let baseline: Readonly<{ packageJsonSha256: string; lockfileSha256: string }> | undefined;
      const { verificationPath, changed } = await this.reconstruct(approved, verificationRoot, signal, async path => {
        if (options.dependencies !== "npm-lockfile") return;
        const read = (name: string): Promise<Buffer> => readBoundedFile(join(path, name), 32 * 1024 * 1024)
          .catch(() => failWith("CapabilityUnavailable", "The committed baseline has no readable npm manifests for the dependency lane."));
        baseline = { packageJsonSha256: sha256Hex(await read("package.json")), lockfileSha256: sha256Hex(await read("package-lock.json")) };
      });
      const platform = await assessCandidatePlatform(verificationPath, changed, options.declaredPlatform, options.modelPlatformSuggestion);
      const dependencies: DependencyRequirement = options.dependencies !== "npm-lockfile" ? { kind: "none" } : {
        kind: "npm-lockfile", approved: options.approvedDependencyIdentity ?? baseline!,
        ...(options.acknowledgedInstallScripts ? { acknowledgedInstallScripts: options.acknowledgedInstallScripts } : {}) };
      const outcome = await service.verify({ purpose: "autonomousWriter", plan, workspaceRoot: verificationPath, git: this.git,
        env: {}, platformRequirement: platform.effective, dependencies, prepareDependencies: options.prepareDependencies === true,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(signal ? { signal } : {}) });
      await this.assertPrimaryUnchanged();
      return Object.freeze({ platform, verification: outcome });
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
    const base = fusionTemporaryBase();
    for (const name of await readdir(base)) {
      if (!name.startsWith(PRIVATE_PREFIX)) continue;
      const root = join(base, name);
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

export interface ConfinedVerificationOptions {
  /** Read-only commands naming executables INSIDE the confined runtime (e.g. `/usr/local/bin/node`). */
  readonly plan: VerificationPlan;
  /** The host's platform declaration (project configuration or human); absent means `unknown` (fail closed). */
  readonly declaredPlatform?: unknown;
  /** A model's platform suggestion; it can only escalate the requirement. */
  readonly modelPlatformSuggestion?: unknown;
  readonly dependencies?: "none" | "npm-lockfile";
  /** Explicit host approval of a CHANGED dependency identity; without it, only the committed baseline is approved. */
  readonly approvedDependencyIdentity?: Readonly<{ packageJsonSha256: string; lockfileSha256: string }>;
  readonly acknowledgedInstallScripts?: readonly string[];
  /** Allow the backend's explicit dependency stage to prepare a missing artifact first. */
  readonly prepareDependencies?: boolean;
  readonly timeoutMs?: number;
}
export interface ConfinedVerificationOutcome {
  readonly platform: PlatformAssessment;
  readonly verification: VerificationServiceResult;
}

function fixedReadOnlyPlan(plan: VerificationPlan): VerificationPlan {
  if (!Array.isArray(plan?.commands) || plan.commands.length === 0 || plan.commands.some(command => !command ||
      typeof command !== "object" || command.mutationPolicy !== "readOnly" || !Array.isArray(command.args)))
    failWith("InvalidInput", "Confined Writer verification requires a host-configured read-only verification plan.");
  return Object.freeze({ commands: Object.freeze(plan.commands.map(command =>
    Object.freeze({ ...command, args: Object.freeze([...command.args]) }))) });
}

const SIGNAL_TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|ps1|psm1|bat|cmd|sh|py)$/iu;
/** Platform assessment of the reconstructed candidate: changed paths, their bounded text and the root package.json. */
async function assessCandidatePlatform(root: string, changed: readonly string[], declared: unknown,
  modelSuggestion: unknown): Promise<PlatformAssessment> {
  const files: { path: string; text: string }[] = [];
  for (const path of changed.slice(0, 2_000)) {
    if (!SIGNAL_TEXT_FILE.test(path)) continue;
    try { files.push({ path, text: (await readBoundedFile(join(root, path), 512 * 1024)).toString("utf8") }); }
    catch { /* deleted, oversized or unreadable: path signals still apply */ }
  }
  let packageJson: unknown;
  try { packageJson = parseStrictJson((await readBoundedFile(join(root, "package.json"), 1024 * 1024)).toString("utf8"), 64); }
  catch { packageJson = undefined; }
  return assessPlatformRequirement({ declared, signals: detectPlatformSignals({ paths: changed, packageJson, files }),
    ...(modelSuggestion === undefined ? {} : { modelSuggestion }) });
}
