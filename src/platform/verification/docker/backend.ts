import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { FusionError, VerificationPlan } from "../../../core/domain.js";
import { failWith, FusionFailure } from "../../../core/errors.js";
import { DiagnosticRedactor } from "../../../core/policy/redaction.js";
import { assertDependencySupport, assertPlatformEligible, failClassified, type RecoveryReport, type VerificationBackend,
  type VerificationBackendProbe,
  type VerificationCleanupResult, type VerificationExecutionRequest, type VerificationExecutionResult,
  type VerificationLease } from "../backend.js";
import { backendEvidence, checkFact, observedFact, unobservedFact, type BackendEvidence,
  type BackendEvidenceFact } from "../backend-evidence.js";
import { assertApprovedManifests, dependencyFailure, dependencyIdentity, dependencyIdentityKey, readNpmManifests,
  validateNpmManifests, NPM_CI_ARGS, type DependencyIdentity, type DependencyRequirement, type NpmManifestReport,
  type NpmManifests } from "../dependency-policy.js";
import type { VerificationReport, VerificationStepResult, VerificationStepStatus } from "../engine.js";
import { buildContainerVerifierEnvironment, CONTAINER_VERIFIER_ENV } from "../verifier-environment.js";
import { candidateSourcePart, containerInput, createRunDirectories, loadGuestBundle, manifestFrame, memoryPart,
  removeRunDirectories, type GuestBundle, type RunDirectories, type SnapshotStats, type StreamedPart } from "./bundle.js";
import { CliDockerRunner, isNoSuchObject, parseContainerInspect, parseDockerVersion, parseImageInspect, requireExited,
  resolveDockerCli, type ContainerInspection, type DockerCommandRunner, type DockerImageInfo, type DockerInput,
  type DockerOutcome, type DockerServerInfo } from "./cli.js";
import { assertImageId, assertPinnedImage, buildCreateArgs, CONTAINER_ID, DOCKER_BACKEND_ID, DOCKER_PROTOCOL_VERSION,
  GUEST_PATHS, GUEST_USER, imageDigest, isFusionOwned, networkFor, PRODUCTION_DOCKER_IMAGE, PRODUCTION_NODE_VERSION,
  resolveLimits, LIMIT_BOUNDS, OWNER_LABELS, type DockerResourceLimits, type GuestMode } from "./config.js";
import { DEPENDENCY_ARTIFACT_LIMITS, DependencyArtifactStore, MAX_COMPRESSED_ARTIFACT_BYTES, type DependencyArtifactRecord,
  type ValidatedArtifact } from "./dependency-artifacts.js";
import { decodeCanaryResult, decodeDependencyResult, decodeVerifyResult, DOCKER_RESULT_LIMITS, parseTestCounts,
  type CanaryManifest, type CanaryResult, type DependencyManifest, type DescendantManifest, type GuestCommand,
  type GuestRuntime, type TestCounts, type VerifyManifest, type VerifyResult } from "./protocol.js";
import { ACTIVE_DOCKER_RUNS, removeOwned, sweepStaleContainers, type SweepOptions } from "./sweeper.js";

/**
 * Productionized Docker/Linux verification backend (O5.5B6). Untrusted verification runs in a disposable Linux
 * container created from a digest-pinned image with no network, no capabilities, no privilege escalation, a read-only
 * root filesystem, an unprivileged user, bounded memory/CPU/PIDs, tmpfs-only scratch and NO host mount of any kind:
 * the guest runner, the manifest and every input archive arrive over the attached stdin and are extracted into tmpfs
 * before repository code runs; the result returns on the attached stdout. Dependencies come only from the separate,
 * explicit dependency-preparation stage (`prepareDependencies`) as an immutable, identity-bound, copy-on-use artifact.
 *
 * It PROVES LINUX BEHAVIOR ONLY (`platformSemantics: "linux"`): Windows paths, NTFS ACLs, PowerShell, Win32 APIs and
 * Windows-only native addons are out of reach, so it refuses a `windows-required` or `unknown` platform requirement.
 * `productionEligible` stays the constant `false`: a backend never self-declares eligibility. Only the acceptance
 * authority (`verification/production.ts`) can grant a SCOPED acceptance, and only for an instance made by
 * `createProductionDockerBackend` together with evidence this very instance observed.
 */
export interface DockerLinuxBackendOptions {
  /** Digest-pinned image reference, e.g. `node@sha256:<64 hex>`. Never pulled by the backend. */
  readonly image: string;
  /** Optional expected image id (`sha256:<64 hex>`); a different local image with the same reference is refused. */
  readonly expectedImageId?: string;
  /** Expected `process.version` inside the image; defaults to the validated version for the production image. */
  readonly expectedNodeVersion?: string;
  readonly limits?: Partial<DockerResourceLimits>;
  /** Absolute in-image executables a verification command may name. Default: the image's node binary only. */
  readonly allowedExecutables?: readonly string[];
  /** Base directory for the evidence stage's host-private marker directory. Default: the OS temporary directory. */
  readonly baseDirectory?: string;
  /** Fusion-owned dependency artifact store. Default: `<tmp>/fusion-dependency-store`. */
  readonly dependencyStoreDirectory?: string;
  /** Time allowed beyond the summed command timeouts for container start and input transfer. */
  readonly hostDeadlineAllowanceMs?: number;
  /** Wall-clock bound of the npm stage of dependency preparation. */
  readonly dependencyTimeoutMs?: number;
  /** Source of the docker CLI's allowlisted environment. Default: `process.env`. */
  readonly clientEnvironment?: NodeJS.ProcessEnv;
  /** Test seams. An instance built with either is never a production instance. */
  readonly runner?: DockerCommandRunner;
  readonly resolveDocker?: () => Promise<string | null>;
}

export interface DockerEvidenceOptions {
  /** Names of synthetic marker files the caller placed OUTSIDE the container (primary repo, profile, provider state). */
  readonly absentMarkerNames?: readonly string[];
  /** Host deadline used by the deadline-termination probe. */
  readonly hangDeadlineMs?: number;
}

export interface DockerStepObservation {
  readonly id: string;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly testCounts: TestCounts | null;
}
export interface DockerRunTimings {
  /** Host: candidate archive planning + digest, bundle load, dependency artifact validation. */
  readonly prepareMs: number;
  readonly createMs: number;
  /** `docker start --attach --interactive` until the result arrived (container start + transfer + commands). */
  readonly attachMs: number;
  /** Guest-measured: receiving and extracting all input archives. */
  readonly inputMs: number | null;
  readonly commandsMs: number | null;
  readonly inspectMs: number;
  readonly removeMs: number;
  readonly totalMs: number;
}
export interface DockerRunObservation {
  readonly runId: string;
  readonly runnerSha256: string;
  readonly bundleSha256: string;
  readonly source: SnapshotStats & Readonly<{ archiveSha256: string; archiveBytes: number }>;
  readonly dependencies: Readonly<{ key: string; sha256: string; compressedBytes: number; entries: number }> | null;
  readonly limits: DockerResourceLimits;
  readonly containerExitCode: number | null;
  readonly oomKilled: boolean;
  readonly resultAccepted: boolean;
  /** Stable reason the guest result was not accepted. */
  readonly rejection?: string;
  readonly runtime: GuestRuntime | null;
  readonly steps: readonly DockerStepObservation[];
  readonly timings: DockerRunTimings;
}
export interface DockerVerificationExecutionResult extends VerificationExecutionResult {
  readonly docker: DockerRunObservation;
}
/** Non-secret detail behind the evidence facts (counts, interface names, cgroup values) plus phase timings. */
export interface DockerEvidenceDetail {
  readonly canary: CanaryResult | undefined;
  readonly timings: Readonly<{ canaryMs: number; descendantMs: number; deadlineMs: number; sweepMs: number; totalMs: number }>;
}
export interface DependencyPreparationRequest {
  readonly workspaceRoot: string;
  readonly dependencies: DependencyRequirement;
  readonly signal?: AbortSignal;
}
export interface DependencyNpmDiagnostics {
  readonly version: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}
export interface DependencyPreparationReport {
  readonly key: string;
  readonly identity: DependencyIdentity;
  readonly cacheHit: boolean;
  readonly record: DependencyArtifactRecord;
  readonly manifests: NpmManifestReport;
  /** Only for a fresh preparation: the stage's network mode and phase timings. */
  readonly preparation?: Readonly<{ runId: string; network: "bridge"; npmMs: number; createMs: number; attachMs: number;
    validateMs: number; removeMs: number; totalMs: number }>;
}

/** Narrow facts a complete Docker evidence record must observe as passing. Deliberately no universal claim names. */
export const DOCKER_REQUIRED_EVIDENCE_FACTS = Object.freeze([
  "linuxEngineObserved", "pinnedImageObserved", "privilegedDisabledObserved", "capDropAllObserved",
  "noNewPrivilegesOptionObserved", "defaultConfinementProfilesKeptObserved", "readOnlyRootfsObserved",
  "nonRootUserConfiguredObserved", "networkModeNoneObserved", "hostNamespacesNotSharedObserved", "noDevicesObserved",
  "noHostMountsObserved", "noWritableHostMountObserved", "noDockerSocketMountObserved", "tmpfsScratchOnlyObserved",
  "stdinInputChannelObserved", "resourceLimitsConfiguredObserved", "ownershipLabelsObserved", "logDriverNoneObserved",
  "initReaperObserved", "containerEnvKeysAllowlistedObserved",
  "guestNonRootObserved", "guestNoNewPrivsObserved", "guestSeccompFilterObserved", "guestCapabilitySetsEmptyObserved",
  "transferredInputReadObserved", "transferDigestObserved", "rootfsWriteDeniedObserved", "scratchWriteObserved",
  "mountTableHostPathAbsentObserved", "hostMarkersNotFoundObserved", "credentialEnvMarkersAbsentObserved",
  "gitSshCredentialPathsAbsentObserved", "dockerSocketAbsentObserved", "loopbackOnlyInterfacesObserved",
  "canaryConnectionsFailedObserved", "cgroupLimitsObserved", "pidLimitEnforcedObserved", "unexpectedDevicesAbsentObserved",
  "yamaPtraceRestrictedObserved", "guestRuntimeIdentityObserved",
  "verifyInputDigestMatchedObserved", "descendantRemovedWithContainerObserved", "hostDeadlineTerminationObserved",
  "ownedContainersRemovedObserved",
] as const);
/**
 * O5.5B5 facts superseded by protocol 2 (no host mount exists any more), each by a strictly stronger observation:
 * `inputBindReadOnlyObserved` → `noHostMountsObserved`; `inputReadObserved` → `transferredInputReadObserved`;
 * `inputWriteDeniedObserved` and `canaryInputUnchangedObserved` → `noHostMountsObserved` +
 * `mountTableHostPathAbsentObserved` (no host path is reachable at all); `verifyInputUnchangedObserved` →
 * `verifyInputDigestMatchedObserved`.
 */
export const SUPERSEDED_EVIDENCE_FACTS = Object.freeze({ inputBindReadOnlyObserved: "noHostMountsObserved",
  inputReadObserved: "transferredInputReadObserved", inputWriteDeniedObserved: "mountTableHostPathAbsentObserved",
  canaryInputUnchangedObserved: "mountTableHostPathAbsentObserved", verifyInputUnchangedObserved: "verifyInputDigestMatchedObserved" });

/** Environment key names a verifier container must never carry (names only; values are never read by the host). */
export const FORBIDDEN_ENV_KEYS = Object.freeze(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  "SSH_ASKPASS", "GITHUB_TOKEN", "GH_TOKEN", "GIT_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "NPM_TOKEN", "NODE_AUTH_TOKEN", "NODE_OPTIONS",
  "DOCKER_HOST", "DOCKER_CONFIG", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AZURE_CLIENT_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]);
export const FORBIDDEN_ENV_PREFIXES = Object.freeze(["ANTHROPIC_", "CLAUDE", "MUSE_", "META_", "TBH_", "OPENAI_", "SSH_",
  "GIT_CONFIG", "GIT_CREDENTIAL", "AWS_", "AZURE_", "GOOGLE_", "GH_", "GITHUB_", "DOCKER_", "NPM_CONFIG_"]);
export const CANARY_VALUE_PREFIX = "fusion-canary-";
const ALLOWED_DEVICES = Object.freeze(["core", "fd", "full", "mqueue", "null", "ptmx", "pts", "random", "shm", "stderr",
  "stdin", "stdout", "tty", "urandom", "zero"]);
const MARKER_NAME = /^fusion-canary-[0-9a-f]{16,64}(?:\.[a-z]{1,8})?$/u;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const POSIX_EXECUTABLE = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ash", "ksh", "busybox", "env", "sudo", "su"]);
const NODE_VERSION = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/u;
const BASE64_LINE = /^[A-Za-z0-9+/]*={0,2}$/u;
const ZERO_SHA256 = "0".repeat(64);
const MIB = 1024 * 1024;
/** Limits of the dependency-preparation container (npm cache and the installed tree live in its tmpfs). */
export const DEPENDENCY_PREPARATION_LIMITS: DockerResourceLimits = Object.freeze({ memoryBytes: 4096 * MIB,
  nanoCpus: 2_000_000_000, pids: 512, workTmpfsMiB: 3072, tmpTmpfsMiB: 512 });
/** Minimum stdin transfer rate assumed when sizing host deadlines (Docker Desktop attach observed at ~20 MiB/s). */
const TRANSFER_BYTES_PER_SECOND = 4 * MIB;

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const elapsed = (since: number): number => Math.round(performance.now() - since);
const transferAllowanceMs = (bytes: number): number => Math.ceil(bytes / TRANSFER_BYTES_PER_SECOND) * 1000;

// ---------------------------------------------------------------- production identity

const PRODUCTION_INSTANCES = new WeakSet<DockerLinuxVerificationBackend>();
/** Evidence objects produced by `collectEvidence` of a given backend instance, with what that instance observed. */
export interface ObservedDockerEvidence {
  readonly backend: DockerLinuxVerificationBackend;
  readonly server: DockerServerInfo;
  readonly image: DockerImageInfo;
  readonly imageReference: string;
  readonly runtime: GuestRuntime | null;
  readonly observedAt: string;
}
const OBSERVED_EVIDENCE = new WeakMap<BackendEvidence, ObservedDockerEvidence>();

/**
 * The only way to obtain a production instance: the validated production image, the real `docker` CLI resolved from
 * PATH and no test seam. Everything else (a fake runner, another image) builds an ordinary, never-accepted instance.
 */
export function createProductionDockerBackend(options: Readonly<{ dependencyStoreDirectory?: string; baseDirectory?: string;
  clientEnvironment?: NodeJS.ProcessEnv }> = {}): DockerLinuxVerificationBackend {
  const backend = new DockerLinuxVerificationBackend({ image: PRODUCTION_DOCKER_IMAGE, expectedNodeVersion: PRODUCTION_NODE_VERSION,
    ...(options.dependencyStoreDirectory ? { dependencyStoreDirectory: options.dependencyStoreDirectory } : {}),
    ...(options.baseDirectory ? { baseDirectory: options.baseDirectory } : {}),
    ...(options.clientEnvironment ? { clientEnvironment: options.clientEnvironment } : {}) });
  PRODUCTION_INSTANCES.add(backend);
  return backend;
}
export const isProductionDockerBackend = (backend: unknown): backend is DockerLinuxVerificationBackend =>
  typeof backend === "object" && backend !== null && PRODUCTION_INSTANCES.has(backend as DockerLinuxVerificationBackend);
/** What an instance observed for an evidence object it produced; `undefined` for any hand-built or foreign evidence. */
export const observedDockerEvidence = (evidence: unknown): ObservedDockerEvidence | undefined =>
  typeof evidence === "object" && evidence !== null ? OBSERVED_EVIDENCE.get(evidence as BackendEvidence) : undefined;

// ---------------------------------------------------------------- plan validation

interface ReadyState {
  readonly server: DockerServerInfo;
  readonly image: DockerImageInfo;
}
interface LeaseState {
  readonly runId: string;
  readonly nonce: string;
  readonly createdAt: string;
  readonly commands: readonly GuestCommand[];
  readonly plan: VerificationPlan;
  /** Engine and image identity from the probe this lease was prepared under; later probes cannot change it. */
  readonly engine: ReadyState;
  readonly bundle: GuestBundle;
  readonly source: Readonly<{ part: StreamedPart; stats: SnapshotStats }>;
  readonly dependencies: Readonly<{ key: string; artifact: ValidatedArtifact }> | null;
  readonly limits: DockerResourceLimits;
  readonly prepareMs: number;
  /** Containers this lease created and has not yet proven removed. */
  readonly containers: Set<string>;
  /** Container ids this lease ever created (for the final ownership-scoped sweep). */
  readonly created: Set<string>;
  /** The resource limits each container was created with (for the daemon-observed limit fact). */
  readonly limitsById: Map<string, DockerResourceLimits>;
  readonly inspections: ContainerInspection[];
  ran: boolean;
  evidenceCollected: boolean;
  evidenceDetail?: DockerEvidenceDetail;
  evidenceDirectories?: RunDirectories;
  inputDigestMatched?: boolean;
  runtime?: GuestRuntime;
  inflight?: Promise<void>;
}

/** Validates a plan for in-container execution: host-fixed executables only, bounded argv, relative cwd, no shells. */
export function validateDockerPlan(plan: VerificationPlan, allowedExecutables: readonly string[]): GuestCommand[] {
  const invalid = (message: string): never => failWith("InvalidInput", message);
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.commands) || plan.commands.length === 0 ||
      plan.commands.length > DOCKER_RESULT_LIMITS.maxCommands)
    invalid(`A Docker verification plan needs between 1 and ${DOCKER_RESULT_LIMITS.maxCommands} commands.`);
  const ids = new Set<string>();
  let total = 0;
  return plan.commands.map(command => {
    if (command === null || typeof command !== "object") invalid("A verification command must be an object.");
    if (typeof command.id !== "string" || !COMMAND_ID.test(command.id) || ids.has(command.id))
      invalid("Verification command IDs must be unique short identifiers.");
    ids.add(command.id);
    if (!allowedExecutables.includes(command.executable))
      invalid("Docker verification executables must be one of the backend's allowlisted in-image binaries.");
    if (!Array.isArray(command.args) || command.args.length > DOCKER_RESULT_LIMITS.maxArgs ||
        !command.args.every(arg => typeof arg === "string" && !arg.includes("\0") &&
          Buffer.byteLength(arg, "utf8") <= DOCKER_RESULT_LIMITS.maxArgBytes))
      invalid("Verification arguments must be an explicit bounded array of strings.");
    if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > DOCKER_RESULT_LIMITS.maxCommandTimeoutMs)
      invalid("Docker verification timeouts must be between 1 ms and 30 minutes.");
    total += command.timeoutMs;
    if (command.mutationPolicy !== "readOnly" && command.mutationPolicy !== "allowMutation")
      invalid("Verification commands need an explicit mutation policy.");
    if (typeof command.cwd !== "string" || command.cwd.length === 0 || command.cwd.length > 256 ||
        /[\u0000-\u001f]/u.test(command.cwd) || posix.isAbsolute(command.cwd) || win32.isAbsolute(command.cwd))
      invalid("Verification cwd must be a relative path inside the candidate.");
    const parts = command.cwd.split(/[\\/]/u).filter(part => part !== "" && part !== ".");
    if (parts.includes("..")) invalid("Verification cwd must not contain '..'.");
    if (total > 60 * 60 * 1000) invalid("Docker verification plans may not exceed one hour in total.");
    return Object.freeze({ id: command.id, executable: command.executable, args: Object.freeze([...command.args]),
      cwd: parts.length === 0 ? "." : parts.join("/"), timeoutMs: command.timeoutMs });
  });
}

/** Tmpfs and memory sized for an extracted dependency tree, within the fixed bounds. */
export function limitsForDependencies(base: DockerResourceLimits, dependencyBytes: number): DockerResourceLimits {
  if (dependencyBytes === 0) return base;
  const workTmpfsMiB = Math.min(LIMIT_BOUNDS.workTmpfsMiB[1], base.workTmpfsMiB + Math.ceil(dependencyBytes * 1.25 / MIB));
  // tmpfs pages count against the memory cgroup, so memory grows by exactly the added tmpfs.
  const memoryBytes = Math.min(LIMIT_BOUNDS.memoryBytes[1], base.memoryBytes + (workTmpfsMiB - base.workTmpfsMiB) * MIB);
  return resolveLimits({ ...base, workTmpfsMiB, memoryBytes });
}

export class DockerLinuxVerificationBackend implements VerificationBackend {
  readonly id = DOCKER_BACKEND_ID;
  readonly confinement = "osSandbox" as const;
  readonly productionEligible = false as const;
  readonly platformSemantics = "linux" as const;
  readonly dependencyKinds = Object.freeze(["npm-lockfile"] as const);
  readonly #image: string;
  readonly #expectedImageId: string | undefined;
  readonly #expectedNode: string | undefined;
  readonly #limits: DockerResourceLimits;
  readonly #allowedExecutables: readonly string[];
  readonly #base: string;
  readonly #allowanceMs: number;
  readonly #dependencyTimeoutMs: number;
  readonly #store: DependencyArtifactStore;
  readonly #leases = new WeakMap<VerificationLease, LeaseState>();
  #runner: DockerCommandRunner | undefined;
  #ready: ReadyState | undefined;
  #probeMs = 0;
  #lastNpm: DependencyNpmDiagnostics | undefined;

  constructor(private readonly options: DockerLinuxBackendOptions) {
    this.#image = assertPinnedImage(options.image);
    this.#expectedImageId = options.expectedImageId === undefined ? undefined : assertImageId(options.expectedImageId);
    this.#expectedNode = options.expectedNodeVersion ?? (this.#image === PRODUCTION_DOCKER_IMAGE ? PRODUCTION_NODE_VERSION : undefined);
    if (this.#expectedNode !== undefined && !NODE_VERSION.test(this.#expectedNode)) failWith("InvalidInput", "Expected Node version is invalid.");
    this.#limits = resolveLimits(options.limits);
    const allowed = options.allowedExecutables ?? [GUEST_PATHS.node];
    if (allowed.length === 0 || !allowed.every(path => typeof path === "string" && POSIX_EXECUTABLE.test(path) &&
        !path.split("/").includes("..") && !SHELLS.has(posix.basename(path))))
      failWith("InvalidInput", "Docker allowed executables must be absolute in-image binaries and never shells.");
    this.#allowedExecutables = Object.freeze([...allowed]);
    this.#base = options.baseDirectory ?? tmpdir();
    this.#store = new DependencyArtifactStore(options.dependencyStoreDirectory ?? join(tmpdir(), "fusion-dependency-store"));
    this.#allowanceMs = options.hostDeadlineAllowanceMs ?? 60_000;
    if (!Number.isSafeInteger(this.#allowanceMs) || this.#allowanceMs < 1_000 || this.#allowanceMs > 10 * 60_000)
      failWith("InvalidInput", "Docker host deadline allowance is out of range.");
    this.#dependencyTimeoutMs = options.dependencyTimeoutMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.#dependencyTimeoutMs) || this.#dependencyTimeoutMs < 5_000 || this.#dependencyTimeoutMs > 60 * 60_000)
      failWith("InvalidInput", "Dependency preparation timeout is out of range.");
  }

  get limits(): DockerResourceLimits { return this.#limits; }
  get image(): string { return this.#image; }
  get expectedNodeVersion(): string | undefined { return this.#expectedNode; }
  get dependencyStore(): DependencyArtifactStore { return this.#store; }
  /** Duration of the last probe (performance reporting). */
  get probeMs(): number { return this.#probeMs; }
  /**
   * Bounded, control-character-free npm output of the last dependency preparation (for an operator diagnosing a
   * refused project). The preparation container holds no credential, so it cannot contain one; it is never parsed.
   */
  get lastDependencyDiagnostics(): DependencyNpmDiagnostics | undefined { return this.#lastNpm; }

  async #getRunner(): Promise<DockerCommandRunner | undefined> {
    if (this.#runner !== undefined) return this.#runner;
    const executable = await (this.options.resolveDocker ?? (() => resolveDockerCli()))();
    if (executable === null) return undefined;
    this.#runner = this.options.runner ?? new CliDockerRunner(executable, this.options.clientEnvironment ?? process.env);
    return this.#runner;
  }
  /** The CLI seam only. Cleanup of an existing lease never depends on a later probe's outcome. */
  #requireRunner(): DockerCommandRunner {
    if (this.#runner === undefined) failWith("CapabilityUnavailable", "Docker backend was not probed successfully.");
    return this.#runner;
  }
  /**
   * Crash recovery (see `sweeper.ts`): stale, fully Fusion-labelled containers older than the longest possible run,
   * plus this store's abandoned staging directories. Nothing unproven is touched; a partial result says so.
   */
  async recoverStale(_signal?: AbortSignal, options: SweepOptions = {}): Promise<RecoveryReport> {
    const runner = await this.#getRunner();
    if (runner === undefined) return { complete: true, removed: 0, reasons: ["docker-cli-missing: nothing to recover"] };
    const sweep = await sweepStaleContainers(runner, options);
    const staging = await this.#store.discardStaleStaging(options.nowMs ?? Date.now()).catch(() => -1);
    const reasons = [...sweep.reasons, ...(staging < 0 ? ["abandoned dependency staging could not be cleaned"] : [])];
    return Object.freeze({ complete: sweep.complete && staging >= 0, removed: sweep.removed.length + Math.max(0, staging),
      reasons: Object.freeze(reasons) });
  }

  /**
   * Read-only availability check with classified, stable reasons: CLI missing, daemon unavailable, wrong engine
   * (Windows containers), malformed answers, image absent, or image identity (digest, id, OS, architecture) mismatch.
   */
  async probe(signal?: AbortSignal): Promise<VerificationBackendProbe> {
    const started = performance.now();
    const unavailable = (reason: string): VerificationBackendProbe => {
      this.#ready = undefined;
      this.#probeMs = elapsed(started);
      return { backendId: this.id, available: false, confinement: this.confinement, reason };
    };
    const runner = await this.#getRunner();
    if (runner === undefined) return unavailable("docker-cli-missing");
    const version = await runner.run({ args: ["version", "--format", "{{json .}}"], timeoutMs: 20_000,
      maxStdoutBytes: 64 * 1024, ...(signal ? { signal } : {}) });
    if (version.status === "cancelled") failWith("Cancelled", "Docker probe was cancelled.");
    if (version.status === "spawnFailure") return unavailable("docker-cli-missing");
    if (version.status !== "exited") return unavailable("docker-cli-failed");
    const reading = parseDockerVersion(version.stdout);
    if (version.exitCode !== 0 || reading.kind === "noServer") return unavailable("docker-daemon-unavailable");
    if (reading.kind === "malformed") return unavailable("docker-version-malformed");
    if (reading.server.os !== "linux") return unavailable("docker-engine-not-linux");
    // The backend never pulls: an absent image is a prerequisite for the operator, not something fetched on demand.
    const image = await runner.run({ args: ["image", "inspect", "--format", "{{json .}}", this.#image], timeoutMs: 20_000,
      maxStdoutBytes: 512 * 1024, ...(signal ? { signal } : {}) });
    if (image.status === "cancelled") failWith("Cancelled", "Docker probe was cancelled.");
    if (image.status !== "exited") return unavailable("docker-image-inspect-failed");
    if (image.exitCode !== 0) return unavailable(isNoSuchObject(image) ? "docker-image-not-present" : "docker-image-inspect-failed");
    const info = parseImageInspect(image.stdout);
    if (info === undefined) return unavailable("docker-image-inspect-malformed");
    const digest = imageDigest(this.#image);
    const pinned = info.id === digest || info.repoDigests.some(entry => entry.endsWith(`@${digest}`));
    if (!pinned || (this.#expectedImageId !== undefined && info.id !== this.#expectedImageId))
      return unavailable("docker-image-digest-mismatch");
    if (info.os !== "linux" || info.architecture !== reading.server.arch) return unavailable("docker-image-platform-mismatch");
    this.#ready = Object.freeze({ server: reading.server, image: info });
    this.#probeMs = elapsed(started);
    return { backendId: this.id, available: true, confinement: this.confinement };
  }

  /** Daemon and image identity observed by the last successful probe (non-secret; for inventory and evidence). */
  get observedEngine(): ReadyState | undefined { return this.#ready; }

  async #requireReady(signal?: AbortSignal): Promise<ReadyState> {
    if (this.#ready === undefined) {
      const probe = await this.probe(signal);
      if (!probe.available) failWith("CapabilityUnavailable", `Docker verification backend is unavailable: ${probe.reason ?? "unknown"}.`);
    }
    return this.#ready!;
  }

  #identityFor(engine: ReadyState, report: NpmManifestReport, acknowledged: readonly string[] | undefined): DependencyIdentity {
    return dependencyIdentity(report, { image: this.#image, os: engine.image.os, arch: engine.image.architecture }, acknowledged ?? []);
  }

  /**
   * Reads, approves and validates the candidate's npm manifests ONCE (the policy decides; nothing runs). The returned
   * bytes are the only ones used afterwards, so what was approved is exactly what the preparation stage receives.
   */
  async #manifests(root: string, requirement: Extract<DependencyRequirement, { kind: "npm-lockfile" }>):
    Promise<Readonly<{ report: NpmManifestReport; manifests: NpmManifests }>> {
    try {
      const manifests = await readNpmManifests(root);
      assertApprovedManifests(manifests, requirement);
      return { manifests, report: validateNpmManifests(manifests.packageJson, manifests.lockfile, requirement.acknowledgedInstallScripts ?? []) };
    } catch (error) { return dependencyFailure(error); }
  }

  async prepare(request: VerificationExecutionRequest): Promise<VerificationLease> {
    assertPlatformEligible(this, request);
    assertDependencySupport(this, request);
    const commands = validateDockerPlan(request.plan, this.#allowedExecutables);
    if (typeof request.workspaceRoot !== "string" || request.workspaceRoot.length === 0)
      failWith("InvalidInput", "Verification backend requires a workspace root.");
    const engine = await this.#requireReady(request.signal);
    const started = performance.now();
    let dependencies: LeaseState["dependencies"] = null;
    const requirement = request.dependencies ?? { kind: "none" as const };
    if (requirement.kind === "npm-lockfile") {
      const { report } = await this.#manifests(request.workspaceRoot, requirement);
      const identity = this.#identityFor(engine, report, requirement.acknowledgedInstallScripts);
      const found = await this.#store.lookup(identity);
      if (found.state === "miss")
        failClassified("CapabilityUnavailable", "Dependency lane: no prepared artifact for this approved identity; run dependency preparation first.",
          "dependencyLaneFailure");
      if (found.state === "invalid")
        failClassified("SecurityViolation", `Dependency lane: the cached artifact failed validation (${found.reason}) and was ${found.evicted ? "evicted" : "left in place"}.`,
          "dependencyLaneFailure");
      dependencies = Object.freeze({ key: dependencyIdentityKey(identity), artifact: found.artifact });
    }
    const source = await candidateSourcePart(request.workspaceRoot);
    const bundle = await loadGuestBundle();
    const limits = limitsForDependencies(this.#limits, dependencies?.artifact.record.artifact.bytes ?? 0);
    const lease: VerificationLease = Object.freeze({ backendId: this.id, confinement: this.confinement,
      workspaceRoot: request.workspaceRoot });
    this.#leases.set(lease, { runId: hex(16), nonce: hex(16), createdAt: new Date().toISOString(), commands, plan: request.plan,
      engine, bundle, source, dependencies, limits, prepareMs: elapsed(started), containers: new Set(), created: new Set(),
      limitsById: new Map(), inspections: [], ran: false, evidenceCollected: false });
    return lease;
  }

  #state(lease: VerificationLease): LeaseState {
    const state = this.#leases.get(lease);
    if (state === undefined) failWith("InvalidInput", "Unknown Docker verification lease.");
    return state;
  }

  run(lease: VerificationLease, request: VerificationExecutionRequest): Promise<DockerVerificationExecutionResult> {
    const state = this.#state(lease);
    if (state.ran) failWith("InvalidInput", "A Docker verification lease runs exactly once.");
    state.ran = true;
    ACTIVE_DOCKER_RUNS.add(state.runId);
    const work = this.#verify(state, request);
    state.inflight = work.then(() => undefined, () => undefined);
    return work;
  }

  async #create(state: Pick<LeaseState, "runId" | "createdAt" | "containers" | "created" | "limitsById">, mode: GuestMode,
    bundleSha256: string, manifestSha256: string, limits: DockerResourceLimits): Promise<string> {
    const runner = this.#requireRunner();
    const args = buildCreateArgs({ runId: state.runId, mode, image: this.#image, limits, env: CONTAINER_VERIFIER_ENV,
      createdAt: state.createdAt, bundleSha256, manifestSha256 });
    const outcome = await runner.run({ args, timeoutMs: 60_000, maxStdoutBytes: 4096 });
    if (outcome.status !== "exited" || outcome.exitCode !== 0) failWith("ProcessFailure", "Docker container could not be created.");
    const id = outcome.stdout.trim();
    if (!CONTAINER_ID.test(id)) failWith("MalformedOutput", "Docker returned an invalid container id.");
    state.containers.add(id);
    state.created.add(id);
    state.limitsById.set(id, limits);
    return id;
  }

  async #inspect(state: Pick<LeaseState, "inspections">, id: string): Promise<ContainerInspection> {
    const outcome = await requireExited(this.#requireRunner(), { args: ["container", "inspect", "--format", "{{json .}}", id],
      timeoutMs: 20_000, maxStdoutBytes: 512 * 1024 }, "inspect");
    const inspection = parseContainerInspect(outcome.stdout);
    if (inspection === undefined || inspection.id !== id) failWith("MalformedOutput", "Docker container inspection is malformed.");
    state.inspections.push(inspection);
    return inspection;
  }

  /** Best-effort stop of a container this lease created; state is re-read from the daemon afterwards. */
  async #kill(state: Pick<LeaseState, "created">, id: string): Promise<void> {
    if (!state.created.has(id)) failWith("SecurityViolation", "Refused to stop a container this run did not create.");
    await this.#requireRunner().run({ args: ["kill", id], timeoutMs: 20_000, maxStdoutBytes: 4096 });
  }

  /** Ownership-scoped removal (all Fusion labels for THIS run, re-read from the daemon), confirmed by "no such container". */
  async #remove(state: Pick<LeaseState, "runId" | "containers">, id: string): Promise<boolean> {
    const removed = await removeOwned(this.#requireRunner(), id, state.runId);
    if (removed) state.containers.delete(id);
    return removed;
  }

  /** Every container still labelled with this run id, found by label (never by name) and removed only if owned. */
  async #sweep(state: Pick<LeaseState, "runId" | "containers">): Promise<number> {
    const listed = await requireExited(this.#requireRunner(), { args: ["ps", "--all", "--no-trunc", "--filter",
      `label=${OWNER_LABELS.run}=${state.runId}`, "--format", "{{.ID}}"], timeoutMs: 20_000, maxStdoutBytes: 64 * 1024 }, "list");
    const ids = listed.stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== "");
    if (!ids.every(id => CONTAINER_ID.test(id))) failWith("MalformedOutput", "Docker container listing is malformed.");
    let remaining = 0;
    for (const id of ids) if (!await this.#remove(state, id)) remaining++;
    return remaining;
  }

  /** Starts an attached, stdin-fed container and always leaves it stopped, inspected and removed (or tracked). */
  async #attached(state: Pick<LeaseState, "runId" | "containers" | "created" | "inspections">, id: string, input: DockerInput,
    options: Readonly<{ timeoutMs: number; maxStdoutBytes: number; signal?: AbortSignal; onStdoutLine?: (line: string) => void }>):
    Promise<Readonly<{ attach: DockerOutcome; inspection: ContainerInspection | undefined; attachMs: number; inspectMs: number;
      removeMs: number }>> {
    const runner = this.#requireRunner();
    let attach: DockerOutcome | undefined, inspection: ContainerInspection | undefined;
    let attachMs = 0, inspectMs = 0, removeMs = 0, mark = performance.now();
    try {
      attach = await runner.run({ args: ["start", "--attach", "--interactive", id], timeoutMs: options.timeoutMs,
        maxStdoutBytes: options.maxStdoutBytes, input, ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onStdoutLine ? { onStdoutLine: options.onStdoutLine } : {}) });
      attachMs = elapsed(mark);
      // Killing the attached client never stops a container; the host stops it explicitly.
      if (attach.status !== "exited") await this.#kill(state, id);
      mark = performance.now();
      inspection = await this.#inspect(state, id).catch(() => undefined);
      inspectMs = elapsed(mark);
    } finally {
      mark = performance.now();
      await this.#remove(state, id).catch(() => false);
      removeMs = elapsed(mark);
    }
    return { attach, inspection, attachMs, inspectMs, removeMs };
  }

  async #verify(state: LeaseState, request: VerificationExecutionRequest): Promise<DockerVerificationExecutionResult> {
    const started = performance.now(), startedAt = new Date().toISOString();
    const redactor = DiagnosticRedactor.fromEnvironment(request.env);
    const timing = { createMs: 0, attachMs: 0, inspectMs: 0, removeMs: 0, started };
    if (request.signal?.aborted) return this.#result(state, redactor, startedAt, { kind: "cancelled" }, timing);
    const dependencyPart = state.dependencies?.artifact.part ?? null;
    const manifest: VerifyManifest = { protocolVersion: DOCKER_PROTOCOL_VERSION, mode: "verify", nonce: state.nonce,
      env: buildContainerVerifierEnvironment().env as Record<string, string>,
      limits: { stdoutTailBytes: DOCKER_RESULT_LIMITS.stdoutTailBytes, stderrTailBytes: DOCKER_RESULT_LIMITS.stderrTailBytes },
      input: { source: { sha256: state.source.part.sha256, bytes: state.source.part.bytes, limits: state.source.part.limits },
        dependencies: dependencyPart === null ? null : { sha256: dependencyPart.sha256, bytes: dependencyPart.bytes,
          limits: dependencyPart.limits, compressed: "gzip" } },
      commands: state.commands };
    const frame = manifestFrame(manifest);
    const input = containerInput(state.bundle, frame, dependencyPart === null ? [state.source.part] : [state.source.part, dependencyPart]);
    const deadlineMs = state.commands.reduce((sum, command) => sum + command.timeoutMs, 0) + this.#allowanceMs +
      transferAllowanceMs(input.bytes);
    let mark = performance.now();
    const id = await this.#create(state, "verify", state.bundle.sha256, frame.sha256, state.limits);
    timing.createMs = elapsed(mark);
    const run = await this.#attached(state, id, input, { timeoutMs: deadlineMs,
      maxStdoutBytes: DOCKER_RESULT_LIMITS.maxResultBytes + 1, ...(request.signal ? { signal: request.signal } : {}) });
    Object.assign(timing, { attachMs: run.attachMs, inspectMs: run.inspectMs, removeMs: run.removeMs });
    const { attach, inspection } = run;
    if (attach.status === "cancelled" || (attach.status !== "exited" && request.signal?.aborted))
      return this.#result(state, redactor, startedAt, { kind: "cancelled" }, timing, inspection);
    if (attach.status === "timeout")
      return this.#result(state, redactor, startedAt, { kind: "failure", failure: { kind: "Timeout", retryable: true,
        safeMessage: "Docker verification exceeded its host deadline; the container was stopped." } }, timing, inspection);
    if (attach.status === "outputLimit")
      return this.#result(state, redactor, startedAt, { kind: "rejected", rejection: "Docker guest result exceeded its size bound." },
        timing, inspection);
    if (attach.status !== "exited" || inspection === undefined)
      return this.#result(state, redactor, startedAt, { kind: "failure", failure: { kind: "ProcessFailure",
        retryable: false, safeMessage: "Docker verification container could not be run." } }, timing, inspection);
    if (inspection.oomKilled)
      return this.#result(state, redactor, startedAt, { kind: "failure", failure: { kind: "ProcessFailure",
        retryable: false, safeMessage: "Docker verification exceeded its memory limit." } }, timing, inspection);
    if (input.mismatch())
      return this.#result(state, redactor, startedAt, { kind: "rejected",
        rejection: "The candidate changed while it was streamed into the container." }, timing, inspection);
    // A runner that failed before producing a result reports only a stable code on stderr; nothing else is surfaced.
    const runnerError = attach.stdout.trim() === "" ? /^fusion-runner-error:([a-z0-9-]{1,40})$/mu.exec(attach.stderr)?.[1] : undefined;
    if (runnerError !== undefined)
      return this.#result(state, redactor, startedAt, { kind: "rejected",
        rejection: `Docker guest runner failed before producing a result (${runnerError}).` }, timing, inspection);
    let result: VerifyResult;
    try {
      result = decodeVerifyResult(attach.stdout, { nonce: state.nonce, commands: state.commands, hostElapsedMs: run.attachMs,
        input: { sourceSha256: state.source.part.sha256, dependencySha256: dependencyPart?.sha256 ?? null } });
    } catch (error) {
      if (!(error instanceof FusionFailure)) throw error;
      return this.#result(state, redactor, startedAt, { kind: "rejected", rejection: error.error.safeMessage }, timing, inspection);
    }
    state.inputDigestMatched = true;
    state.runtime = result.runtime;
    if (result.runtime.platform !== "linux" || (this.#expectedNode !== undefined && result.runtime.node !== this.#expectedNode))
      return this.#result(state, redactor, startedAt, { kind: "rejected",
        rejection: "Docker guest runtime identity does not match the pinned runtime." }, timing, inspection);
    // Cross-check with a daemon-observed fact: the runner exits 0 exactly when every command passed.
    const allPassed = result.notRun.length === 0 && result.commands.every(entry => entry.status === "exited" && entry.exitCode === 0);
    if (inspection.exitCode !== (allPassed ? 0 : 1))
      return this.#result(state, redactor, startedAt, { kind: "rejected",
        rejection: "Docker guest result contradicts the daemon-observed container exit status." }, timing, inspection);
    return this.#result(state, redactor, startedAt, { kind: "accepted", result }, timing, inspection);
  }

  #result(state: LeaseState, redactor: DiagnosticRedactor, startedAt: string,
    outcome: Readonly<{ kind: "cancelled" }> | Readonly<{ kind: "failure"; failure: FusionError }> |
      Readonly<{ kind: "rejected"; rejection: string }> | Readonly<{ kind: "accepted"; result: VerifyResult }>,
    timing: Readonly<{ createMs: number; attachMs: number; inspectMs: number; removeMs: number; started: number }>,
    inspection?: ContainerInspection): DockerVerificationExecutionResult {
    const planById = new Map(state.plan.commands.map(command => [command.id, command]));
    const allIds = state.commands.map(command => command.id);
    const accepted = outcome.kind === "accepted" ? outcome.result : undefined;
    // The container can reach no host path, so the host candidate cannot change; "proven" means the guest ran on
    // exactly the input the host streamed (digest-bound).
    const inputProven = state.inputDigestMatched === true;
    const steps: VerificationStepResult[] = (accepted?.commands ?? []).map(entry => {
      const command = planById.get(entry.id)!;
      let status: VerificationStepStatus = entry.status === "timeout" ? "timeout" : entry.status === "spawnError" ? "spawnFailure"
        : entry.exitCode === 0 ? "passed" : "failed";
      if (!inputProven) status = "mutationViolation";
      const failure = stepFailure(status, entry.id, entry.exitCode);
      const base = { commandId: entry.id, executable: command.executable, args: command.args.map(arg => redactor.redactText(arg)),
        cwd: command.cwd, startedAt, durationMs: entry.durationMs, stdoutArtifact: "", stderrArtifact: "", preDiffArtifact: "",
        postDiffArtifact: "", mutatedRepository: false, status, mutationPolicy: command.mutationPolicy, mutations: [],
        mutationProven: inputProven, stdoutTruncated: entry.stdoutBytes > DOCKER_RESULT_LIMITS.stdoutTailBytes,
        stderrTruncated: entry.stderrBytes > DOCKER_RESULT_LIMITS.stderrTailBytes };
      return status === "passed" ? { ...base, passed: true as const, exitCode: 0 as const }
        : { ...base, passed: false as const, exitCode: entry.exitCode, ...(failure ? { failure } : {}) };
    });
    let report: VerificationReport;
    if (outcome.kind === "accepted") {
      const failed = steps.find(step => step.status !== "passed");
      report = failed === undefined && steps.length === allIds.length
        ? { passed: true, status: "passed", steps, notRun: [] }
        : { passed: false, status: "failed", steps, notRun: [...accepted!.notRun], failure: failed?.failure ??
          { kind: "VerificationFailure", retryable: false, safeMessage: "Docker verification did not run every command." } };
    } else if (outcome.kind === "cancelled") {
      report = { passed: false, status: "cancelled", steps: [], notRun: allIds,
        failure: { kind: "Cancelled", retryable: false, safeMessage: "Docker verification was cancelled." } };
    } else {
      report = { passed: false, status: "failed", steps: [], notRun: allIds, failure: outcome.kind === "failure" ? outcome.failure
        : { kind: "MalformedOutput", retryable: false, safeMessage: outcome.rejection } };
    }
    const guestCommandsMs = accepted ? accepted.commands.reduce((sum, entry) => sum + entry.durationMs, 0) : null;
    const artifact = state.dependencies?.artifact.record.artifact;
    const docker: DockerRunObservation = Object.freeze({
      runId: state.runId, runnerSha256: state.bundle.runnerSha256, bundleSha256: state.bundle.sha256,
      source: Object.freeze({ ...state.source.stats, archiveSha256: state.source.part.sha256, archiveBytes: state.source.part.bytes }),
      dependencies: state.dependencies === null ? null : Object.freeze({ key: state.dependencies.key, sha256: artifact!.sha256,
        compressedBytes: artifact!.compressedBytes, entries: artifact!.entries }),
      limits: state.limits, containerExitCode: inspection?.exitCode ?? null, oomKilled: inspection?.oomKilled ?? false,
      resultAccepted: accepted !== undefined, ...(outcome.kind === "rejected" ? { rejection: outcome.rejection } : {}),
      runtime: accepted?.runtime ?? null,
      steps: Object.freeze((accepted?.commands ?? []).map(entry => Object.freeze({ id: entry.id, stdoutTail: entry.stdoutTail,
        stderrTail: entry.stderrTail, testCounts: parseTestCounts(entry.stdoutTail) }))),
      timings: Object.freeze({ prepareMs: state.prepareMs, createMs: timing.createMs, attachMs: timing.attachMs,
        inputMs: accepted?.input.durationMs ?? null, commandsMs: guestCommandsMs, inspectMs: timing.inspectMs,
        removeMs: timing.removeMs, totalMs: elapsed(timing.started) }),
    });
    return { backendId: this.id, confinement: this.confinement, report, passed: report.passed, docker };
  }

  /** Docker produces no Windows-shaped `ConfinementProof`; its observations are `collectEvidence`'s narrow facts. */
  collectProof(): Promise<undefined> { return Promise.resolve(undefined); }

  // ---------------------------------------------------------------- dependency preparation (stage 1)

  /**
   * STAGE 1 of the dependency lane, explicit and separate from verification. For an approved, eligible npm project it
   * returns the cached artifact after full validation, or prepares one: a fresh hardened container (same controls as
   * verification, but on Docker's default bridge network) receives ONLY `package.json` and `package-lock.json` over
   * stdin, runs the pinned image's npm with the fixed `npm ci --ignore-scripts --no-bin-links …` argv, and streams the
   * resulting `node_modules` back as a gzip FTA1 archive. No repository code is present, no lifecycle script runs, and
   * no credential or host path enters. The artifact is validated and committed immutably under its identity key.
   */
  async prepareDependencies(request: DependencyPreparationRequest): Promise<DependencyPreparationReport> {
    if (request.dependencies?.kind !== "npm-lockfile")
      failWith("InvalidInput", "Dependency preparation needs an npm-lockfile requirement.");
    const engine = await this.#requireReady(request.signal);
    const { report, manifests } = await this.#manifests(request.workspaceRoot, request.dependencies);
    const identity = this.#identityFor(engine, report, request.dependencies.acknowledgedInstallScripts);
    const key = dependencyIdentityKey(identity);
    const existing = await this.#store.lookup(identity);
    if (existing.state === "hit") return Object.freeze({ key, identity, cacheHit: true, record: existing.artifact.record, manifests: report });
    const started = performance.now();
    const state = { runId: hex(16), createdAt: new Date().toISOString(), containers: new Set<string>(), created: new Set<string>(),
      limitsById: new Map<string, DockerResourceLimits>(), inspections: [] as ContainerInspection[] };
    const nonce = hex(16);
    const outputLimits = DEPENDENCY_ARTIFACT_LIMITS;
    const inputPart = await memoryPart({ "package.json": manifests.packageJson, "package-lock.json": manifests.lockfile },
      { maxEntries: 2, maxFileBytes: 32 * MIB, maxTotalBytes: 40 * MIB });
    const manifest: DependencyManifest = { protocolVersion: DOCKER_PROTOCOL_VERSION, mode: "deps", nonce,
      input: { sha256: inputPart.sha256, bytes: inputPart.bytes, limits: inputPart.limits }, npmArgs: NPM_CI_ARGS,
      npmTimeoutMs: this.#dependencyTimeoutMs, output: { limits: outputLimits, maxCompressedBytes: MAX_COMPRESSED_ARTIFACT_BYTES },
      limits: { stdoutTailBytes: DOCKER_RESULT_LIMITS.stdoutTailBytes, stderrTailBytes: DOCKER_RESULT_LIMITS.stderrTailBytes } };
    const bundle = await loadGuestBundle();
    const frame = manifestFrame(manifest);
    const staging = await this.#store.stage();
    ACTIVE_DOCKER_RUNS.add(state.runId);
    const fd = openSync(this.#store.artifactPath(staging), "wx");
    let fdOpen = true;
    try {
      const hash = createHash("sha256");
      let written = 0, resultLine: string | undefined, violation: string | undefined;
      const onStdoutLine = (line: string): void => {
        if (violation !== undefined) return;
        if (resultLine !== undefined) { violation = "output after the result"; return; }
        if (line.startsWith("D ")) {
          const payload = line.slice(2);
          if (payload.length % 4 !== 0 || !BASE64_LINE.test(payload)) { violation = "malformed artifact frame"; return; }
          const bytes = Buffer.from(payload, "base64");
          written += bytes.length;
          if (written > MAX_COMPRESSED_ARTIFACT_BYTES) { violation = "artifact exceeds its bound"; return; }
          hash.update(bytes);
          writeSync(fd, bytes);
        } else if (line.startsWith("R ")) resultLine = line.slice(2);
        else if (line !== "") violation = "unexpected output line";
      };
      let mark = performance.now();
      const id = await this.#create(state, "deps", bundle.sha256, frame.sha256, DEPENDENCY_PREPARATION_LIMITS);
      const createMs = elapsed(mark);
      const run = await this.#attached(state, id, containerInput(bundle, frame, [inputPart]), {
        timeoutMs: this.#dependencyTimeoutMs + this.#allowanceMs + transferAllowanceMs(MAX_COMPRESSED_ARTIFACT_BYTES / 8),
        maxStdoutBytes: Math.ceil(MAX_COMPRESSED_ARTIFACT_BYTES * 4 / 3) + 2 * MIB, onStdoutLine,
        ...(request.signal ? { signal: request.signal } : {}) });
      closeSync(fd); fdOpen = false;
      const { attach, inspection } = run;
      if (attach.status === "timeout") failWith("Timeout", "Dependency preparation exceeded its deadline; the container was stopped.");
      if (attach.status === "cancelled") failWith("Cancelled", "Dependency preparation was cancelled.");
      if (attach.status !== "exited" || inspection === undefined) failWith("ProcessFailure", "Dependency preparation container could not be run.");
      if (inspection.oomKilled) failWith("ProcessFailure", "Dependency preparation exceeded its memory limit.");
      if (violation !== undefined) failWith("MalformedOutput", `Dependency preparation output was rejected (${violation}).`);
      const runnerError = resultLine === undefined ? /^fusion-runner-error:([a-z0-9-]{1,40})$/mu.exec(attach.stderr)?.[1] : undefined;
      if (runnerError !== undefined) failWith("CapabilityUnavailable", `Dependency preparation failed (${runnerError}).`);
      const result = decodeDependencyResult(resultLine, { nonce, inputSha256: inputPart.sha256, npmTimeoutMs: this.#dependencyTimeoutMs,
        maxCompressedBytes: MAX_COMPRESSED_ARTIFACT_BYTES, limits: outputLimits });
      this.#lastNpm = Object.freeze({ version: result.npm.version, exitCode: result.npm.exitCode, timedOut: result.npm.timedOut,
        stdoutTail: result.npm.stdoutTail, stderrTail: result.npm.stderrTail });
      if (inspection.exitCode !== (result.artifact === null ? 1 : 0))
        failWith("MalformedOutput", "Dependency preparation result contradicts the daemon-observed exit status.");
      if (result.artifact === null)
        failWith("CapabilityUnavailable", `Dependency preparation failed: npm ${result.npm.timedOut ? "timed out" : `exited with code ${result.npm.exitCode ?? "none"}`}.`);
      if (result.runtime.platform !== "linux" || (this.#expectedNode !== undefined && result.runtime.node !== this.#expectedNode))
        failWith("SecurityViolation", "Dependency preparation ran on an unexpected runtime.");
      if (written !== result.artifact.compressedBytes || hash.digest("hex") !== result.artifact.sha256)
        failWith("MalformedOutput", "Dependency artifact bytes do not match the guest's declared digest.");
      mark = performance.now();
      const record: DependencyArtifactRecord = { schemaVersion: 1, key, identity,
        artifact: { sha256: result.artifact.sha256, compressedBytes: result.artifact.compressedBytes, entries: result.artifact.entries,
          files: result.artifact.files, directories: result.artifact.directories, bytes: result.artifact.bytes },
        observed: { node: result.runtime.node, npm: result.npm.version, lifecycleScriptsExecuted: false,
          installScriptPackagesSkipped: report.installScriptPackages, rootScriptsSkipped: report.skippedRootScripts },
        preparedAt: new Date().toISOString() };
      await this.#store.commit(staging, record);
      const validateMs = elapsed(mark);
      const committed = await this.#store.lookup(identity);
      if (committed.state !== "hit") failWith("SecurityViolation", "The committed dependency artifact failed validation.");
      return Object.freeze({ key, identity, cacheHit: false, record: committed.artifact.record, manifests: report,
        preparation: Object.freeze({ runId: state.runId, network: networkFor("deps") as "bridge", npmMs: result.npm.durationMs,
          createMs, attachMs: run.attachMs, validateMs, removeMs: run.removeMs, totalMs: elapsed(started) }) });
    } finally {
      if (fdOpen) closeSync(fd);
      await this.#store.discard(staging);
      for (const id of [...state.containers]) await this.#remove(state, id).catch(() => false);
      await this.#sweep(state).catch(() => -1);
      ACTIVE_DOCKER_RUNS.delete(state.runId);
    }
  }

  // ---------------------------------------------------------------- evidence

  /**
   * Runs Fusion-authored probes in fresh containers with the identical hardened configuration — no repository code —
   * and returns narrow observed facts from three sources: daemon metadata of every container this lease created, the
   * guest canary, and host-side lifecycle checks. Observation only: it never decides acceptance or readiness.
   */
  async collectEvidence(lease: VerificationLease, options: DockerEvidenceOptions = {}): Promise<BackendEvidence> {
    const state = this.#state(lease);
    if (state.evidenceCollected) failWith("InvalidInput", "Docker evidence is collected once per lease.");
    state.evidenceCollected = true;
    ACTIVE_DOCKER_RUNS.add(state.runId);
    const dirs = await createRunDirectories(state.runId, this.#base);
    state.evidenceDirectories = dirs;
    const siblingMarker = `${CANARY_VALUE_PREFIX}${hex(16)}.txt`;
    await writeFile(join(dirs.privateSibling, siblingMarker), "synthetic host-private marker", { flag: "wx" });
    const markers = [siblingMarker, ...(options.absentMarkerNames ?? [])];
    if (markers.length > 32 || !markers.every(name => MARKER_NAME.test(name)))
      failWith("InvalidInput", "Evidence marker names must be synthetic fusion-canary names.");
    const hangDeadlineMs = options.hangDeadlineMs ?? 2_000;
    if (!Number.isSafeInteger(hangDeadlineMs) || hangDeadlineMs < 500 || hangDeadlineMs > 60_000)
      failWith("InvalidInput", "Evidence deadline is out of range.");
    const ready = state.engine;
    const facts: BackendEvidenceFact[] = [checkFact("linuxEngineObserved", "daemon", ready.server.os === "linux")];
    const started = performance.now();
    let mark = started;
    const canary = await this.#canary(state, markers, [basename(dirs.runRoot)]);
    const canaryMs = elapsed(mark);
    mark = performance.now();
    const descendant = await this.#descendant(state, `fusion-descendant-${hex(16)}`);
    const descendantMs = elapsed(mark);
    mark = performance.now();
    const deadline = await this.#deadline(state, hangDeadlineMs);
    const deadlineMs = elapsed(mark);

    facts.push(...this.#daemonFacts(state));
    facts.push(...guestFacts(canary, this.#limits, this.#expectedNode));
    facts.push(state.inputDigestMatched === undefined ? unobservedFact("verifyInputDigestMatchedObserved", "host")
      : checkFact("verifyInputDigestMatchedObserved", "host", state.inputDigestMatched));
    facts.push(checkFact("descendantRemovedWithContainerObserved", "host", descendant));
    facts.push(checkFact("hostDeadlineTerminationObserved", "host", deadline));
    mark = performance.now();
    const remaining = await this.#sweep(state).catch(() => -1);
    facts.push(checkFact("ownedContainersRemovedObserved", "host", remaining === 0 && state.containers.size === 0));
    state.evidenceDetail = Object.freeze({ canary, timings: Object.freeze({ canaryMs, descendantMs, deadlineMs,
      sweepMs: elapsed(mark), totalMs: elapsed(started) }) });
    const evidence = backendEvidence(this.id, facts);
    OBSERVED_EVIDENCE.set(evidence, Object.freeze({ backend: this, server: ready.server, image: ready.image, imageReference: this.#image,
      runtime: canary?.runtime ?? null, observedAt: new Date().toISOString() }));
    return evidence;
  }

  evidenceDetail(lease: VerificationLease): DockerEvidenceDetail | undefined { return this.#state(lease).evidenceDetail; }

  async #canary(state: LeaseState, markers: readonly string[], mountinfoForbidden: readonly string[]): Promise<CanaryResult | undefined> {
    const nonce = hex(16), readableToken = `fusion-readable-${hex(16)}`;
    const part = await memoryPart({ "canary/readable.txt": Buffer.from(readableToken) }, { maxEntries: 4, maxFileBytes: 4096, maxTotalBytes: 4096 });
    const manifest: CanaryManifest = { protocolVersion: DOCKER_PROTOCOL_VERSION, mode: "canary", nonce,
      input: { sha256: part.sha256, bytes: part.bytes, limits: part.limits }, readableToken, absentMarkerNames: markers,
      mountinfoForbidden: [...mountinfoForbidden, "/run/desktop/mnt/host", "/host_mnt"],
      forbiddenEnvKeys: FORBIDDEN_ENV_KEYS, forbiddenEnvPrefixes: FORBIDDEN_ENV_PREFIXES, canaryValuePrefix: CANARY_VALUE_PREFIX,
      dnsNames: ["example.com", "host.docker.internal"],
      connectTargets: [{ host: "1.1.1.1", port: 443 }, { host: "8.8.8.8", port: 53 }, { host: "192.168.65.254", port: 80 }],
      pidProbeMax: this.#limits.pids + 16, allowedDevices: ALLOWED_DEVICES, walkMaxEntries: 500_000 };
    const frame = manifestFrame(manifest);
    const id = await this.#create(state, "canary", state.bundle.sha256, frame.sha256, this.#limits);
    const { attach } = await this.#attached(state, id, containerInput(state.bundle, frame, [part]), { timeoutMs: 120_000,
      maxStdoutBytes: DOCKER_RESULT_LIMITS.maxResultBytes + 1 });
    if (attach.status !== "exited" || attach.exitCode !== 0) return undefined;
    try { return decodeCanaryResult(attach.stdout, nonce); }
    catch (error) { if (error instanceof FusionFailure) return undefined; throw error; }
  }

  /**
   * A marked sleeping descendant is observed in the container's process list by the daemon; the container is then
   * killed (its init exits, so the PID namespace is torn down), observed stopped, and removed. Narrow claim: the
   * daemon listed the descendant while running, reported the container stopped, and then no longer knew it.
   */
  async #descendant(state: LeaseState, marker: string): Promise<boolean> {
    const runner = this.#requireRunner();
    const manifest: DescendantManifest = { protocolVersion: DOCKER_PROTOCOL_VERSION, mode: "descendant", nonce: hex(16),
      descendantMarker: marker };
    const frame = manifestFrame(manifest);
    const id = await this.#create(state, "descendant", state.bundle.sha256, frame.sha256, this.#limits);
    const attach = runner.run({ args: ["start", "--attach", "--interactive", id], timeoutMs: 120_000, maxStdoutBytes: 4096,
      input: containerInput(state.bundle, frame, []) });
    try {
      let seen = false;
      for (let attempt = 0; attempt < 40 && !seen; attempt++) {
        const top = await runner.run({ args: ["top", id, "-o", "pid,args"], timeoutMs: 15_000, maxStdoutBytes: 64 * 1024 });
        seen = top.status === "exited" && top.exitCode === 0 && top.stdout.split(/\r?\n/u).some(line => line.includes(marker));
        if (!seen) await delay(250);
      }
      await this.#kill(state, id);
      await attach;
      const stopped = !(await this.#inspect(state, id)).running;
      const topStopped = await runner.run({ args: ["top", id], timeoutMs: 15_000, maxStdoutBytes: 64 * 1024 });
      const removed = await this.#remove(state, id);
      const topAfter = await runner.run({ args: ["top", id], timeoutMs: 15_000, maxStdoutBytes: 4096 });
      return seen && stopped && topStopped.exitCode !== 0 && removed && isNoSuchObject(topAfter);
    } finally {
      await attach.catch(() => undefined);
      if (state.containers.has(id)) await this.#remove(state, id).catch(() => false);
    }
  }

  /** A never-ending guest must be stopped by the HOST at its deadline, and the container must then be removable. */
  async #deadline(state: LeaseState, deadlineMs: number): Promise<boolean> {
    const runner = this.#requireRunner();
    const id = await this.#create(state, "hang", state.bundle.sha256, ZERO_SHA256, this.#limits);
    try {
      await requireExited(runner, { args: ["start", id], timeoutMs: 60_000, maxStdoutBytes: 4096 }, "start");
      const wait = await runner.run({ args: ["wait", id], timeoutMs: deadlineMs, maxStdoutBytes: 1024 });
      await this.#kill(state, id);
      const stopped = !(await this.#inspect(state, id)).running;
      return wait.status === "timeout" && stopped && await this.#remove(state, id);
    } finally { if (state.containers.has(id)) await this.#remove(state, id).catch(() => false); }
  }

  #daemonFacts(state: LeaseState): BackendEvidenceFact[] {
    const inspections = state.inspections;
    const allowedEnv = new Set([...Object.keys(CONTAINER_VERIFIER_ENV), ...state.engine.image.envKeys]);
    const checks: readonly (readonly [string, (i: ContainerInspection) => boolean])[] = [
      ["pinnedImageObserved", i => i.image === state.engine.image.id],
      ["privilegedDisabledObserved", i => !i.privileged],
      ["capDropAllObserved", i => i.capDrop.length === 1 && i.capDrop[0]!.toUpperCase() === "ALL" && i.capAdd.length === 0],
      ["noNewPrivilegesOptionObserved", i => i.securityOpt.some(option => /^no-new-privileges(?:[=:]true)?$/u.test(option))],
      ["defaultConfinementProfilesKeptObserved", i =>
        !i.securityOpt.some(option => /unconfined|label[=:]disable/iu.test(option)) && i.maskedPathCount > 0],
      ["readOnlyRootfsObserved", i => i.readonlyRootfs],
      ["nonRootUserConfiguredObserved", i => i.user === GUEST_USER],
      ["networkModeNoneObserved", i => i.networkMode === "none"],
      ["hostNamespacesNotSharedObserved", i => i.pidMode === "" && i.ipcMode === "private" && i.utsMode === "" &&
        i.usernsMode === "" && i.cgroupnsMode === "private" && i.networkMode === "none"],
      ["noDevicesObserved", i => i.deviceCount === 0],
      ["noHostMountsObserved", i => i.mounts.length === 0 && i.bindCount === 0],
      ["noWritableHostMountObserved", i => i.mounts.every(mount => mount.type === "tmpfs" || (mount.type === "bind" && !mount.rw))],
      ["noDockerSocketMountObserved", i => i.mounts.every(mount => !/docker\.sock/iu.test(`${mount.source} ${mount.destination}`))],
      ["tmpfsScratchOnlyObserved", i => i.tmpfsTargets.join(",") === [GUEST_PATHS.work, GUEST_PATHS.tmp].sort().join(",")],
      ["stdinInputChannelObserved", i => i.openStdin],
      ["resourceLimitsConfiguredObserved", i => {
        const expected = state.limitsById.get(i.id);
        return expected !== undefined && i.memory === expected.memoryBytes && i.memorySwap === expected.memoryBytes &&
          i.nanoCpus === expected.nanoCpus && i.pidsLimit === expected.pids;
      }],
      ["ownershipLabelsObserved", i => isFusionOwned(i.labels, state.runId)],
      ["logDriverNoneObserved", i => i.logType === "none"],
      ["initReaperObserved", i => i.init],
      ["containerEnvKeysAllowlistedObserved", i => i.envKeys.every(key => allowedEnv.has(key))],
    ];
    // One attempt per inspected container: a fact passes only if it held for every container this lease created.
    return checks.map(([fact, holds]) =>
      observedFact(fact, "daemon", inspections.length, inspections.filter(inspection => !holds(inspection)).length));
  }

  async dispose(lease: VerificationLease): Promise<VerificationCleanupResult> {
    const state = this.#leases.get(lease);
    if (state === undefined) return { complete: false, reason: "unknown Docker verification lease" };
    if (state.inflight !== undefined) {
      // Bounded wait for an aborted run to finish its own kill/remove; the timer never outlives the wait.
      const bound = new AbortController();
      await Promise.race([state.inflight, delay(90_000, undefined, { signal: bound.signal }).catch(() => undefined)]);
      bound.abort();
    }
    const reasons: string[] = [];
    try {
      if (state.created.size > 0 || state.containers.size > 0) {
        for (const id of [...state.containers]) await this.#remove(state, id).catch(() => false);
        const remaining = await this.#sweep(state);
        if (remaining > 0 || state.containers.size > 0) reasons.push("an owned container could not be removed");
      }
    } catch { reasons.push("owned containers could not be verified removed"); }
    if (state.evidenceDirectories !== undefined &&
        !await removeRunDirectories(state.evidenceDirectories, state.runId, this.#base).catch(() => false))
      reasons.push("the evidence directory could not be removed");
    if (reasons.length === 0) { this.#leases.delete(lease); ACTIVE_DOCKER_RUNS.delete(state.runId); }
    return reasons.length === 0 ? { complete: true } : { complete: false, reason: reasons.join("; ") };
  }
}

function stepFailure(status: VerificationStepStatus, id: string, exitCode: number | null): FusionError | undefined {
  switch (status) {
    case "passed": return undefined;
    case "failed": return { kind: "VerificationFailure", safeMessage: `Verification command ${id} exited with code ${exitCode}.`, retryable: false };
    case "timeout": return { kind: "Timeout", safeMessage: `Verification command ${id} exceeded its deadline.`, retryable: true };
    case "spawnFailure": return { kind: "SpawnFailure", safeMessage: `Verification command ${id} could not start.`, retryable: false };
    case "mutationViolation": return { kind: "SecurityViolation",
      safeMessage: `The verified input of command ${id} could not be proven to be the streamed candidate.`, retryable: false };
    default: return { kind: "ProcessFailure", safeMessage: `Verification command ${id} failed at the process level.`, retryable: false };
  }
}

const GUEST_FACTS = Object.freeze(["guestNonRootObserved", "guestNoNewPrivsObserved", "guestSeccompFilterObserved",
  "guestCapabilitySetsEmptyObserved", "transferredInputReadObserved", "transferDigestObserved", "rootfsWriteDeniedObserved",
  "scratchWriteObserved", "mountTableHostPathAbsentObserved", "hostMarkersNotFoundObserved", "credentialEnvMarkersAbsentObserved",
  "gitSshCredentialPathsAbsentObserved", "dockerSocketAbsentObserved", "loopbackOnlyInterfacesObserved",
  "canaryConnectionsFailedObserved", "cgroupLimitsObserved", "pidLimitEnforcedObserved",
  "unexpectedDevicesAbsentObserved", "yamaPtraceRestrictedObserved", "guestRuntimeIdentityObserved"]);

/** Guest-observed facts from the Fusion-only canary container; an absent or rejected canary observes nothing. */
export function guestFacts(canary: CanaryResult | undefined, limits: DockerResourceLimits, expectedNode?: string): BackendEvidenceFact[] {
  if (canary === undefined) return GUEST_FACTS.map(fact => unobservedFact(fact, "guest"));
  const { identity, filesystem, mounts, markers, credentials, dockerSocket, network, resources, devices } = canary;
  const reached = (network.dnsAttempts - network.dnsFailures) + (network.connectAttempts - network.connectFailures);
  return [
    checkFact("guestNonRootObserved", "guest", identity.uid !== 0 && identity.gid !== 0),
    checkFact("guestNoNewPrivsObserved", "guest", identity.noNewPrivs),
    checkFact("guestSeccompFilterObserved", "guest", identity.seccompMode === 2),
    checkFact("guestCapabilitySetsEmptyObserved", "guest", identity.capabilitiesZero),
    checkFact("transferredInputReadObserved", "guest", filesystem.transferredReadable),
    checkFact("transferDigestObserved", "guest", filesystem.transferDigestMatched),
    checkFact("rootfsWriteDeniedObserved", "guest", filesystem.rootfsWriteDenied),
    checkFact("scratchWriteObserved", "guest", filesystem.workWritable && filesystem.tmpWritable && filesystem.homeWritable),
    checkFact("mountTableHostPathAbsentObserved", "guest", mounts.entries > 0 && mounts.forbiddenFound === 0 &&
      mounts.hostShareFilesystems === 0 && mounts.bindLikeFromOutsideVm === 0),
    checkFact("hostMarkersNotFoundObserved", "guest", markers.walkComplete && markers.found === 0),
    checkFact("credentialEnvMarkersAbsentObserved", "guest", credentials.environSourcesRead >= 2 &&
      credentials.forbiddenKeysPresent === 0 && credentials.credentialShapedKeysPresent === 0 && credentials.canaryValuesPresent === 0),
    checkFact("gitSshCredentialPathsAbsentObserved", "guest", credentials.sshOrGitPathsPresent === 0),
    checkFact("dockerSocketAbsentObserved", "guest", dockerSocket.knownPathsPresent === 0 && dockerSocket.socketsNamedDockerFound === 0),
    checkFact("loopbackOnlyInterfacesObserved", "guest", network.interfaces.length === 1 && network.interfaces[0] === "lo" &&
      network.ipv4Routes === 0 && network.ipv6NonLoopbackRoutes === 0),
    observedFact("canaryConnectionsFailedObserved", "guest", network.dnsAttempts + network.connectAttempts, reached),
    checkFact("cgroupLimitsObserved", "guest", resources.memoryMax === String(limits.memoryBytes) &&
      resources.pidsMax === String(limits.pids) && resources.cpuMax === `${limits.nanoCpus / 10_000} 100000`),
    checkFact("pidLimitEnforcedObserved", "guest", resources.pidProbeLimited && resources.pidProbeSpawned < limits.pids),
    checkFact("unexpectedDevicesAbsentObserved", "guest", devices.unexpected.length === 0),
    checkFact("yamaPtraceRestrictedObserved", "guest", identity.ptraceScope !== null && identity.ptraceScope >= 1),
    checkFact("guestRuntimeIdentityObserved", "guest", canary.runtime.platform === "linux" &&
      (expectedNode === undefined || canary.runtime.node === expectedNode)),
  ];
}
