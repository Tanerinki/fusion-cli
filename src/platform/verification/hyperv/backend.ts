import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FusionError, VerificationPlan } from "../../../core/domain.js";
import { failWith } from "../../../core/errors.js";
import { fusionTemporaryBase } from "../../fs/temporary.js";
import { assertDependencySupport, assertPlatformEligible, type RecoveryReport,
  type VerificationBackend, type VerificationBackendProbe, type VerificationCleanupResult,
  type VerificationExecutionRequest, type VerificationExecutionResult, type VerificationLease } from "../backend.js";
import type { VerificationReport, VerificationStepResult, VerificationStepStatus } from "../engine.js";
import { CliDockerRunner, isNoSuchObject, parseContainerInspect, parseDockerVersion, parseImageInspect,
  resolveDockerCli, type ContainerInspection, type DockerCommandRunner, type DockerImageInfo,
  type DockerServerInfo } from "../docker/cli.js";
import { ProcessSupervisor } from "../../process/supervisor.js";
import { assertBaseImage, assertImageId, assertSafeHyperVArgs, HYPERV_BACKEND_ID, HYPERV_CONTAINER_ID,
  HYPERV_GUEST_PATHS, hyperVOwnershipLabels, imageTagFor, isHyperVOwned, PRODUCTION_WINDOWS_BASE_IMAGE,
  workerNameFor } from "./config.js";

/**
 * Productionized Windows Hyper-V verification backend. Untrusted verification of a windows-required candidate runs in a
 * disposable Hyper-V worker VM (`--isolation=hyperv`), with `--network none` (no NIC), NO host bind mount of any kind,
 * and the candidate snapshot TRANSFERRED by being baked into a per-run image at build time (there is no host mount, and
 * `docker cp` is unsupported for a running Hyper-V container, so the result returns on the worker's own stdout). Only
 * the approved VerificationPlan runs (host-pinned absolute node + fixed argv + candidate-relative cwd). A pre/post
 * candidate fingerprint in the guest detects a read-only command that mutated the candidate. It PROVES WINDOWS BEHAVIOR
 * (`platformSemantics: "windows"`) and refuses a linux-compatible, platform-neutral-only or unknown requirement that a
 * windows backend cannot narrow. `productionEligible` stays the constant `false`: a backend never self-declares
 * eligibility; isolation-acceptance is a separate authority.
 */
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const WINDOWS_ABS = /^[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+$/u;
const MAX_COMMANDS = 32, MAX_ARGS = 64, MAX_ARG_BYTES = 8192, MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;

export interface HyperVBackendOptions {
  readonly baseImage?: string;
  readonly expectedImageId?: string;
  /** Absolute in-image executables a command may name. Default: the baked node only. */
  readonly allowedExecutables?: readonly string[];
  /** Host path to the node.exe baked into the worker image. Default: the running node (`process.execPath`). */
  readonly nodeExePath?: string;
  readonly buildTimeoutMs?: number;
  /** Time allowed beyond the summed command timeouts for worker start + guest exec. */
  readonly hostAllowanceMs?: number;
  readonly baseDirectory?: string;
  readonly clientEnvironment?: NodeJS.ProcessEnv;
  /** Test seams. An instance built with either is never a production instance. */
  readonly runner?: DockerCommandRunner;
  readonly resolveDocker?: () => Promise<string | null>;
}

export interface HyperVRunObservation {
  readonly runId: string;
  readonly imageTag: string;
  readonly imageId: string | null;
  readonly workerName: string;
  readonly isolation: "hyperv";
  readonly networkMode: string | null;
  readonly bindMountCount: number | null;
  readonly containerExitCode: number | null;
  readonly sourceMutated: boolean | null;
  readonly resultAccepted: boolean;
  readonly rejection?: string;
  readonly cleanupComplete: boolean;
}
export interface HyperVVerificationExecutionResult extends VerificationExecutionResult {
  readonly hyperv: HyperVRunObservation;
}

interface ReadyState { readonly server: DockerServerInfo; readonly image: DockerImageInfo; readonly imageReference: string; }
interface GuestCommand { readonly id: string; readonly executable: string; readonly args: readonly string[];
  readonly cwd: string; readonly timeoutMs: number; readonly mutationPolicy: "readOnly" | "allowMutation"; }
interface LeaseState {
  readonly runId: string;
  readonly nonce: string;
  readonly createdAt: string;
  readonly plan: VerificationPlan;
  readonly commands: readonly GuestCommand[];
  readonly engine: ReadyState;
  readonly stagingDir: string;
  readonly imageTag: string;
  readonly workerName: string;
  imageId: string | null;
  imageBuilt: boolean;
  workerCreated: boolean;
  ran: boolean;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

export function validateHyperVPlan(plan: VerificationPlan, allowedExecutables: readonly string[]): GuestCommand[] {
  const invalid = (message: string): never => failWith("InvalidInput", message);
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.commands) || plan.commands.length === 0 ||
      plan.commands.length > MAX_COMMANDS) invalid(`A Hyper-V verification plan needs between 1 and ${MAX_COMMANDS} commands.`);
  const ids = new Set<string>();
  let total = 0;
  return plan.commands.map(command => {
    if (command === null || typeof command !== "object") invalid("A verification command must be an object.");
    if (typeof command.id !== "string" || !COMMAND_ID.test(command.id) || ids.has(command.id))
      invalid("Verification command IDs must be unique short identifiers.");
    ids.add(command.id);
    if (!allowedExecutables.includes(command.executable))
      invalid("Hyper-V verification executables must be one of the backend's allowlisted in-image binaries.");
    if (!Array.isArray(command.args) || command.args.length > MAX_ARGS ||
        !command.args.every(arg => typeof arg === "string" && !arg.includes("\0") && Buffer.byteLength(arg, "utf8") <= MAX_ARG_BYTES))
      invalid("Verification arguments must be an explicit bounded array of strings.");
    if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > MAX_COMMAND_TIMEOUT_MS)
      invalid("Hyper-V verification timeouts must be between 1 ms and 30 minutes.");
    total += command.timeoutMs;
    if (command.mutationPolicy !== "readOnly" && command.mutationPolicy !== "allowMutation")
      invalid("Verification commands need an explicit mutation policy.");
    if (typeof command.cwd !== "string" || command.cwd.length === 0 || command.cwd.length > 256 ||
        /[\u0000-\u001f]/u.test(command.cwd) || /^[A-Za-z]:/.test(command.cwd) || command.cwd.startsWith("/") || command.cwd.startsWith("\\"))
      invalid("Verification cwd must be a relative path inside the candidate.");
    const parts = command.cwd.split(/[\\/]/u).filter(part => part !== "" && part !== ".");
    if (parts.includes("..")) invalid("Verification cwd must not contain '..'.");
    if (total > 60 * 60 * 1000) invalid("Hyper-V verification plans may not exceed one hour in total.");
    return Object.freeze({ id: command.id, executable: command.executable, args: Object.freeze([...command.args]),
      cwd: parts.length === 0 ? "." : parts.join("/"), timeoutMs: command.timeoutMs, mutationPolicy: command.mutationPolicy });
  });
}

const PRODUCTION_INSTANCES = new WeakSet<HyperVWindowsVerificationBackend>();
export function createProductionHyperVBackend(options: Readonly<{ baseDirectory?: string; clientEnvironment?: NodeJS.ProcessEnv;
  expectedImageId?: string }> = {}): HyperVWindowsVerificationBackend {
  const backend = new HyperVWindowsVerificationBackend({ baseImage: PRODUCTION_WINDOWS_BASE_IMAGE,
    ...(options.expectedImageId ? { expectedImageId: options.expectedImageId } : {}),
    ...(options.baseDirectory ? { baseDirectory: options.baseDirectory } : {}),
    ...(options.clientEnvironment ? { clientEnvironment: options.clientEnvironment } : {}) });
  PRODUCTION_INSTANCES.add(backend);
  return backend;
}
export const isProductionHyperVBackend = (backend: unknown): backend is HyperVWindowsVerificationBackend =>
  typeof backend === "object" && backend !== null && PRODUCTION_INSTANCES.has(backend as HyperVWindowsVerificationBackend);

export class HyperVWindowsVerificationBackend implements VerificationBackend {
  readonly id = HYPERV_BACKEND_ID;
  readonly confinement = "vm" as const;
  readonly productionEligible = false as const;
  readonly platformSemantics = "windows" as const;
  readonly #baseImage: string;
  readonly #expectedImageId: string | undefined;
  readonly #allowedExecutables: readonly string[];
  readonly #nodeExePath: string;
  readonly #buildTimeoutMs: number;
  readonly #hostAllowanceMs: number;
  readonly #base: string;
  readonly #leases = new WeakMap<VerificationLease, LeaseState>();
  #runner: DockerCommandRunner | undefined;
  #ready: ReadyState | undefined;

  constructor(private readonly options: HyperVBackendOptions = {}) {
    this.#baseImage = assertBaseImage(options.baseImage ?? PRODUCTION_WINDOWS_BASE_IMAGE);
    this.#expectedImageId = options.expectedImageId === undefined ? undefined : assertImageId(options.expectedImageId);
    const allowed = options.allowedExecutables ?? [HYPERV_GUEST_PATHS.node];
    if (allowed.length === 0 || !allowed.every(path => typeof path === "string" && WINDOWS_ABS.test(path)))
      failWith("InvalidInput", "Hyper-V allowed executables must be absolute in-image Windows paths.");
    this.#allowedExecutables = Object.freeze([...allowed]);
    this.#nodeExePath = options.nodeExePath ?? process.execPath;
    this.#buildTimeoutMs = options.buildTimeoutMs ?? 10 * 60_000;
    this.#hostAllowanceMs = options.hostAllowanceMs ?? 5 * 60_000;
    this.#base = options.baseDirectory ?? fusionTemporaryBase();
  }

  get observedEngine(): ReadyState | undefined { return this.#ready; }

  async #getRunner(): Promise<DockerCommandRunner | undefined> {
    if (this.#runner !== undefined) return this.#runner;
    const executable = await (this.options.resolveDocker ?? (() => resolveDockerCli()))();
    if (executable === null) return undefined;
    this.#runner = this.options.runner ?? new CliDockerRunner(executable, this.options.clientEnvironment ?? process.env,
      new ProcessSupervisor(), assertSafeHyperVArgs);
    return this.#runner;
  }
  #requireRunner(): DockerCommandRunner {
    if (this.#runner === undefined) failWith("CapabilityUnavailable", "Hyper-V backend was not probed successfully.");
    return this.#runner;
  }

  /** Availability derived from actual prerequisites: docker CLI present, a Windows engine, and the base image present. */
  async probe(signal?: AbortSignal): Promise<VerificationBackendProbe> {
    const unavailable = (reason: string): VerificationBackendProbe => {
      this.#ready = undefined;
      return { backendId: this.id, available: false, confinement: this.confinement, reason };
    };
    const runner = await this.#getRunner();
    if (runner === undefined) return unavailable("docker-cli-missing");
    const version = await runner.run({ args: ["version", "--format", "{{json .}}"], timeoutMs: 20_000,
      maxStdoutBytes: 64 * 1024, ...(signal ? { signal } : {}) });
    if (version.status === "cancelled") failWith("Cancelled", "Hyper-V probe was cancelled.");
    if (version.status === "spawnFailure") return unavailable("docker-cli-missing");
    if (version.status !== "exited") return unavailable("docker-cli-failed");
    const reading = parseDockerVersion(version.stdout);
    if (version.exitCode !== 0 || reading.kind === "noServer") return unavailable("docker-daemon-unavailable");
    if (reading.kind === "malformed") return unavailable("docker-version-malformed");
    if (reading.server.os !== "windows") return unavailable("docker-engine-not-windows");
    const image = await runner.run({ args: ["image", "inspect", "--format", "{{json .}}", this.#baseImage], timeoutMs: 20_000,
      maxStdoutBytes: 512 * 1024, ...(signal ? { signal } : {}) });
    if (image.status === "cancelled") failWith("Cancelled", "Hyper-V probe was cancelled.");
    if (image.status !== "exited") return unavailable("windows-base-image-inspect-failed");
    if (image.exitCode !== 0) return unavailable(isNoSuchObject(image) ? "windows-base-image-not-present" : "windows-base-image-inspect-failed");
    const info = parseImageInspect(image.stdout);
    if (info === undefined) return unavailable("windows-base-image-inspect-malformed");
    if (info.os !== "windows") return unavailable("windows-base-image-not-windows");
    if (this.#expectedImageId !== undefined && info.id !== this.#expectedImageId) return unavailable("windows-base-image-mismatch");
    this.#ready = Object.freeze({ server: reading.server, image: info, imageReference: this.#baseImage });
    return { backendId: this.id, available: true, confinement: this.confinement };
  }

  async #requireReady(signal?: AbortSignal): Promise<ReadyState> {
    if (this.#ready === undefined) {
      const probe = await this.probe(signal);
      if (!probe.available) failWith("CapabilityUnavailable", `Hyper-V verification backend is unavailable: ${probe.reason ?? "unknown"}.`);
    }
    return this.#ready!;
  }

  async prepare(request: VerificationExecutionRequest): Promise<VerificationLease> {
    assertPlatformEligible(this, request);
    assertDependencySupport(this, request);
    const commands = validateHyperVPlan(request.plan, this.#allowedExecutables);
    if (typeof request.workspaceRoot !== "string" || request.workspaceRoot.length === 0)
      failWith("InvalidInput", "Verification backend requires a workspace root.");
    const engine = await this.#requireReady(request.signal);
    const runId = hex(16);
    // Transfer the candidate by copying it into a Fusion-owned staging dir, EXCLUDING any .git (no shared Git state is
    // ever exposed to the untrusted verifier). The host workspace is only ever READ.
    const stagingDir = await mkdtemp(join(this.#base, "fusion-hvverify-"));
    const candidateCtx = join(stagingDir, "candidate");
    await cp(request.workspaceRoot, candidateCtx, { recursive: true, dereference: false,
      filter: src => !/(^|[\\/])\.git([\\/]|$)/u.test(src.slice(request.workspaceRoot.length)) });
    const lease: VerificationLease = Object.freeze({ backendId: this.id, confinement: this.confinement,
      workspaceRoot: request.workspaceRoot });
    this.#leases.set(lease, { runId, nonce: hex(16), createdAt: new Date().toISOString(), plan: request.plan, commands,
      engine, stagingDir, imageTag: imageTagFor(runId), workerName: workerNameFor(runId), imageId: null,
      imageBuilt: false, workerCreated: false, ran: false });
    return lease;
  }

  #state(lease: VerificationLease): LeaseState {
    const state = this.#leases.get(lease);
    if (state === undefined) failWith("InvalidInput", "Unknown Hyper-V verification lease.");
    return state;
  }

  async #build(state: LeaseState): Promise<void> {
    const runner = this.#requireRunner();
    const guestJs = await readFile(fileURLToPath(new URL("./guest-runner.js", import.meta.url)));
    await writeFile(join(state.stagingDir, "guest-runner.mjs"), guestJs);
    await cp(this.#nodeExePath, join(state.stagingDir, "node.exe"));
    const labels = Object.entries(hyperVOwnershipLabels(state.runId, state.createdAt))
      .map(([key, value]) => `LABEL ${key}=${value}`);
    const dockerfile = [
      `FROM ${this.#baseImage}`,
      ...labels,
      "COPY node.exe C:/fusion/node.exe",
      "COPY guest-runner.mjs C:/fusion/guest-runner.mjs",
      "COPY candidate C:/fusion/candidate",
      "USER ContainerUser",
    ].join("\n");
    await writeFile(join(state.stagingDir, "Dockerfile"), `${dockerfile}\n`);
    const build = await runner.run({ args: ["build", "--isolation=hyperv", "-t", state.imageTag, state.stagingDir],
      timeoutMs: this.#buildTimeoutMs, maxStdoutBytes: 1024 * 1024 });
    if (build.status !== "exited" || build.exitCode !== 0) failWith("ProcessFailure", "Hyper-V worker image build failed.");
    state.imageBuilt = true;
    const inspect = await runner.run({ args: ["image", "inspect", "--format", "{{json .}}", state.imageTag], timeoutMs: 20_000,
      maxStdoutBytes: 512 * 1024 });
    state.imageId = inspect.status === "exited" && inspect.exitCode === 0 ? parseImageInspect(inspect.stdout)?.id ?? null : null;
  }

  async #inspect(id: string): Promise<ContainerInspection | undefined> {
    const outcome = await this.#requireRunner().run({ args: ["container", "inspect", "--format", "{{json .}}", id],
      timeoutMs: 20_000, maxStdoutBytes: 512 * 1024 });
    if (outcome.status !== "exited" || outcome.exitCode !== 0) return undefined;
    return parseContainerInspect(outcome.stdout);
  }

  run(lease: VerificationLease, request: VerificationExecutionRequest): Promise<HyperVVerificationExecutionResult> {
    const state = this.#state(lease);
    if (state.ran) failWith("InvalidInput", "A Hyper-V verification lease runs exactly once.");
    state.ran = true;
    return this.#verify(state, request);
  }

  async #verify(state: LeaseState, request: VerificationExecutionRequest): Promise<HyperVVerificationExecutionResult> {
    const startedAt = new Date().toISOString();
    const obs = { networkMode: null as string | null, bindMountCount: null as number | null,
      containerExitCode: null as number | null, sourceMutated: null as boolean | null };
    if (request.signal?.aborted) return this.#result(state, startedAt, { kind: "cancelled" }, obs);
    await this.#build(state);
    const plan = { commands: state.commands, candidateRoot: HYPERV_GUEST_PATHS.candidate, nonce: state.nonce };
    const planB64 = Buffer.from(JSON.stringify(plan), "utf8").toString("base64");
    const deadlineMs = state.commands.reduce((sum, command) => sum + command.timeoutMs, 0) + this.#hostAllowanceMs;
    const runner = this.#requireRunner();
    const labels = Object.entries(hyperVOwnershipLabels(state.runId, state.createdAt)).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
    state.workerCreated = true;
    const attach = await runner.run({ args: ["run", "--name", state.workerName, "--isolation=hyperv", "--network", "none",
      ...labels, "--env", `FUSION_HV_PLAN=${planB64}`, state.imageTag, HYPERV_GUEST_PATHS.node, HYPERV_GUEST_PATHS.runner],
      timeoutMs: deadlineMs, maxStdoutBytes: MAX_RESULT_BYTES + 1, ...(request.signal ? { signal: request.signal } : {}) });
    const inspection = await this.#inspect(state.workerName).catch(() => undefined);
    if (inspection !== undefined) {
      obs.networkMode = inspection.networkMode;
      obs.bindMountCount = inspection.mounts.filter(m => m.type === "bind").length;
      obs.containerExitCode = inspection.exitCode;
    }
    if (attach.status === "cancelled" || (attach.status !== "exited" && request.signal?.aborted))
      return this.#result(state, startedAt, { kind: "cancelled" }, obs, inspection);
    if (attach.status === "timeout")
      return this.#result(state, startedAt, { kind: "failure", failure: { kind: "Timeout", retryable: true,
        safeMessage: "Hyper-V verification exceeded its host deadline; the worker was stopped." } }, obs, inspection);
    if (attach.status === "outputLimit")
      return this.#result(state, startedAt, { kind: "rejected", rejection: "Hyper-V guest result exceeded its size bound." }, obs, inspection);
    if (attach.status !== "exited")
      return this.#result(state, startedAt, { kind: "failure", failure: { kind: "ProcessFailure", retryable: false,
        safeMessage: "Hyper-V verification worker could not be run." } }, obs, inspection);
    const parsed = this.#parseResult(attach.stdout, state);
    if ("rejection" in parsed) return this.#result(state, startedAt, { kind: "rejected", rejection: parsed.rejection }, obs, inspection);
    obs.sourceMutated = parsed.sourceMutated;
    // Cross-check with the daemon-observed exit: the guest exits 0 exactly when every command passed and none was skipped.
    const allPassed = parsed.notRun.length === 0 && parsed.results.every(r => r.passed);
    if (inspection !== undefined && inspection.exitCode !== (allPassed ? 0 : 1))
      return this.#result(state, startedAt, { kind: "rejected",
        rejection: "Hyper-V guest result contradicts the daemon-observed worker exit status." }, obs, inspection);
    return this.#result(state, startedAt, { kind: "accepted", parsed }, obs, inspection);
  }

  #parseResult(stdout: string, state: LeaseState): ParsedGuestResult | { rejection: string } {
    const line = stdout.split(/\r?\n/u).find(entry => entry.startsWith("HV_RESULT_JSON "));
    if (line === undefined) return { rejection: "Hyper-V guest produced no result line." };
    let doc: Record<string, unknown>;
    try { doc = JSON.parse(line.slice("HV_RESULT_JSON ".length)) as Record<string, unknown>; }
    catch { return { rejection: "Hyper-V guest result was not valid JSON." }; }
    if (doc.fatal !== undefined) return { rejection: `Hyper-V guest runner failed: ${String(doc.fatal).slice(0, 80)}.` };
    if (doc.nonce !== state.nonce) return { rejection: "Hyper-V guest result nonce did not match." };
    const runtime = doc.runtime as { platform?: unknown } | undefined;
    if (runtime?.platform !== "win32") return { rejection: "Hyper-V guest runtime is not Windows." };
    const rawResults = Array.isArray(doc.results) ? doc.results as Record<string, unknown>[] : null;
    if (rawResults === null) return { rejection: "Hyper-V guest result is malformed (no results)." };
    const results = rawResults.map(r => ({ id: String(r.id), executable: String(r.executable), args: Array.isArray(r.args) ? r.args.map(String) : [],
      cwd: String(r.cwd), mutationPolicy: r.mutationPolicy === "allowMutation" ? "allowMutation" as const : "readOnly" as const,
      exitCode: typeof r.exitCode === "number" ? r.exitCode : null, timedOut: r.timedOut === true, cancelled: r.cancelled === true,
      spawnError: typeof r.spawnError === "string" ? r.spawnError : null, durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
      violatesReadOnly: r.violatesReadOnly === true, mutatedCandidate: r.mutatedCandidate === true,
      stdoutBytes: typeof r.stdoutBytes === "number" ? r.stdoutBytes : 0, stderrBytes: typeof r.stderrBytes === "number" ? r.stderrBytes : 0,
      passed: r.passed === true }));
    return { results, notRun: Array.isArray(doc.notRun) ? doc.notRun.map(String) : [], sourceMutated: doc.sourceMutated === true };
  }

  #result(state: LeaseState, startedAt: string,
    outcome: { kind: "cancelled" } | { kind: "failure"; failure: FusionError } | { kind: "rejected"; rejection: string } |
      { kind: "accepted"; parsed: ParsedGuestResult },
    obs: { networkMode: string | null; bindMountCount: number | null; containerExitCode: number | null; sourceMutated: boolean | null },
    _inspection?: ContainerInspection): HyperVVerificationExecutionResult {
    const planById = new Map(state.plan.commands.map(command => [command.id, command]));
    const allIds = state.commands.map(command => command.id);
    let report: VerificationReport;
    if (outcome.kind === "accepted") {
      const steps: VerificationStepResult[] = outcome.parsed.results.map(entry => {
        const command = planById.get(entry.id)!;
        const status: VerificationStepStatus = entry.timedOut ? "timeout" : entry.spawnError !== null ? "spawnFailure"
          : entry.violatesReadOnly ? "mutationViolation" : entry.exitCode === 0 ? "passed" : "failed";
        const failure = stepFailure(status, entry.id, entry.exitCode);
        const partialBase = { commandId: entry.id, executable: command.executable, args: [...command.args], cwd: command.cwd,
          startedAt, durationMs: entry.durationMs, stdoutArtifact: "", stderrArtifact: "", preDiffArtifact: "",
          postDiffArtifact: "", mutatedRepository: entry.mutatedCandidate, status, mutationPolicy: command.mutationPolicy,
          mutations: [] as string[], mutationProven: true, stdoutTruncated: entry.stdoutBytes > 4000, stderrTruncated: entry.stderrBytes > 4000 };
        return status === "passed" ? { ...partialBase, passed: true as const, exitCode: 0 as const }
          : { ...partialBase, passed: false as const, exitCode: entry.exitCode, ...(failure ? { failure } : {}) };
      });
      const failed = steps.find(step => step.status !== "passed");
      report = failed === undefined && steps.length === allIds.length && outcome.parsed.notRun.length === 0
        ? { passed: true, status: "passed", steps, notRun: [] }
        : { passed: false, status: "failed", steps, notRun: [...outcome.parsed.notRun],
          failure: failed?.failure ?? { kind: "VerificationFailure", retryable: false, safeMessage: "Hyper-V verification did not run every command." } };
    } else if (outcome.kind === "cancelled") {
      report = { passed: false, status: "cancelled", steps: [], notRun: allIds,
        failure: { kind: "Cancelled", retryable: false, safeMessage: "Hyper-V verification was cancelled." } };
    } else {
      report = { passed: false, status: "failed", steps: [], notRun: allIds, failure: outcome.kind === "failure" ? outcome.failure
        : { kind: "MalformedOutput", retryable: false, safeMessage: outcome.rejection } };
    }
    const hyperv: HyperVRunObservation = Object.freeze({ runId: state.runId, imageTag: state.imageTag, imageId: state.imageId,
      workerName: state.workerName, isolation: "hyperv", networkMode: obs.networkMode, bindMountCount: obs.bindMountCount,
      containerExitCode: obs.containerExitCode, sourceMutated: obs.sourceMutated, resultAccepted: outcome.kind === "accepted",
      ...(outcome.kind === "rejected" ? { rejection: outcome.rejection } : {}), cleanupComplete: false });
    return { backendId: this.id, confinement: this.confinement, report, passed: report.passed, hyperv };
  }

  collectProof(): Promise<undefined> { return Promise.resolve(undefined); }

  /** Removes this lease's worker and per-run image, then its staging dir; an unproven removal is reported, not hidden. */
  async dispose(lease: VerificationLease): Promise<VerificationCleanupResult> {
    const state = this.#state(lease);
    const runner = this.#runner;
    const reasons: string[] = [];
    if (runner !== undefined && state.workerCreated) {
      await runner.run({ args: ["kill", state.workerName], timeoutMs: 20_000, maxStdoutBytes: 4096 }).catch(() => undefined);
      const removed = await runner.run({ args: ["rm", "-f", state.workerName], timeoutMs: 30_000, maxStdoutBytes: 4096 });
      if (removed.status !== "exited" || (removed.exitCode !== 0 && !isNoSuchObject(removed))) reasons.push("worker-not-removed");
    }
    if (runner !== undefined && state.imageBuilt) {
      const rmi = await runner.run({ args: ["rmi", "-f", state.imageTag], timeoutMs: 60_000, maxStdoutBytes: 4096 });
      if (rmi.status !== "exited" || (rmi.exitCode !== 0 && !isNoSuchObject(rmi))) reasons.push("image-not-removed");
    }
    await rm(state.stagingDir, { recursive: true, force: true }).catch(() => reasons.push("staging-not-removed"));
    return reasons.length === 0 ? { complete: true } : { complete: false, reason: reasons.join("; ") };
  }

  /** Crash recovery: remove stale, fully Fusion-owned Hyper-V workers older than the longest possible run. */
  async recoverStale(_signal?: AbortSignal, options: Readonly<{ minAgeMs?: number; nowMs?: number }> = {}): Promise<RecoveryReport> {
    const runner = await this.#getRunner();
    if (runner === undefined) return { complete: true, removed: 0, reasons: ["docker-cli-missing: nothing to recover"] };
    const minAgeMs = options.minAgeMs ?? 2 * 60 * 60_000, nowMs = options.nowMs ?? Date.now();
    const listed = await runner.run({ args: ["ps", "--all", "--no-trunc", "--filter", `label=${"fusion.backend"}=${HYPERV_BACKEND_ID}`,
      "--format", "{{.ID}}"], timeoutMs: 20_000, maxStdoutBytes: 256 * 1024 });
    if (listed.status !== "exited" || listed.exitCode !== 0) return { complete: false, removed: 0, reasons: ["list-failed"] };
    const ids = listed.stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => HYPERV_CONTAINER_ID.test(line));
    let removed = 0; const reasons: string[] = [];
    for (const id of ids) {
      const inspection = await this.#inspect(id).catch(() => undefined);
      if (inspection === undefined || !isHyperVOwned(inspection.labels)) continue;
      if (inspection.running || nowMs - Date.parse(inspection.created) < minAgeMs) continue;
      const rm = await runner.run({ args: ["rm", "-f", id], timeoutMs: 30_000, maxStdoutBytes: 4096 });
      if (rm.status === "exited" && (rm.exitCode === 0 || isNoSuchObject(rm))) removed++; else reasons.push("stale-worker-not-removed");
    }
    return { complete: reasons.length === 0, removed, reasons };
  }
}

interface ParsedGuestResult {
  readonly results: readonly Readonly<{ id: string; executable: string; args: readonly string[]; cwd: string;
    mutationPolicy: "readOnly" | "allowMutation"; exitCode: number | null; timedOut: boolean; cancelled: boolean;
    spawnError: string | null; durationMs: number; violatesReadOnly: boolean; mutatedCandidate: boolean;
    stdoutBytes: number; stderrBytes: number; passed: boolean }>[];
  readonly notRun: readonly string[];
  readonly sourceMutated: boolean;
}

function stepFailure(status: VerificationStepStatus, id: string, exitCode: number | null): FusionError | undefined {
  if (status === "passed") return undefined;
  if (status === "timeout") return { kind: "Timeout", retryable: true, safeMessage: `Command ${id} timed out.` };
  if (status === "spawnFailure") return { kind: "ProcessFailure", retryable: false, safeMessage: `Command ${id} could not start.` };
  if (status === "mutationViolation") return { kind: "SecurityViolation", retryable: false, safeMessage: `Command ${id} mutated the candidate under a read-only policy.` };
  return { kind: "VerificationFailure", retryable: false, safeMessage: `Command ${id} failed (exit ${exitCode ?? "null"}).` };
}
