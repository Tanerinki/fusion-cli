import { failWith } from "../../../core/errors.js";
import { resolveExecutableOnPath } from "../../process/native-executable.js";
import { parseStrictJson, StrictJsonError } from "../../process/strict-json.js";
import { ProcessSupervisor, type RunningProcess } from "../../process/supervisor.js";
import { assertSafeDockerArgs, buildDockerClientEnvironment } from "./config.js";
import { fusionTemporaryBase } from "../../fs/temporary.js";

/**
 * The seam between the backend and the `docker` CLI. The production runner spawns the resolved native `docker`
 * executable directly with an argv array (`shell:false`, via `ProcessSupervisor`), with bounded output, a deadline,
 * cancellation, and an allowlisted client environment. Every argv is checked by `assertSafeDockerArgs` first.
 * Tests substitute a scripted fake; normal `npm test` never needs Docker.
 */
export interface DockerInvocation {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes?: number;
  readonly signal?: AbortSignal;
  /**
   * Bytes streamed to the client's stdin (for `start --attach --interactive`), with backpressure; stdin is closed at
   * the end. A container that stops reading early simply ends the stream — the outcome decides, never the write.
   */
  readonly input?: DockerInput;
  /** Streams stdout line by line instead of retaining it (dependency artifacts); `stdout` is then empty. */
  readonly onStdoutLine?: (line: string) => void;
}
export interface DockerInput {
  readonly bytes: number;
  chunks(): AsyncIterable<Uint8Array>;
}
export type DockerOutcomeStatus = "exited" | "timeout" | "cancelled" | "spawnFailure" | "outputLimit" | "processError";
export interface DockerOutcome {
  readonly status: DockerOutcomeStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  /** Bounded; used only to classify well-known daemon errors, never surfaced verbatim. */
  readonly stderr: string;
  readonly durationMs: number;
}
export interface DockerCommandRunner {
  run(invocation: DockerInvocation): Promise<DockerOutcome>;
}

export const DOCKER_CLI_LIMITS = Object.freeze({ defaultStdoutBytes: 1024 * 1024, stderrBytes: 64 * 1024 });

export class CliDockerRunner implements DockerCommandRunner {
  readonly #env: NodeJS.ProcessEnv;
  /**
   * `validateArgs` is the hardened argv allowlist applied before every spawn. It defaults to the Docker/Linux
   * allowlist; the Windows Hyper-V backend passes its own (`assertSafeHyperVArgs`), which permits `--isolation=hyperv`,
   * `build` and `exec` while still refusing every mount/volume, the Docker socket and any non-`none` network.
   */
  constructor(private readonly executable: string, source: NodeJS.ProcessEnv = process.env,
    private readonly supervisor = new ProcessSupervisor(),
    private readonly validateArgs: (args: readonly string[]) => void = assertSafeDockerArgs) {
    this.#env = buildDockerClientEnvironment(source);
  }

  async run(invocation: DockerInvocation): Promise<DockerOutcome> {
    this.validateArgs(invocation.args);
    const lines = invocation.onStdoutLine === undefined ? undefined : new LineSplitter(invocation.onStdoutLine);
    const running = this.supervisor.start({ executable: this.executable, args: [...invocation.args], cwd: fusionTemporaryBase(),
      env: this.#env, timeoutMs: invocation.timeoutMs,
      maxStdoutBytes: invocation.maxStdoutBytes ?? DOCKER_CLI_LIMITS.defaultStdoutBytes,
      maxStderrBytes: DOCKER_CLI_LIMITS.stderrBytes, outputLimitAction: "cancel", stdoutDecoding: "strict",
      ...(lines ? { retainStdout: false, onStdoutText: (text: string) => lines.push(text) } : {}),
      ...(invocation.input ? { keepStdinOpen: true } : {}),
      ...(invocation.signal ? { signal: invocation.signal } : {}) });
    if (invocation.input) void pumpInput(running, invocation.input);
    const outcome = await running.result;
    lines?.finish();
    const issue = outcome.issue?.kind;
    const status: DockerOutcomeStatus = outcome.termination?.cleanupError ? "processError"
      : issue === undefined ? "exited" : issue === "Timeout" ? "timeout" : issue === "Cancelled" ? "cancelled"
      : issue === "SpawnFailure" ? "spawnFailure" : issue === "OutputLimit" ? "outputLimit" : "processError";
    return { status, exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr, durationMs: outcome.durationMs };
  }
}

/** Writes the input with backpressure, then closes stdin. Write failures end the pump; the process outcome decides. */
async function pumpInput(running: RunningProcess, input: DockerInput): Promise<void> {
  try {
    for await (const chunk of input.chunks()) await running.writeStdin(chunk);
  } catch { /* the container stopped reading (or failed); its outcome is authoritative */ }
  finally { running.closeStdin(); }
}

/** A line longer than this is never buffered: the consumer receives `OVERLONG_LINE` once and the rest is dropped. */
export const MAX_STREAMED_LINE_CHARS = 1024 * 1024;
export const OVERLONG_LINE = "\u0000overlong-line";
/** Splits streamed stdout text into bounded lines; an observer failure is surfaced by the supervisor as an observer issue. */
export class LineSplitter {
  #pending = "";
  #overlong = false;
  constructor(private readonly onLine: (line: string) => void, private readonly maxChars = MAX_STREAMED_LINE_CHARS) {}
  push(text: string): void {
    let rest = text;
    for (let newline = rest.indexOf("\n"); newline >= 0; newline = rest.indexOf("\n")) {
      this.#append(rest.slice(0, newline));
      if (!this.#overlong) this.onLine(this.#pending);
      this.#pending = ""; this.#overlong = false;
      rest = rest.slice(newline + 1);
    }
    this.#append(rest);
  }
  #append(text: string): void {
    if (this.#overlong) return;
    if (this.#pending.length + text.length > this.maxChars) { this.#overlong = true; this.#pending = ""; this.onLine(OVERLONG_LINE); return; }
    this.#pending += text;
  }
  finish(): void { if (this.#pending !== "" && !this.#overlong) { const rest = this.#pending; this.#pending = ""; this.onLine(rest); } }
}

/** The native docker CLI on PATH (`docker.exe` on Windows; wrappers are never selected), or null. */
export function resolveDockerCli(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return resolveExecutableOnPath("docker", env);
}

/** A daemon "no such object" answer, as opposed to an unreachable daemon. */
export const isNoSuchObject = (outcome: DockerOutcome): boolean =>
  outcome.status === "exited" && outcome.exitCode !== 0 && /No such (?:container|object|image)/u.test(outcome.stderr);

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const SAFE_LABEL = /^[A-Za-z0-9 ._()+:\-/]{1,96}$/u;
const safe = (value: unknown): string | undefined => typeof value === "string" && SAFE_LABEL.test(value) ? value : undefined;

function strict(text: string, maxBytes: number, depth: number): unknown {
  if (Buffer.byteLength(text, "utf8") > maxBytes) return undefined;
  try { return parseStrictJson(text.trim(), depth); }
  catch (error) { if (error instanceof StrictJsonError) return undefined; throw error; }
}

export interface DockerServerInfo {
  readonly os: string;
  readonly arch: string;
  readonly version: string;
  readonly kernelVersion: string;
  readonly platformName: string;
}
export type VersionReading = Readonly<{ kind: "server"; server: DockerServerInfo }> | Readonly<{ kind: "noServer" }> |
  Readonly<{ kind: "malformed" }>;
/** Parses `docker version --format '{{json .}}'`. A missing `Server` means the daemon is unreachable. */
export function parseDockerVersion(stdout: string): VersionReading {
  const value = strict(stdout, 64 * 1024, 16);
  if (!isRecord(value) || !isRecord(value.Client)) return { kind: "malformed" };
  if (value.Server === null || value.Server === undefined) return { kind: "noServer" };
  const server = value.Server;
  if (!isRecord(server)) return { kind: "malformed" };
  const os = safe(server.Os), arch = safe(server.Arch), version = safe(server.Version);
  if (os === undefined || arch === undefined || version === undefined) return { kind: "malformed" };
  return { kind: "server", server: Object.freeze({ os, arch, version, kernelVersion: safe(server.KernelVersion) ?? "unknown",
    platformName: isRecord(server.Platform) ? safe(server.Platform.Name) ?? "unknown" : "unknown" }) };
}

export interface DockerImageInfo {
  readonly id: string;
  readonly repoDigests: readonly string[];
  readonly os: string;
  readonly architecture: string;
  /** Environment KEY names declared by the image (values are never kept). */
  readonly envKeys: readonly string[];
}
/** Parses `docker image inspect --format '{{json .}}' <ref>` for one image, or undefined when malformed. */
export function parseImageInspect(stdout: string): DockerImageInfo | undefined {
  const value = strict(stdout, 512 * 1024, 32);
  if (!isRecord(value) || typeof value.Id !== "string" || !Array.isArray(value.RepoDigests)) return undefined;
  const os = safe(value.Os), architecture = safe(value.Architecture);
  if (os === undefined || architecture === undefined || !value.RepoDigests.every(entry => typeof entry === "string")) return undefined;
  const env = isRecord(value.Config) && Array.isArray(value.Config.Env) ? value.Config.Env : [];
  return Object.freeze({ id: value.Id, repoDigests: Object.freeze([...value.RepoDigests as string[]]), os, architecture,
    envKeys: Object.freeze(env.filter((entry): entry is string => typeof entry === "string").map(entry => entry.split("=", 1)[0]!)) });
}

/** The daemon-reported configuration and state of one container: only the fields confinement evidence needs. */
export interface ContainerInspection {
  readonly id: string;
  readonly image: string;
  /** Daemon-recorded creation time (trusted metadata, independent of Fusion's own label). */
  readonly created: string;
  readonly openStdin: boolean;
  readonly stdinOnce: boolean;
  readonly running: boolean;
  readonly exitCode: number | null;
  readonly oomKilled: boolean;
  readonly user: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly envKeys: readonly string[];
  readonly privileged: boolean;
  readonly capAdd: readonly string[];
  readonly capDrop: readonly string[];
  readonly securityOpt: readonly string[];
  readonly readonlyRootfs: boolean;
  readonly networkMode: string;
  readonly pidMode: string;
  readonly ipcMode: string;
  readonly utsMode: string;
  readonly usernsMode: string;
  readonly cgroupnsMode: string;
  readonly memory: number;
  readonly memorySwap: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number | null;
  readonly deviceCount: number;
  readonly tmpfsTargets: readonly string[];
  readonly bindCount: number;
  readonly logType: string;
  readonly init: boolean;
  readonly maskedPathCount: number;
  readonly mounts: readonly Readonly<{ type: string; source: string; destination: string; rw: boolean }>[];
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const num = (value: unknown): number => Number.isSafeInteger(value) ? value as number : -1;
const str = (value: unknown): string => typeof value === "string" ? value : "";

/** Parses `docker container inspect --format '{{json .}}' <id>`, or undefined when malformed. */
export function parseContainerInspect(stdout: string): ContainerInspection | undefined {
  const value = strict(stdout, 512 * 1024, 32);
  if (!isRecord(value) || !isRecord(value.State) || !isRecord(value.Config) || !isRecord(value.HostConfig) ||
      typeof value.Id !== "string" || !Array.isArray(value.Mounts)) return undefined;
  const { State: state, Config: config, HostConfig: host } = value as { State: Json; Config: Json; HostConfig: Json };
  const labels = isRecord(config.Labels) ? Object.fromEntries(Object.entries(config.Labels)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  const mounts = value.Mounts.filter(isRecord).map(mount => Object.freeze({ type: str(mount.Type), source: str(mount.Source),
    destination: str(mount.Destination), rw: mount.RW !== false }));
  if (mounts.length !== value.Mounts.length) return undefined;
  const devices = (Array.isArray(host.Devices) ? host.Devices.length : 0) + (Array.isArray(host.DeviceRequests) ? host.DeviceRequests.length : 0) +
    (Array.isArray(host.DeviceCgroupRules) ? host.DeviceCgroupRules.length : 0);
  return Object.freeze({
    id: value.Id, image: str(value.Image), created: str(value.Created), openStdin: config.OpenStdin === true,
    stdinOnce: config.StdinOnce === true, running: state.Running === true,
    exitCode: Number.isSafeInteger(state.ExitCode) ? state.ExitCode as number : null, oomKilled: state.OOMKilled === true,
    user: str(config.User), labels: Object.freeze(labels),
    envKeys: Object.freeze(strings(config.Env).map(entry => entry.split("=", 1)[0]!)),
    privileged: host.Privileged !== false, capAdd: Object.freeze(strings(host.CapAdd)), capDrop: Object.freeze(strings(host.CapDrop)),
    securityOpt: Object.freeze(strings(host.SecurityOpt)), readonlyRootfs: host.ReadonlyRootfs === true,
    networkMode: str(host.NetworkMode), pidMode: str(host.PidMode), ipcMode: str(host.IpcMode), utsMode: str(host.UTSMode),
    usernsMode: str(host.UsernsMode), cgroupnsMode: str(host.CgroupnsMode), memory: num(host.Memory),
    memorySwap: num(host.MemorySwap), nanoCpus: num(host.NanoCpus),
    pidsLimit: Number.isSafeInteger(host.PidsLimit) ? host.PidsLimit as number : null, deviceCount: devices,
    tmpfsTargets: Object.freeze(isRecord(host.Tmpfs) ? Object.keys(host.Tmpfs).sort() : []),
    bindCount: strings(host.Binds).length, logType: isRecord(host.LogConfig) ? str(host.LogConfig.Type) : "",
    init: host.Init === true, maskedPathCount: strings(host.MaskedPaths).length, mounts: Object.freeze(mounts),
  });
}

/** Runs one docker command and requires a clean exit; the caller supplies a stable failure message. */
export async function requireExited(runner: DockerCommandRunner, invocation: DockerInvocation, what: string): Promise<DockerOutcome> {
  const outcome = await runner.run(invocation);
  if (outcome.status === "cancelled") failWith("Cancelled", `Docker ${what} was cancelled.`);
  if (outcome.status !== "exited" || outcome.exitCode !== 0) failWith("ProcessFailure", `Docker ${what} failed.`);
  return outcome;
}
