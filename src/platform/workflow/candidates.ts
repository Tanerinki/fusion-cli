import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { BaselineFileHash, ChangeScope, ChangeSet, FusionError, VerificationPlan } from "../../core/domain.js";
import { failWith, FusionFailure } from "../../core/errors.js";
import type { ApplicationOutcome, CleanupReport, HostChangeSet, VerificationEvidenceSummary, VerificationObservation, VerificationRefusal,
  VerificationVerdict, WorkspaceHandle, WorkspacePort } from "../../core/workflow/types.js";
import { isContainedPath } from "../events/shared.js";
import { BoundedReadError, readBoundedFile } from "../fs/bounded-read.js";
import { fusionTemporaryBase } from "../fs/temporary.js";
import { acceptedBackendOf, isGrantedAcceptance, type VerificationIsolationAcceptance } from "../verification/acceptance.js";
import { ClassifiedVerificationFailure, type VerificationBackend } from "../verification/backend.js";
import { DEPENDENCY_CONTROL_FILES } from "../verification/dependency-policy.js";
import { VerificationService } from "../verification/selection.js";
import type { ControlledTreeSnapshot } from "../verification/controlled-tree.js";
import { ProcessGitClient } from "../workspace/git.js";
import { PrimaryWorkspaceMonitor, type IgnoredCoverage } from "../workspace/ignored-monitor.js";
import { PrivateWriterWorkspace, type ConfinedVerificationOutcome } from "../workspace/private-writer.js";
import { buildScopeProtection, PROVIDER_INPUT_LIMITS, providerFacingContent, restoreProtectedContent } from "../workspace/sensitive-input.js";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
/** A file above the sharing limit: never shown to a provider, never written by a build. */
const TOO_LARGE: unique symbol = Symbol("fusion.tooLargeToShare");

/**
 * The explicit marker for an OFFLINE REHEARSAL: confined verification runs without a verification-isolation acceptance,
 * and every verdict says so (`acceptance: "offlineRehearsal"`). Nothing in readiness consumes such a verdict; it is never
 * production evidence. Production composition passes a granted acceptance instead.
 */
export const OFFLINE_REHEARSAL: unique symbol = Symbol("fusion.offlineRehearsal");

export interface PrivateCandidatePortOptions {
  /** Absolute top level of the user's primary repository. Candidates are private clones of its committed HEAD. */
  readonly primaryRoot: string;
  /** A Git client without ambient user or system configuration (`ProcessGitClient` with `isolatedConfig`). */
  readonly git: ProcessGitClient;
  /**
   * Either a verification-isolation acceptance granted by the acceptance authority in this process — the port then
   * verifies through exactly the backend instance it was granted for, and refuses a separately supplied `service` — or
   * `OFFLINE_REHEARSAL` with an explicit `service`. Anything else (a copy, a parsed object, a fixture) refuses verification.
   */
  readonly confinement: unknown;
  /** Offline rehearsal only: confined backends (the service refuses the trusted host for the autonomous Writer anyway). */
  readonly service?: VerificationService;
  /** The host's platform declaration (project configuration or a human). Absent means `unknown`: refused. */
  readonly declaredPlatform?: unknown;
  readonly dependencies?: "none" | "npm-lockfile";
  /** Explicit host approval of a CHANGED dependency identity. Without it a ChangeSet touching a manifest is refused. */
  readonly approvedDependencyIdentity?: Readonly<{ packageJsonSha256: string; lockfileSha256: string }>;
  readonly acknowledgedInstallScripts?: readonly string[];
  /** Run the backend's explicit dependency stage (validate a cached artifact, or prepare one) before verification. */
  readonly prepareDependencies?: boolean;
  readonly verificationTimeoutMs?: number;
  /** User-declared protected paths of the primary (content-monitored even when ignored). */
  readonly protectedPaths?: readonly string[];
  /** In-process observation hook (diagnostics and measurements); never persisted by the port. */
  readonly onVerification?: (observation: CandidateVerificationObservation) => void;
}
export interface CandidateVerificationObservation {
  readonly leaseId: string;
  readonly durationMs: number;
  readonly outcome: ConfinedVerificationOutcome;
}
export interface CandidateTiming {
  readonly stage: "acquire" | "apply" | "verify" | "release";
  readonly ms: number;
}

interface Entry {
  readonly handle: WorkspaceHandle;
  readonly workspace: PrivateWriterWorkspace;
  applied?: readonly string[];
  readonly inflight: Set<Promise<unknown>>;
}
const LEASE_ID = /^candidate-[0-9a-f]{24}$/u;

/**
 * The production Writer candidate port: every acquisition is a fresh `PrivateWriterWorkspace` (a private, remote-less
 * clone of the committed baseline in its own temporary root), the only mutation is `applyChangeSet` of a ChangeSet the
 * core already validated, and verification is `verifyConfined` through the verification service — the confined
 * backend, never the host, never a fallback. Refusals that stop verification before anything runs are classified.
 */
export class PrivateCandidateWorkspacePort implements WorkspacePort {
  readonly leaseRoot = fusionTemporaryBase();
  readonly timings: CandidateTiming[] = [];
  readonly #entries = new Map<string, Entry>();
  /** The service verification runs through: the accepted instance's own, or the rehearsal's; undefined refuses. */
  readonly #service: VerificationService | undefined;
  readonly #rehearsal: boolean;
  readonly #primary: PrimaryWorkspaceMonitor;
  constructor(private readonly options: PrivateCandidatePortOptions) {
    if (!isAbsolute(options.primaryRoot)) failWith("InvalidInput", "The candidate port needs an absolute primary repository root.");
    if (!(options.git instanceof ProcessGitClient) || !options.git.isolatedConfig)
      failWith("SecurityViolation", "The candidate port requires a Git client without ambient configuration.");
    if (options.dependencies !== undefined && options.dependencies !== "none" && options.dependencies !== "npm-lockfile")
      failWith("InvalidInput", "Unknown dependency lane.");
    this.#rehearsal = options.confinement === OFFLINE_REHEARSAL;
    const accepted = acceptedBackendOf(options.confinement);
    if (this.#rehearsal) {
      if (options.service === undefined) failWith("InvalidInput", "An offline rehearsal needs an explicit verification service.");
      this.#service = options.service;
    } else if (accepted !== undefined) {
      // Verification runs through exactly the instance the authority accepted: never another backend with the same id.
      if (options.service !== undefined) failWith("InvalidInput", "An accepted backend is used as granted; no other service may be supplied.");
      this.#service = new VerificationService([accepted as VerificationBackend]);
    } else this.#service = undefined;
    this.#primary = new PrimaryWorkspaceMonitor(resolve(options.primaryRoot), options.git,
      options.protectedPaths === undefined ? {} : { protectedPaths: options.protectedPaths });
  }
  get primaryRoot(): string { return resolve(this.options.primaryRoot); }
  /** Coverage of the latest primary observation's ignored-path monitoring (counts only). */
  get ignoredCoverage(): IgnoredCoverage | undefined { return this.#primary.coverage; }

  /**
   * What a provider view of this candidate is copied from: its path and the tree Fusion applied, verified on disk now.
   * Only the view store consumes it; the path never reaches a provider.
   */
  async candidateSource(handle: WorkspaceHandle): Promise<Readonly<{ path: string; tree: ControlledTreeSnapshot; baseCommit: string }>> {
    const entry = this.#entry(handle);
    const tree = await this.#track(entry, entry.workspace.expectedTree(handle.ownerId));
    return Object.freeze({ path: entry.workspace.path, tree, baseCommit: entry.workspace.baseCommit });
  }

  #entry(handle: WorkspaceHandle): Entry {
    const entry = this.#entries.get(handle?.leaseId);
    if (entry === undefined || entry.handle.ownerId !== handle.ownerId || entry.handle.path !== handle.path)
      failWith("WorkspaceConflict", "Unknown or foreign Writer candidate.");
    return entry;
  }
  /** Fusion's own work on a candidate is tracked so a release can let it settle first. */
  #track<T>(entry: Entry, work: Promise<T>): Promise<T> {
    const settled = work.then(() => undefined, () => undefined);
    entry.inflight.add(settled);
    void settled.then(() => entry.inflight.delete(settled));
    return work;
  }
  #time(stage: CandidateTiming["stage"], started: number): void { this.timings.push({ stage, ms: Math.round(performance.now() - started) }); }

  async acquire(ownerId: string, signal?: AbortSignal): Promise<WorkspaceHandle> {
    const started = performance.now();
    const workspace = await PrivateWriterWorkspace.open(this.primaryRoot, ownerId, this.options.git, undefined, signal);
    const handle: WorkspaceHandle = Object.freeze({ leaseId: `candidate-${randomBytes(12).toString("hex")}`, ownerId, path: workspace.path });
    this.#entries.set(handle.leaseId, { handle, workspace, inflight: new Set() });
    this.#time("acquire", started);
    return handle;
  }

  /**
   * v0.2.1: each file in scope AS ITS PROVIDER SAW IT: a file whose view masked secret values is reported by the digest of
   * that masked text, a protected file by an opaque digest (never its real one); every other file by its real digest.
   * `hostChangeSet` translates a proposal written against these back to the real files.
   */
  async baselineHashes(handle: WorkspaceHandle, paths: readonly string[]): Promise<readonly BaselineFileHash[]> {
    const entry = this.#entry(handle);
    const real = await this.#track(entry, entry.workspace.baselineHashes(handle.ownerId, paths));
    const facing: BaselineFileHash[] = [];
    for (const file of real) {
      if (file.sha256 === null) { facing.push(file); continue; }
      const bytes = await this.#pristine(entry, file.path);
      if (bytes === undefined || (bytes !== TOO_LARGE && sha256(bytes) !== file.sha256))
        failWith("WorkspaceConflict", "The candidate changed while its baseline was observed.");
      const shown = bytes === TOO_LARGE || buildScopeProtection(file.path, bytes) !== undefined ? undefined : providerFacingContent(file.path, bytes);
      facing.push(Object.freeze({ path: file.path, sha256: shown === undefined ? sha256(Buffer.from(`fusion:withheld:${file.path}`, "utf8")) : sha256(shown) }));
    }
    return Object.freeze(facing);
  }

  /**
   * v0.2.1 — the host form of a validated proposal for this still pristine candidate. Every operation keeps its kind and
   * path; a precondition that names the file as its provider saw it becomes the real digest (any other stays and fails the
   * precondition check as before), and written content gets exactly the masked values back (`restoreProtectedContent`).
   * A protected file, or content Fusion cannot restore exactly, refuses the whole proposal: nothing is applied.
   */
  async hostChangeSet(handle: WorkspaceHandle, changes: ChangeSet): Promise<HostChangeSet> {
    const entry = this.#entry(handle);
    let restored = 0;
    const operations: ChangeSet["operations"][number][] = [];
    for (const op of changes.operations) {
      const read = await this.#pristine(entry, op.path);
      if (read === TOO_LARGE)
        return Object.freeze({ refused: `${op.path} is too large to share with AI models, so a build never writes it` });
      const original = read;
      const protection = buildScopeProtection(op.path, original);
      if (protection !== undefined)
        return Object.freeze({ refused: `${op.path} is protected (${protection.reason}); a build never writes it` });
      const shown = original === undefined ? undefined : providerFacingContent(op.path, original);
      const expected = original !== undefined && shown !== undefined && op.expectedSha256 === sha256(shown) ? sha256(original) : op.expectedSha256;
      if (op.kind === "delete") { operations.push(Object.freeze({ ...op, expectedSha256: expected ?? op.expectedSha256 })); continue; }
      const restoration = restoreProtectedContent(op.path, original, op.content);
      if (restoration.status === "refused") return Object.freeze({ refused: restoration.reason });
      restored += restoration.restored;
      operations.push(Object.freeze({ ...op, expectedSha256: expected, content: restoration.content }));
    }
    return Object.freeze({ changes: Object.freeze({ ...changes, operations: Object.freeze(operations) }), restored });
  }

  /**
   * v0.5: the unchanged text of files of a PRISTINE candidate (never one that received a ChangeSet), read by Fusion itself:
   * the baseline its mutations are derived from. `null`: absent (or not a regular file); `tooLarge`: above the sharing bound.
   */
  async baselineTexts(handle: WorkspaceHandle, paths: readonly string[]): Promise<ReadonlyMap<string, string | null | "tooLarge">> {
    const entry = this.#entry(handle);
    if (entry.applied !== undefined) failWith("WorkspaceConflict", "Only a pristine candidate shows the baseline.");
    const texts = new Map<string, string | null | "tooLarge">();
    for (const path of paths) {
      const read = await this.#pristine(entry, path);
      texts.set(path, read === TOO_LARGE ? "tooLarge" : read === undefined ? null : read.toString("utf8"));
    }
    return texts;
  }

  /** A file of a pristine candidate (undefined when absent, not a regular file or reached through a link; bounded). */
  async #pristine(entry: Entry, relative: string): Promise<Buffer | typeof TOO_LARGE | undefined> {
    const root = entry.workspace.path, path = join(root, ...relative.split("/"));
    if (!isContainedPath(root, path)) failWith("SecurityViolation", "A scope path escapes the candidate.");
    let cursor = root;
    for (const part of relative.split("/")) {
      cursor = join(cursor, part);
      const info = await lstat(cursor).catch(() => undefined);
      if (info === undefined || info.isSymbolicLink()) return undefined;
      if (cursor !== path && !info.isDirectory()) return undefined;
      if (cursor === path && !info.isFile()) return undefined;
    }
    try { return await this.#track(entry, readBoundedFile(path, PROVIDER_INPUT_LIMITS.maxTextBytes)); }
    catch (error) {
      if (error instanceof BoundedReadError && error.reason === "tooLarge") return TOO_LARGE;
      throw error;
    }
  }

  async apply(handle: WorkspaceHandle, changes: ChangeSet, scope: ChangeScope): Promise<ApplicationOutcome> {
    const entry = this.#entry(handle);
    const started = performance.now();
    try {
      const stale = await this.#track(entry, entry.workspace.preconditionMismatches(handle.ownerId, changes, scope));
      if (stale.length > 0) return Object.freeze({ preconditionFailed: stale });
      const ledger = await this.#track(entry, entry.workspace.applyChangeSet(handle.ownerId, changes, scope));
      entry.applied = Object.freeze([...new Set(ledger.map(item => item.path))].sort());
      return Object.freeze({ applied: Object.freeze(ledger.map(item => Object.freeze({ kind: item.kind, path: item.path,
        beforeSha256: item.beforeSha256, afterSha256: item.afterSha256, bytes: item.bytes }))) });
    } finally { this.#time("apply", started); }
  }

  changedPaths(handle: WorkspaceHandle): Promise<readonly string[]> {
    const entry = this.#entry(handle);
    return this.#track(entry, entry.workspace.observedChanges(handle.ownerId));
  }

  async diff(handle: WorkspaceHandle, signal?: AbortSignal): Promise<Readonly<{ text: string; truncated: boolean }>> {
    const entry = this.#entry(handle);
    const change = await this.#track(entry, entry.workspace.diff(handle.ownerId, signal));
    return { text: change.text, truncated: change.truncated };
  }

  async fingerprint(handle: WorkspaceHandle | undefined, signal?: AbortSignal): Promise<string> {
    if (handle !== undefined) {
      const entry = this.#entry(handle);
      return this.#track(entry, entry.workspace.fingerprint(handle.ownerId));
    }
    // Git state, tracked and untracked files, plus the bounded ignored-path observation (`.env`, protected paths).
    return this.#primary.fingerprint(signal);
  }

  /**
   * Confined verification of the host-applied candidate. Before anything runs: a dependency-manifest change without
   * explicit host approval is `dependencyApprovalRequired`, and a missing acceptance is `confinementNotAccepted`
   * (unless this is an explicit offline rehearsal). A verification that ran is bound to the accepted backend and scope.
   */
  async verify(handle: WorkspaceHandle, plan: VerificationPlan, signal?: AbortSignal): Promise<VerificationVerdict> {
    const entry = this.#entry(handle);
    const applied = entry.applied;
    if (applied === undefined) failWith("WorkspaceConflict", "Only a host-applied candidate can be verified.");
    return this.#verifyConfined(entry, handle, applied, plan, signal);
  }

  /**
   * v0.4: the same confined verification of a candidate that has NOT received a ChangeSet — Fusion's checks on the unchanged
   * committed baseline (a reproduction). Exactly the path of `verify`, with nothing applied; refused once a ChangeSet was.
   */
  async verifyBaseline(handle: WorkspaceHandle, plan: VerificationPlan, signal?: AbortSignal): Promise<VerificationVerdict> {
    const entry = this.#entry(handle);
    if (entry.applied !== undefined) failWith("WorkspaceConflict", "Only a pristine candidate can be verified at its baseline.");
    return this.#verifyConfined(entry, handle, Object.freeze([]), plan, signal);
  }

  async #verifyConfined(entry: Entry, handle: WorkspaceHandle, applied: readonly string[], plan: VerificationPlan,
    signal: AbortSignal | undefined): Promise<VerificationVerdict> {
    const dependencies = this.options.dependencies ?? "none";
    if (applied.some(path => DEPENDENCY_CONTROL_FILES.includes(path.toLowerCase())) && this.options.approvedDependencyIdentity === undefined)
      return refusal("dependencyApprovalRequired", { kind: "SecurityViolation", retryable: false,
        safeMessage: "The ChangeSet changes the dependency environment; the new dependency identity needs explicit host approval." });
    const rehearsal = this.#rehearsal;
    const acceptance = rehearsal ? undefined : this.options.confinement;
    const service = this.#service;
    if (service === undefined || (!rehearsal && !isGrantedAcceptance(acceptance)))
      return refusal("confinementNotAccepted", { kind: "CapabilityUnavailable", retryable: false,
        safeMessage: "No verification-isolation acceptance granted in this process covers the confined backend." });
    const started = performance.now();
    let outcome: ConfinedVerificationOutcome;
    try {
      outcome = await this.#track(entry, entry.workspace.verifyConfined(handle.ownerId, applied, service, {
        plan, declaredPlatform: this.options.declaredPlatform, dependencies,
        prepareDependencies: dependencies === "npm-lockfile" && this.options.prepareDependencies !== false,
        ...(this.options.approvedDependencyIdentity ? { approvedDependencyIdentity: this.options.approvedDependencyIdentity } : {}),
        ...(this.options.acknowledgedInstallScripts ? { acknowledgedInstallScripts: this.options.acknowledgedInstallScripts } : {}),
        ...(this.options.verificationTimeoutMs === undefined ? {} : { timeoutMs: this.options.verificationTimeoutMs }) }, signal));
    } catch (error) {
      if (error instanceof ClassifiedVerificationFailure) return refusal(error.classification, error.error);
      // The backend's own wall clock expired: a check that did not pass in time, never a pass.
      if (error instanceof FusionFailure && error.error.kind === "Timeout" && signal?.aborted !== true)
        return { passed: false, commandsRun: 0, failure: error.error };
      throw error;
    } finally { this.#time("verify", started); }
    const { verification, platform } = outcome;
    if (acceptance !== undefined) {
      const granted = acceptance as VerificationIsolationAcceptance;
      if (verification.selection.backendId !== granted.backendId ||
          !(granted.satisfies as readonly string[]).includes(platform.effective))
        failWith("SecurityViolation", "The candidate was verified outside the scope of its verification-isolation acceptance.");
    }
    this.options.onVerification?.({ leaseId: handle.leaseId, durationMs: Math.round(performance.now() - started), outcome });
    const report = verification.result.report;
    const failed = report.steps.find(step => step.status !== "passed");
    const evidence: VerificationEvidenceSummary = {
      backendId: verification.selection.backendId, confinement: verification.selection.confinement,
      platformRequirement: platform.effective, acceptance: rehearsal ? "offlineRehearsal" : "granted",
      ...(verification.dependencyStage === undefined ? {} : { dependencies: { kind: dependencies, key: verification.dependencyStage.key,
        prepared: !verification.dependencyStage.cacheHit, cacheHit: verification.dependencyStage.cacheHit } }),
      commands: report.steps.map(step => ({ id: step.commandId, status: step.status, exitCode: step.exitCode })) };
    const passed = verification.result.passed === true && report.passed === true && report.steps.length === plan.commands.length;
    const observations = observationsOf(verification.result, report.steps);
    return { passed, commandsRun: report.steps.length, ...(failed ? { failedCommand: failed.commandId } : {}),
      ...(passed ? {} : { failure: report.failure ?? { kind: "VerificationFailure", retryable: false,
        safeMessage: "Confined verification did not pass." } }), evidence, ...(observations === undefined ? {} : { observations }) };
  }

  /** Discards a candidate after Fusion's own work on it settled (bounded). Proven only when its private root is gone. */
  async release(handle: WorkspaceHandle): Promise<CleanupReport> {
    const entry = this.#entries.get(handle?.leaseId);
    if (entry === undefined || !LEASE_ID.test(handle.leaseId)) return { complete: false, reason: "unknown-candidate" };
    const started = performance.now();
    try {
      await Promise.race([Promise.allSettled([...entry.inflight]), new Promise(done => setTimeout(done, 60_000).unref())]);
      await entry.workspace.close(handle.ownerId, { discardChanges: true });
      this.#entries.delete(handle.leaseId);
      try { await lstat(dirname(entry.workspace.path)); return { complete: false, reason: "candidate-still-present" }; }
      catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? { complete: true } : { complete: false, reason: "candidate-unverifiable" };
      }
    } catch { return { complete: false, reason: "candidate-removal-failed" }; }
    finally { this.#time("release", started); }
  }
}

/** An excerpt kept in memory only (the end of the retained output), for a bounded, redacted reproducer. */
const EXCERPT_CHARS = 2_000;
/**
 * v0.5: what each command printed, from a backend that reports its output (the Docker backend's retained stdout tail): the
 * digest of the retained output and whether it is the whole output. Absent for a backend that reports none.
 */
function observationsOf(result: unknown, steps: readonly Readonly<{ commandId: string; exitCode: number | null; stdoutTruncated?: boolean }>[]):
  readonly VerificationObservation[] | undefined {
  const docker = (result as { docker?: { steps?: readonly Readonly<{ id: string; stdoutTail: string }>[] } }).docker;
  if (docker?.steps === undefined) return undefined;
  const tails = new Map(docker.steps.map(step => [step.id, step.stdoutTail]));
  return Object.freeze(steps.flatMap(step => {
    const tail = tails.get(step.commandId);
    return tail === undefined ? [] : [Object.freeze({ id: step.commandId, exitCode: step.exitCode, stdoutSha256: sha256(Buffer.from(tail, "utf8")),
      complete: step.stdoutTruncated !== true, excerpt: tail.slice(-EXCERPT_CHARS) })];
  }));
}

function refusal(kind: VerificationRefusal, error: FusionError): VerificationVerdict {
  return { passed: false, commandsRun: 0, refusal: kind, failure: error };
}
