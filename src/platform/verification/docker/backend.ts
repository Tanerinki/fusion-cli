import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { FusionError, VerificationPlan } from "../../../core/domain.js";
import { failWith, FusionFailure } from "../../../core/errors.js";
import { DiagnosticRedactor } from "../../../core/policy/redaction.js";
import { comparablePath } from "../../workspace/git.js";
import { assertPlatformEligible, type VerificationBackend, type VerificationBackendProbe, type VerificationCleanupResult,
  type VerificationExecutionRequest, type VerificationExecutionResult, type VerificationLease } from "../backend.js";
import { backendEvidence, checkFact, observedFact, unobservedFact, type BackendEvidence,
  type BackendEvidenceFact } from "../backend-evidence.js";
import { captureControlledTree, compareControlledTrees, type ControlledTreeSnapshot } from "../controlled-tree.js";
import type { VerificationReport, VerificationStepResult, VerificationStepStatus } from "../engine.js";
import { buildContainerVerifierEnvironment, CONTAINER_VERIFIER_ENV } from "../verifier-environment.js";
import { copyCandidateSnapshot, createRunDirectories, loadGuestRunner, removeRunDirectories, type RunDirectories,
  type SnapshotStats } from "./bundle.js";
import { CliDockerRunner, isNoSuchObject, parseContainerInspect, parseDockerVersion, parseImageInspect, requireExited,
  resolveDockerCli, type ContainerInspection, type DockerCommandRunner, type DockerImageInfo, type DockerOutcome,
  type DockerServerInfo } from "./cli.js";
import { assertImageId, assertPinnedImage, buildCreateArgs, CONTAINER_ID, DOCKER_BACKEND_ID, DOCKER_PROTOCOL_VERSION,
  GUEST_PATHS, GUEST_USER, imageDigest, isFusionOwned, OWNER_LABELS, resolveLimits, type DockerResourceLimits,
  type GuestMode } from "./config.js";
import { decodeCanaryResult, decodeVerifyResult, DOCKER_RESULT_LIMITS, parseTestCounts, type CanaryManifest,
  type CanaryResult, type GuestCommand, type TestCounts, type VerifyManifest, type VerifyResult } from "./protocol.js";
import { parseStrictJson } from "../../process/strict-json.js";

/**
 * Hardened Docker/Linux verification backend (O5.5B5 prototype). Untrusted verification runs in a disposable Linux
 * container created from a digest-pinned image with no network, no capabilities, no privilege escalation, a read-only
 * root filesystem, an unprivileged user, bounded memory/CPU/PIDs, tmpfs-only scratch, one read-only bind of a
 * Fusion-built input bundle and no writable host mount; the result returns on the runner's attached stdout.
 *
 * It PROVES LINUX BEHAVIOR ONLY (`platformSemantics: "linux"`): Windows paths, NTFS ACLs, PowerShell, Win32 APIs and
 * Windows-only native addons are out of reach, so it refuses a `windows-required` or `unknown` platform requirement.
 * It is a prototype: `productionEligible` is the constant `false`, it produces no Windows-shaped `ConfinementProof`,
 * and its narrow `BackendEvidence` never opens verification-isolation or Writer readiness.
 */
export interface DockerLinuxBackendOptions {
  /** Digest-pinned image reference, e.g. `node@sha256:<64 hex>`. Never pulled by the backend. */
  readonly image: string;
  /** Optional expected image id (`sha256:<64 hex>`); a different local image with the same reference is refused. */
  readonly expectedImageId?: string;
  readonly limits?: Partial<DockerResourceLimits>;
  /** Absolute in-image executables a verification command may name. Default: the image's node binary only. */
  readonly allowedExecutables?: readonly string[];
  /** Base directory for Fusion-owned run directories. Default: the OS temporary directory. */
  readonly baseDirectory?: string;
  /** Time allowed beyond the summed command timeouts for container start and the bundle copy. */
  readonly hostDeadlineAllowanceMs?: number;
  /** Source of the docker CLI's allowlisted environment. Default: `process.env`. */
  readonly clientEnvironment?: NodeJS.ProcessEnv;
  /** Test seams. */
  readonly runner?: DockerCommandRunner;
  readonly resolveDocker?: () => Promise<string | null>;
}

export interface DockerEvidenceOptions {
  /** Names of synthetic marker files the caller placed OUTSIDE the bundle (primary repo, profile, provider state). */
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
  readonly prepareMs: number;
  readonly createMs: number;
  /** `docker start --attach` until the guest's result arrived (includes container start, guest copy and commands). */
  readonly attachMs: number;
  readonly guestCopyMs: number | null;
  readonly commandsMs: number | null;
  readonly inspectMs: number;
  readonly removeMs: number;
  readonly totalMs: number;
}
export interface DockerRunObservation {
  readonly runId: string;
  readonly runnerSha256: string;
  readonly bundle: SnapshotStats;
  readonly containerExitCode: number | null;
  readonly oomKilled: boolean;
  readonly resultAccepted: boolean;
  /** Stable reason the guest result was not accepted. */
  readonly rejection?: string;
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

/** Narrow facts a complete Docker evidence record must observe as passing. Deliberately no universal claim names. */
export const DOCKER_REQUIRED_EVIDENCE_FACTS = Object.freeze([
  "linuxEngineObserved", "pinnedImageObserved", "privilegedDisabledObserved", "capDropAllObserved",
  "noNewPrivilegesOptionObserved", "defaultConfinementProfilesKeptObserved", "readOnlyRootfsObserved",
  "nonRootUserConfiguredObserved", "networkModeNoneObserved", "hostNamespacesNotSharedObserved", "noDevicesObserved",
  "inputBindReadOnlyObserved", "noWritableHostMountObserved", "noDockerSocketMountObserved", "tmpfsScratchOnlyObserved",
  "resourceLimitsConfiguredObserved", "ownershipLabelsObserved", "logDriverNoneObserved", "initReaperObserved",
  "containerEnvKeysAllowlistedObserved",
  "guestNonRootObserved", "guestNoNewPrivsObserved", "guestSeccompFilterObserved", "guestCapabilitySetsEmptyObserved",
  "inputReadObserved", "inputWriteDeniedObserved", "rootfsWriteDeniedObserved", "scratchWriteObserved",
  "hostMarkersNotFoundObserved", "credentialEnvMarkersAbsentObserved", "gitSshCredentialPathsAbsentObserved",
  "dockerSocketAbsentObserved", "loopbackOnlyInterfacesObserved", "canaryConnectionsFailedObserved",
  "cgroupLimitsObserved", "pidLimitEnforcedObserved", "unexpectedDevicesAbsentObserved",
  "verifyInputUnchangedObserved", "canaryInputUnchangedObserved", "descendantRemovedWithContainerObserved",
  "hostDeadlineTerminationObserved", "ownedContainersRemovedObserved",
] as const);

/** Environment key names a verifier container must never carry (names only; values are never read by the host). */
export const FORBIDDEN_ENV_KEYS = Object.freeze(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_ASKPASS", "GITHUB_TOKEN",
  "GH_TOKEN", "GIT_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "NPM_TOKEN", "NODE_AUTH_TOKEN", "NODE_OPTIONS", "DOCKER_HOST",
  "DOCKER_CONFIG", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AZURE_CLIENT_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS"]);
export const FORBIDDEN_ENV_PREFIXES = Object.freeze(["ANTHROPIC_", "CLAUDE", "MUSE_", "META_", "TBH_", "OPENAI_", "SSH_",
  "GIT_CONFIG", "GIT_CREDENTIAL", "AWS_", "AZURE_", "GOOGLE_", "GH_", "GITHUB_", "DOCKER_"]);
export const CANARY_VALUE_PREFIX = "fusion-canary-";
const ALLOWED_DEVICES = Object.freeze(["core", "fd", "full", "mqueue", "null", "ptmx", "pts", "random", "shm", "stderr",
  "stdin", "stdout", "tty", "urandom", "zero"]);
const MARKER_NAME = /^fusion-canary-[0-9a-f]{16,64}(?:\.[a-z]{1,8})?$/u;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const POSIX_EXECUTABLE = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ash", "ksh", "busybox", "env", "sudo", "su"]);

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const elapsed = (since: number): number => Math.round(performance.now() - since);

interface ReadyState {
  readonly server: DockerServerInfo;
  readonly image: DockerImageInfo;
}
interface LeaseState {
  readonly runId: string;
  readonly nonce: string;
  readonly createdAt: string;
  readonly dirs: RunDirectories;
  readonly commands: readonly GuestCommand[];
  readonly plan: VerificationPlan;
  /** Engine and image identity from the probe this lease was prepared under; later probes cannot change it. */
  readonly engine: ReadyState;
  readonly runnerSha256: string;
  readonly runnerBytes: Buffer;
  readonly siblingMarker: string;
  readonly inputBefore: ControlledTreeSnapshot;
  readonly bundle: SnapshotStats;
  readonly prepareMs: number;
  /** Containers this lease created and has not yet proven removed. */
  readonly containers: Set<string>;
  /** Container ids this lease ever created (for the final ownership-scoped sweep). */
  readonly created: Set<string>;
  readonly inspections: ContainerInspection[];
  ran: boolean;
  evidenceCollected: boolean;
  evidenceDetail?: DockerEvidenceDetail;
  inputUnchanged?: boolean;
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

export class DockerLinuxVerificationBackend implements VerificationBackend {
  readonly id = DOCKER_BACKEND_ID;
  readonly confinement = "osSandbox" as const;
  readonly productionEligible = false as const;
  readonly platformSemantics = "linux" as const;
  readonly #image: string;
  readonly #expectedImageId: string | undefined;
  readonly #limits: DockerResourceLimits;
  readonly #allowedExecutables: readonly string[];
  readonly #base: string;
  readonly #allowanceMs: number;
  readonly #leases = new WeakMap<VerificationLease, LeaseState>();
  #runner: DockerCommandRunner | undefined;
  #ready: ReadyState | undefined;

  constructor(private readonly options: DockerLinuxBackendOptions) {
    this.#image = assertPinnedImage(options.image);
    this.#expectedImageId = options.expectedImageId === undefined ? undefined : assertImageId(options.expectedImageId);
    this.#limits = resolveLimits(options.limits);
    const allowed = options.allowedExecutables ?? [GUEST_PATHS.node];
    if (allowed.length === 0 || !allowed.every(path => typeof path === "string" && POSIX_EXECUTABLE.test(path) &&
        !path.split("/").includes("..") && !SHELLS.has(posix.basename(path))))
      failWith("InvalidInput", "Docker allowed executables must be absolute in-image binaries and never shells.");
    this.#allowedExecutables = Object.freeze([...allowed]);
    this.#base = options.baseDirectory ?? tmpdir();
    this.#allowanceMs = options.hostDeadlineAllowanceMs ?? 60_000;
    if (!Number.isSafeInteger(this.#allowanceMs) || this.#allowanceMs < 1_000 || this.#allowanceMs > 10 * 60_000)
      failWith("InvalidInput", "Docker host deadline allowance is out of range.");
  }

  get limits(): DockerResourceLimits { return this.#limits; }

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

  /** Read-only availability check: CLI, reachable daemon, Linux engine, and the pinned image present locally. */
  async probe(signal?: AbortSignal): Promise<VerificationBackendProbe> {
    const unavailable = (reason: string): VerificationBackendProbe => {
      this.#ready = undefined;
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
    if (!pinned || info.os !== "linux" || info.architecture !== reading.server.arch ||
        (this.#expectedImageId !== undefined && info.id !== this.#expectedImageId))
      return unavailable("docker-image-identity-mismatch");
    this.#ready = Object.freeze({ server: reading.server, image: info });
    return { backendId: this.id, available: true, confinement: this.confinement };
  }

  /** Daemon and image identity observed by the last successful probe (non-secret; for inventory and evidence). */
  get observedEngine(): ReadyState | undefined { return this.#ready; }

  async prepare(request: VerificationExecutionRequest): Promise<VerificationLease> {
    assertPlatformEligible(this, request);
    const commands = validateDockerPlan(request.plan, this.#allowedExecutables);
    if (typeof request.workspaceRoot !== "string" || request.workspaceRoot.length === 0)
      failWith("InvalidInput", "Verification backend requires a workspace root.");
    if (this.#ready === undefined) {
      const probe = await this.probe(request.signal);
      if (!probe.available) failWith("CapabilityUnavailable", `Docker verification backend is unavailable: ${probe.reason ?? "unknown"}.`);
    }
    const engine = this.#ready!;
    const started = performance.now();
    const runId = hex(16), nonce = hex(16), createdAt = new Date().toISOString();
    const dirs = await createRunDirectories(runId, this.#base);
    try {
      const bundle = await copyCandidateSnapshot(request.workspaceRoot, join(dirs.input, "src"));
      const runner = await loadGuestRunner();
      await writeFile(join(dirs.input, "runner.mjs"), runner.bytes, { flag: "wx" });
      const manifest: VerifyManifest = { protocolVersion: DOCKER_PROTOCOL_VERSION, nonce,
        env: buildContainerVerifierEnvironment().env as Record<string, string>,
        limits: { stdoutTailBytes: DOCKER_RESULT_LIMITS.stdoutTailBytes, stderrTailBytes: DOCKER_RESULT_LIMITS.stderrTailBytes,
          maxCopyEntries: DOCKER_RESULT_LIMITS.maxCopyEntries, maxCopyBytes: DOCKER_RESULT_LIMITS.maxCopyBytes },
        commands };
      await writeFile(join(dirs.input, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
      const siblingMarker = `${CANARY_VALUE_PREFIX}${hex(16)}.txt`;
      await writeFile(join(dirs.privateSibling, siblingMarker), "synthetic host-private marker", { flag: "wx" });
      const inputBefore = await captureControlledTree(dirs.input);
      if (!inputBefore.complete) failWith("InvalidInput", "Docker input bundle could not be fingerprinted.");
      const lease: VerificationLease = Object.freeze({ backendId: this.id, confinement: this.confinement,
        workspaceRoot: request.workspaceRoot });
      this.#leases.set(lease, { runId, nonce, createdAt, dirs, commands, plan: request.plan, engine, runnerSha256: runner.sha256,
        runnerBytes: runner.bytes, siblingMarker, inputBefore, bundle, prepareMs: elapsed(started), containers: new Set(),
        created: new Set(), inspections: [], ran: false, evidenceCollected: false });
      return lease;
    } catch (error) {
      await removeRunDirectories(dirs, runId, this.#base).catch(() => false);
      throw error;
    }
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
    const work = this.#verify(state, request);
    state.inflight = work.then(() => undefined, () => undefined);
    return work;
  }

  async #create(state: LeaseState, mode: GuestMode, inputDirectory: string): Promise<string> {
    const runner = this.#requireRunner();
    const args = buildCreateArgs({ runId: state.runId, mode, image: this.#image, inputDirectory, limits: this.#limits,
      env: CONTAINER_VERIFIER_ENV, createdAt: state.createdAt });
    const outcome = await runner.run({ args, timeoutMs: 60_000, maxStdoutBytes: 4096 });
    if (outcome.status !== "exited" || outcome.exitCode !== 0) failWith("ProcessFailure", "Docker container could not be created.");
    const id = outcome.stdout.trim();
    if (!CONTAINER_ID.test(id)) failWith("MalformedOutput", "Docker returned an invalid container id.");
    state.containers.add(id);
    state.created.add(id);
    return id;
  }

  async #inspect(state: LeaseState, id: string): Promise<ContainerInspection> {
    const outcome = await requireExited(this.#requireRunner(), { args: ["container", "inspect", "--format", "{{json .}}", id],
      timeoutMs: 20_000, maxStdoutBytes: 512 * 1024 }, "inspect");
    const inspection = parseContainerInspect(outcome.stdout);
    if (inspection === undefined || inspection.id !== id) failWith("MalformedOutput", "Docker container inspection is malformed.");
    state.inspections.push(inspection);
    return inspection;
  }

  /** Best-effort stop of a container this lease created; state is re-read from the daemon afterwards. */
  async #kill(state: LeaseState, id: string): Promise<void> {
    if (!state.created.has(id)) failWith("SecurityViolation", "Refused to stop a container this run did not create.");
    await this.#requireRunner().run({ args: ["kill", id], timeoutMs: 20_000, maxStdoutBytes: 4096 });
  }

  /**
   * Ownership-scoped removal: the container's labels are read back from the daemon and must carry every Fusion
   * ownership label for THIS run before `rm --force` is issued; removal is then confirmed by a "no such container"
   * answer. A foreign container is never removed, whatever its name.
   */
  async #remove(state: LeaseState, id: string): Promise<boolean> {
    const runner = this.#requireRunner();
    const labels = await runner.run({ args: ["container", "inspect", "--format", "{{json .Config.Labels}}", id],
      timeoutMs: 20_000, maxStdoutBytes: 64 * 1024 });
    if (isNoSuchObject(labels)) { state.containers.delete(id); return true; }
    if (labels.status !== "exited" || labels.exitCode !== 0) return false;
    let parsed: unknown;
    try { parsed = parseStrictJson(labels.stdout.trim(), 4); } catch { return false; }
    if (!isFusionOwned(parsed, state.runId)) return false;
    await runner.run({ args: ["rm", "--force", id], timeoutMs: 30_000, maxStdoutBytes: 4096 });
    const after = await runner.run({ args: ["container", "inspect", "--format", "{{.Id}}", id], timeoutMs: 20_000, maxStdoutBytes: 4096 });
    if (!isNoSuchObject(after)) return false;
    state.containers.delete(id);
    return true;
  }

  /** Every container still labelled with this run id, found by label (never by name) and removed only if owned. */
  async #sweep(state: LeaseState): Promise<number> {
    const listed = await requireExited(this.#requireRunner(), { args: ["ps", "--all", "--no-trunc", "--filter",
      `label=${OWNER_LABELS.run}=${state.runId}`, "--format", "{{.ID}}"], timeoutMs: 20_000, maxStdoutBytes: 64 * 1024 }, "list");
    const ids = listed.stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== "");
    if (!ids.every(id => CONTAINER_ID.test(id))) failWith("MalformedOutput", "Docker container listing is malformed.");
    let remaining = 0;
    for (const id of ids) if (!await this.#remove(state, id)) remaining++;
    return remaining;
  }

  async #verify(state: LeaseState, request: VerificationExecutionRequest): Promise<DockerVerificationExecutionResult> {
    const runner = this.#requireRunner();
    const started = performance.now(), startedAt = new Date().toISOString();
    const redactor = DiagnosticRedactor.fromEnvironment(request.env);
    const deadlineMs = state.commands.reduce((sum, command) => sum + command.timeoutMs, 0) + this.#allowanceMs;
    let createMs = 0, attachMs = 0, inspectMs = 0, removeMs = 0;
    let attach: DockerOutcome | undefined, inspection: ContainerInspection | undefined;
    if (request.signal?.aborted) return this.#result(state, redactor, startedAt, { kind: "cancelled" },
      { createMs, attachMs, inspectMs, removeMs, started });
    let mark = performance.now();
    const id = await this.#create(state, "verify", state.dirs.input);
    createMs = elapsed(mark);
    try {
      mark = performance.now();
      attach = await runner.run({ args: ["start", "--attach", id], timeoutMs: deadlineMs,
        maxStdoutBytes: DOCKER_RESULT_LIMITS.maxResultBytes + 1, ...(request.signal ? { signal: request.signal } : {}) });
      attachMs = elapsed(mark);
      // Killing the attached client never stops a container; the host stops it explicitly.
      if (attach.status !== "exited") await this.#kill(state, id);
      mark = performance.now();
      inspection = await this.#inspect(state, id);
      inspectMs = elapsed(mark);
    } finally {
      mark = performance.now();
      await this.#remove(state, id).catch(() => false);
      removeMs = elapsed(mark);
    }
    const inputAfter = await captureControlledTree(state.dirs.input);
    state.inputUnchanged = inputAfter.complete && compareControlledTrees(state.inputBefore, inputAfter).length === 0;
    const timing = { createMs, attachMs, inspectMs, removeMs, started };
    if (attach.status === "cancelled" || (attach.status !== "exited" && request.signal?.aborted))
      return this.#result(state, redactor, startedAt, { kind: "cancelled" }, timing, inspection);
    if (attach.status === "timeout")
      return this.#result(state, redactor, startedAt, { kind: "failure", failure: { kind: "Timeout", retryable: true,
        safeMessage: "Docker verification exceeded its host deadline; the container was stopped." } }, timing, inspection);
    if (attach.status === "outputLimit")
      return this.#result(state, redactor, startedAt, { kind: "rejected",
        rejection: "Docker guest result exceeded its size bound." }, timing, inspection);
    if (attach.status !== "exited")
      return this.#result(state, redactor, startedAt, { kind: "failure", failure: { kind: "ProcessFailure",
        retryable: false, safeMessage: "Docker verification container could not be run." } }, timing, inspection);
    if (inspection.oomKilled)
      return this.#result(state, redactor, startedAt, { kind: "failure", failure: { kind: "ProcessFailure",
        retryable: false, safeMessage: "Docker verification exceeded its memory limit." } }, timing, inspection);
    // A runner that failed before producing a result reports only a stable code on stderr; nothing else is surfaced.
    const runnerError = attach.stdout.trim() === "" ? /^fusion-runner-error:([a-z-]{1,40})$/mu.exec(attach.stderr)?.[1] : undefined;
    if (runnerError !== undefined)
      return this.#result(state, redactor, startedAt, { kind: "rejected",
        rejection: `Docker guest runner failed before producing a result (${runnerError}).` }, timing, inspection);
    let result: VerifyResult;
    try { result = decodeVerifyResult(attach.stdout, { nonce: state.nonce, commands: state.commands, hostElapsedMs: attachMs }); }
    catch (error) {
      if (!(error instanceof FusionFailure)) throw error;
      return this.#result(state, redactor, startedAt, { kind: "rejected", rejection: error.error.safeMessage }, timing, inspection);
    }
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
    const inputIntact = state.inputUnchanged === true;
    const steps: VerificationStepResult[] = (accepted?.commands ?? []).map(entry => {
      const command = planById.get(entry.id)!;
      let status: VerificationStepStatus = entry.status === "timeout" ? "timeout" : entry.status === "spawnError" ? "spawnFailure"
        : entry.exitCode === 0 ? "passed" : "failed";
      if (!inputIntact) status = "mutationViolation";
      const failure = stepFailure(status, entry.id, entry.exitCode);
      const base = { commandId: entry.id, executable: command.executable, args: command.args.map(arg => redactor.redactText(arg)),
        cwd: command.cwd, startedAt, durationMs: entry.durationMs, stdoutArtifact: "", stderrArtifact: "", preDiffArtifact: "",
        postDiffArtifact: "", mutatedRepository: !inputIntact, status, mutationPolicy: command.mutationPolicy, mutations: [],
        mutationProven: inputIntact, stdoutTruncated: entry.stdoutBytes > DOCKER_RESULT_LIMITS.stdoutTailBytes,
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
    const docker: DockerRunObservation = Object.freeze({
      runId: state.runId, runnerSha256: state.runnerSha256, bundle: state.bundle,
      containerExitCode: inspection?.exitCode ?? null, oomKilled: inspection?.oomKilled ?? false,
      resultAccepted: accepted !== undefined, ...(outcome.kind === "rejected" ? { rejection: outcome.rejection } : {}),
      steps: Object.freeze((accepted?.commands ?? []).map(entry => Object.freeze({ id: entry.id, stdoutTail: entry.stdoutTail,
        stderrTail: entry.stderrTail, testCounts: parseTestCounts(entry.stdoutTail) }))),
      timings: Object.freeze({ prepareMs: state.prepareMs, createMs: timing.createMs, attachMs: timing.attachMs,
        guestCopyMs: accepted?.copy.durationMs ?? null, commandsMs: guestCommandsMs, inspectMs: timing.inspectMs,
        removeMs: timing.removeMs, totalMs: elapsed(timing.started) }),
    });
    return { backendId: this.id, confinement: this.confinement, report, passed: report.passed, docker };
  }

  /** Docker produces no Windows-shaped `ConfinementProof`; its observations are `collectEvidence`'s narrow facts. */
  collectProof(): Promise<undefined> { return Promise.resolve(undefined); }

  /**
   * Runs Fusion-authored probes in fresh containers with the identical hardened configuration — no repository code —
   * and returns narrow observed facts from three sources: daemon metadata of every container this lease created, the
   * guest canary, and host-side lifecycle checks. Observation only: it never decides acceptance or readiness.
   */
  async collectEvidence(lease: VerificationLease, options: DockerEvidenceOptions = {}): Promise<BackendEvidence> {
    const state = this.#state(lease);
    if (state.evidenceCollected) failWith("InvalidInput", "Docker evidence is collected once per lease.");
    state.evidenceCollected = true;
    const markers = [state.siblingMarker, ...(options.absentMarkerNames ?? [])];
    if (markers.length > 32 || !markers.every(name => MARKER_NAME.test(name)))
      failWith("InvalidInput", "Evidence marker names must be synthetic fusion-canary names.");
    const hangDeadlineMs = options.hangDeadlineMs ?? 2_000;
    if (!Number.isSafeInteger(hangDeadlineMs) || hangDeadlineMs < 500 || hangDeadlineMs > 60_000)
      failWith("InvalidInput", "Evidence deadline is out of range.");
    const ready = state.engine;
    const canaryInput = join(state.dirs.runRoot, "canary-input");
    const canaryNonce = hex(16), readableToken = `fusion-readable-${hex(16)}`, descendantMarker = `fusion-descendant-${hex(16)}`;
    await mkdir(join(canaryInput, "canary"), { recursive: true });
    await writeFile(join(canaryInput, "runner.mjs"), state.runnerBytes, { flag: "wx" });
    const manifest: CanaryManifest = { protocolVersion: DOCKER_PROTOCOL_VERSION, nonce: canaryNonce, readableToken,
      absentMarkerNames: markers, forbiddenEnvKeys: FORBIDDEN_ENV_KEYS, forbiddenEnvPrefixes: FORBIDDEN_ENV_PREFIXES,
      canaryValuePrefix: CANARY_VALUE_PREFIX, dnsNames: ["example.com", "host.docker.internal"],
      connectTargets: [{ host: "1.1.1.1", port: 443 }, { host: "8.8.8.8", port: 53 }, { host: "192.168.65.254", port: 80 }],
      pidProbeMax: this.#limits.pids + 16, allowedDevices: ALLOWED_DEVICES, descendantMarker, walkMaxEntries: 500_000 };
    await writeFile(join(canaryInput, "canary.json"), JSON.stringify(manifest), { flag: "wx" });
    await writeFile(join(canaryInput, "canary", "readable.txt"), readableToken, { flag: "wx" });
    const canaryBefore = await captureControlledTree(canaryInput);

    const facts: BackendEvidenceFact[] = [checkFact("linuxEngineObserved", "daemon", ready.server.os === "linux")];
    const started = performance.now();
    let mark = started;
    const canary = await this.#canary(state, canaryInput, canaryNonce);
    const canaryMs = elapsed(mark);
    const canaryAfter = await captureControlledTree(canaryInput);
    const canaryUnchanged = canaryBefore.complete && canaryAfter.complete && compareControlledTrees(canaryBefore, canaryAfter).length === 0;
    mark = performance.now();
    const descendant = await this.#descendant(state, canaryInput, descendantMarker);
    const descendantMs = elapsed(mark);
    mark = performance.now();
    const deadline = await this.#deadline(state, canaryInput, hangDeadlineMs);
    const deadlineMs = elapsed(mark);

    facts.push(...this.#daemonFacts(state, canaryInput));
    facts.push(...guestFacts(canary, this.#limits));
    facts.push(state.inputUnchanged === undefined ? unobservedFact("verifyInputUnchangedObserved", "host")
      : checkFact("verifyInputUnchangedObserved", "host", state.inputUnchanged));
    facts.push(checkFact("canaryInputUnchangedObserved", "host", canaryUnchanged));
    facts.push(checkFact("descendantRemovedWithContainerObserved", "host", descendant));
    facts.push(checkFact("hostDeadlineTerminationObserved", "host", deadline));
    mark = performance.now();
    const remaining = await this.#sweep(state).catch(() => -1);
    facts.push(checkFact("ownedContainersRemovedObserved", "host", remaining === 0 && state.containers.size === 0));
    state.evidenceDetail = Object.freeze({ canary, timings: Object.freeze({ canaryMs, descendantMs, deadlineMs,
      sweepMs: elapsed(mark), totalMs: elapsed(started) }) });
    return backendEvidence(this.id, facts);
  }

  evidenceDetail(lease: VerificationLease): DockerEvidenceDetail | undefined { return this.#state(lease).evidenceDetail; }

  async #canary(state: LeaseState, input: string, nonce: string): Promise<CanaryResult | undefined> {
    const id = await this.#create(state, "canary", input);
    let outcome: DockerOutcome;
    try {
      outcome = await this.#requireRunner().run({ args: ["start", "--attach", id], timeoutMs: 120_000,
        maxStdoutBytes: DOCKER_RESULT_LIMITS.maxResultBytes + 1 });
      if (outcome.status !== "exited") await this.#kill(state, id);
      await this.#inspect(state, id);
    } finally { await this.#remove(state, id).catch(() => false); }
    if (outcome.status !== "exited" || outcome.exitCode !== 0) return undefined;
    try { return decodeCanaryResult(outcome.stdout, nonce); }
    catch (error) { if (error instanceof FusionFailure) return undefined; throw error; }
  }

  /**
   * A marked sleeping descendant is observed in the container's process list by the daemon; the container is then
   * killed (its init exits, so the PID namespace is torn down), observed stopped, and removed. Narrow claim: the
   * daemon listed the descendant while running, reported the container stopped, and then no longer knew it.
   */
  async #descendant(state: LeaseState, input: string, marker: string): Promise<boolean> {
    const runner = this.#requireRunner();
    const id = await this.#create(state, "descendant", input);
    try {
      await requireExited(runner, { args: ["start", id], timeoutMs: 60_000, maxStdoutBytes: 4096 }, "start");
      let seen = false;
      for (let attempt = 0; attempt < 40 && !seen; attempt++) {
        const top = await runner.run({ args: ["top", id, "-o", "pid,args"], timeoutMs: 15_000, maxStdoutBytes: 64 * 1024 });
        seen = top.status === "exited" && top.exitCode === 0 &&
          top.stdout.split(/\r?\n/u).some(line => line.includes(marker) && !line.includes(GUEST_PATHS.runner));
        if (!seen) await delay(250);
      }
      await this.#kill(state, id);
      const stopped = !(await this.#inspect(state, id)).running;
      const topStopped = await runner.run({ args: ["top", id], timeoutMs: 15_000, maxStdoutBytes: 64 * 1024 });
      const removed = await this.#remove(state, id);
      const topAfter = await runner.run({ args: ["top", id], timeoutMs: 15_000, maxStdoutBytes: 4096 });
      return seen && stopped && topStopped.exitCode !== 0 && removed && isNoSuchObject(topAfter);
    } finally { if (state.containers.has(id)) await this.#remove(state, id).catch(() => false); }
  }

  /** A never-ending guest must be stopped by the HOST at its deadline, and the container must then be removable. */
  async #deadline(state: LeaseState, input: string, deadlineMs: number): Promise<boolean> {
    const runner = this.#requireRunner();
    const id = await this.#create(state, "hang", input);
    try {
      await requireExited(runner, { args: ["start", id], timeoutMs: 60_000, maxStdoutBytes: 4096 }, "start");
      const wait = await runner.run({ args: ["wait", id], timeoutMs: deadlineMs, maxStdoutBytes: 1024 });
      await this.#kill(state, id);
      const stopped = !(await this.#inspect(state, id)).running;
      return wait.status === "timeout" && stopped && await this.#remove(state, id);
    } finally { if (state.containers.has(id)) await this.#remove(state, id).catch(() => false); }
  }

  #daemonFacts(state: LeaseState, canaryInput: string): BackendEvidenceFact[] {
    const inspections = state.inspections;
    const expectedInputs = new Set([comparablePath(state.dirs.input), comparablePath(canaryInput)]);
    const allowedEnv = new Set([...Object.keys(CONTAINER_VERIFIER_ENV), ...state.engine.image.envKeys]);
    const binds = (i: ContainerInspection): ContainerInspection["mounts"] => i.mounts.filter(mount => mount.type === "bind");
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
      ["inputBindReadOnlyObserved", i => binds(i).length === 1 && binds(i)[0]!.destination === GUEST_PATHS.input &&
        !binds(i)[0]!.rw && expectedInputs.has(comparablePath(binds(i)[0]!.source))],
      ["noWritableHostMountObserved", i => i.mounts.every(mount => (mount.type === "bind" && !mount.rw) || mount.type === "tmpfs")],
      ["noDockerSocketMountObserved", i => i.mounts.every(mount => !/docker\.sock/iu.test(`${mount.source} ${mount.destination}`))],
      ["tmpfsScratchOnlyObserved", i => i.tmpfsTargets.join(",") === [GUEST_PATHS.work, GUEST_PATHS.tmp].sort().join(",")],
      ["resourceLimitsConfiguredObserved", i => i.memory === this.#limits.memoryBytes && i.memorySwap === this.#limits.memoryBytes &&
        i.nanoCpus === this.#limits.nanoCpus && i.pidsLimit === this.#limits.pids],
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
      for (const id of [...state.containers]) await this.#remove(state, id).catch(() => false);
      const remaining = await this.#sweep(state);
      if (remaining > 0 || state.containers.size > 0) reasons.push("an owned container could not be removed");
    } catch { reasons.push("owned containers could not be verified removed"); }
    const removed = await removeRunDirectories(state.dirs, state.runId, this.#base).catch(() => false);
    if (!removed) reasons.push("the run directory could not be removed");
    if (reasons.length === 0) this.#leases.delete(lease);
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
      safeMessage: `The read-only input bundle changed during verification command ${id}.`, retryable: false };
    default: return { kind: "ProcessFailure", safeMessage: `Verification command ${id} failed at the process level.`, retryable: false };
  }
}

const GUEST_FACTS = Object.freeze(["guestNonRootObserved", "guestNoNewPrivsObserved", "guestSeccompFilterObserved",
  "guestCapabilitySetsEmptyObserved", "inputReadObserved", "inputWriteDeniedObserved", "rootfsWriteDeniedObserved",
  "scratchWriteObserved", "hostMarkersNotFoundObserved", "credentialEnvMarkersAbsentObserved",
  "gitSshCredentialPathsAbsentObserved", "dockerSocketAbsentObserved", "loopbackOnlyInterfacesObserved",
  "canaryConnectionsFailedObserved", "cgroupLimitsObserved", "pidLimitEnforcedObserved",
  "unexpectedDevicesAbsentObserved", "yamaPtraceRestrictedObserved"]);

/** Guest-observed facts from the Fusion-only canary container; an absent or rejected canary observes nothing. */
export function guestFacts(canary: CanaryResult | undefined, limits: DockerResourceLimits): BackendEvidenceFact[] {
  if (canary === undefined) return GUEST_FACTS.map(fact => unobservedFact(fact, "guest"));
  const { identity, filesystem, markers, credentials, dockerSocket, network, resources, devices } = canary;
  const reached = (network.dnsAttempts - network.dnsFailures) + (network.connectAttempts - network.connectFailures);
  return [
    checkFact("guestNonRootObserved", "guest", identity.uid !== 0 && identity.gid !== 0),
    checkFact("guestNoNewPrivsObserved", "guest", identity.noNewPrivs),
    checkFact("guestSeccompFilterObserved", "guest", identity.seccompMode === 2),
    checkFact("guestCapabilitySetsEmptyObserved", "guest", identity.capabilitiesZero),
    checkFact("inputReadObserved", "guest", filesystem.inputReadable),
    checkFact("inputWriteDeniedObserved", "guest", filesystem.inputCreateDenied && filesystem.inputModifyDenied),
    checkFact("rootfsWriteDeniedObserved", "guest", filesystem.rootfsWriteDenied),
    checkFact("scratchWriteObserved", "guest", filesystem.workWritable && filesystem.tmpWritable && filesystem.homeWritable),
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
  ];
}
