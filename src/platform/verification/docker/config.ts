import { posix, win32 } from "node:path";
import { failWith } from "../../../core/errors.js";
import { assertNoCredentialKeys } from "../verifier-environment.js";

/**
 * Host-controlled configuration of the Docker/Linux verification container. Every value that reaches the `docker`
 * argv is produced here from validated host data — never from a model, a task, or repository content — and the argv
 * is always spawned directly (no shell). Nothing here can mount the Docker socket, the primary repository, a user
 * profile or provider state, share a host namespace, add a capability or pass a device.
 */
export const DOCKER_BACKEND_ID = "docker-linux";
export const DOCKER_PROTOCOL_VERSION = 1;

export const GUEST_PATHS = Object.freeze({
  input: "/fusion/input", work: "/fusion/work", tmp: "/tmp", runner: "/fusion/input/runner.mjs",
  node: "/usr/local/bin/node",
});
/** Unprivileged numeric identity; `1000:1000` is the `node` user of the official Node images. */
export const GUEST_USER = "1000:1000";
export const GUEST_MODES = Object.freeze(["verify", "canary", "descendant", "hang"] as const);
export type GuestMode = typeof GUEST_MODES[number];

export const OWNER_LABELS = Object.freeze({ owner: "fusion.owner", backend: "fusion.backend", run: "fusion.run",
  protocol: "fusion.protocol", created: "fusion.created" });

export const RUN_ID = /^[0-9a-f]{32}$/u;
export const NONCE = /^[0-9a-f]{32}$/u;
export const CONTAINER_ID = /^[0-9a-f]{64}$/u;
/**
 * Production images are pinned by digest only (`repository@sha256:<64 hex>`). A tag — `latest` or any other — is a
 * floating reference and is refused, so the backend can never silently run a different image. The backend never pulls.
 */
const PINNED_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*){0,3}@sha256:[0-9a-f]{64}$/u;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
/** Characters the `--mount` CSV parser or the argv would misread; such a path is refused, never quoted. */
const UNSAFE_MOUNT_PATH = /[,"'\u0000-\u001f\u007f]/u;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;
const ENV_VALUE = /^[\x20-\x7e]{0,512}$/u;

export function assertPinnedImage(reference: unknown): string {
  if (typeof reference !== "string" || reference.length > 256 || !PINNED_IMAGE.test(reference))
    failWith("InvalidInput", "Docker verification images must be pinned by digest (repository@sha256:<digest>); tags are refused.");
  return reference;
}
export function assertImageId(id: unknown): string {
  if (typeof id !== "string" || !IMAGE_ID.test(id)) failWith("InvalidInput", "Docker image id must be sha256:<64 hex>.");
  return id;
}
export function imageDigest(reference: string): string { return reference.slice(reference.indexOf("@") + 1); }

export interface DockerResourceLimits {
  readonly memoryBytes: number;
  /** CPU quota in billionths of a CPU (Docker `NanoCpus`). */
  readonly nanoCpus: number;
  readonly pids: number;
  readonly workTmpfsMiB: number;
  readonly tmpTmpfsMiB: number;
}
export const DEFAULT_DOCKER_LIMITS: DockerResourceLimits = Object.freeze({
  memoryBytes: 1024 * 1024 * 1024, nanoCpus: 2_000_000_000, pids: 256, workTmpfsMiB: 512, tmpTmpfsMiB: 128,
});
const LIMIT_BOUNDS: Readonly<Record<keyof DockerResourceLimits, readonly [number, number]>> = Object.freeze({
  memoryBytes: [64 * 1024 * 1024, 8 * 1024 * 1024 * 1024], nanoCpus: [100_000_000, 8_000_000_000], pids: [32, 4096],
  workTmpfsMiB: [16, 4096], tmpTmpfsMiB: [8, 1024],
});
export function resolveLimits(overrides: Partial<DockerResourceLimits> = {}): DockerResourceLimits {
  const limits = { ...DEFAULT_DOCKER_LIMITS, ...overrides };
  for (const [key, [min, max]] of Object.entries(LIMIT_BOUNDS) as [keyof DockerResourceLimits, readonly [number, number]][]) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < min || value > max)
      failWith("InvalidInput", `Docker resource limit ${key} is out of range.`);
  }
  if (limits.nanoCpus % 1_000_000 !== 0) failWith("InvalidInput", "Docker CPU quota must be a multiple of 0.001 CPU.");
  return Object.freeze(limits);
}

/** An absolute host directory Fusion created for this run, safe to place in a `--mount` value. */
export function assertMountSource(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024 || UNSAFE_MOUNT_PATH.test(path) ||
      !(win32.isAbsolute(path) || posix.isAbsolute(path)))
    failWith("InvalidInput", "Docker bind source must be an absolute Fusion-owned path without separators the mount parser would misread.");
  return path;
}

export interface ContainerSpec {
  readonly runId: string;
  readonly mode: GuestMode;
  readonly image: string;
  /** Host directory mounted read-only at `/fusion/input`; the ONLY host path the container can see. */
  readonly inputDirectory: string;
  readonly limits: DockerResourceLimits;
  /** Complete container environment (see `buildContainerVerifierEnvironment`). No host value is forwarded. */
  readonly env: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export const containerName = (runId: string, mode: GuestMode): string => `fusion-${mode}-${runId}`;
export function ownershipLabels(runId: string, createdAt: string): Readonly<Record<string, string>> {
  return Object.freeze({ [OWNER_LABELS.owner]: "true", [OWNER_LABELS.backend]: DOCKER_BACKEND_ID, [OWNER_LABELS.run]: runId,
    [OWNER_LABELS.protocol]: String(DOCKER_PROTOCOL_VERSION), [OWNER_LABELS.created]: createdAt });
}

const cpus = (nano: number): string => String(nano / 1_000_000_000);

/**
 * The complete `docker create` argv for one Fusion verification container. Hardening, in order: never pull; Fusion
 * ownership labels; no network at all; every capability dropped; no privilege escalation (setuid/file caps);
 * read-only root filesystem; unprivileged user; bounded memory (swap equal, so no extra swap), CPU and PIDs; private
 * IPC and cgroup namespaces; a minimal init that reaps descendants; no log storage for untrusted output; no core
 * dumps; two size-bounded tmpfs scratch areas; one read-only bind of the run's input bundle; and node as the
 * entrypoint, so no shell interprets anything. Docker's default seccomp and AppArmor profiles stay in force.
 */
export function buildCreateArgs(spec: ContainerSpec): string[] {
  if (!RUN_ID.test(spec.runId)) failWith("InvalidInput", "Docker run id is invalid.");
  if (!(GUEST_MODES as readonly string[]).includes(spec.mode)) failWith("InvalidInput", "Docker guest mode is invalid.");
  if (!ISO_TIME.test(spec.createdAt)) failWith("InvalidInput", "Docker creation time is invalid.");
  const image = assertPinnedImage(spec.image), input = assertMountSource(spec.inputDirectory);
  const limits = resolveLimits(spec.limits);
  const envArgs: string[] = [];
  assertNoCredentialKeys(spec.env);
  for (const [key, value] of Object.entries(spec.env)) {
    if (!ENV_KEY.test(key) || typeof value !== "string" || !ENV_VALUE.test(value))
      failWith("InvalidInput", "Docker container environment entries must be fixed printable key=value pairs.");
    envArgs.push("--env", `${key}=${value}`);
  }
  const labels = Object.entries(ownershipLabels(spec.runId, spec.createdAt)).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  return [
    "create", "--pull", "never", "--name", containerName(spec.runId, spec.mode), ...labels,
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges=true",
    "--read-only",
    "--user", GUEST_USER,
    "--memory", String(limits.memoryBytes), "--memory-swap", String(limits.memoryBytes),
    "--cpus", cpus(limits.nanoCpus),
    "--pids-limit", String(limits.pids),
    "--ipc", "private", "--cgroupns", "private",
    "--init",
    "--log-driver", "none",
    "--ulimit", "core=0:0",
    "--hostname", "fusion-verifier",
    "--tmpfs", `${GUEST_PATHS.work}:rw,nosuid,nodev,exec,size=${limits.workTmpfsMiB}m,uid=1000,gid=1000,mode=0700`,
    "--tmpfs", `${GUEST_PATHS.tmp}:rw,nosuid,nodev,noexec,size=${limits.tmpTmpfsMiB}m,uid=1000,gid=1000,mode=0700`,
    "--mount", `type=bind,source=${input},target=${GUEST_PATHS.input},readonly`,
    "--workdir", GUEST_PATHS.work,
    "--entrypoint", GUEST_PATHS.node,
    ...envArgs,
    image, GUEST_PATHS.runner, spec.mode,
  ];
}

/** The only docker subcommands the backend may ever run; `image`/`container` only for `inspect`. */
const ALLOWED_SUBCOMMANDS = new Set(["version", "image", "container", "create", "start", "wait", "kill", "rm", "top", "ps"]);
/**
 * Defense in depth for every docker invocation, independent of the builder: refuses any argv that could weaken the
 * container (privileged, host namespaces, added capabilities, devices, volumes, other networks, disabled confinement
 * profiles, the Docker socket) or run destructive/global subcommands (`system prune`, `volume rm`, …).
 */
export function assertSafeDockerArgs(args: readonly string[]): void {
  const refuse = (): never => failWith("SecurityViolation", "A docker invocation outside the backend's hardened allowlist was refused.");
  if (!Array.isArray(args) || args.length === 0 || args.length > 256 ||
      !args.every(arg => typeof arg === "string" && !arg.includes("\0") && arg.length <= 4096)) refuse();
  const [command, sub] = args;
  if (!ALLOWED_SUBCOMMANDS.has(command!)) refuse();
  if ((command === "image" || command === "container") && sub !== "inspect") refuse();
  // A flag's value is either inline (`--flag=value`) or the next argument.
  const valueOf = (index: number): string => {
    const arg = args[index]!, equals = arg.indexOf("=");
    return arg.startsWith("--") && equals > 0 ? arg.slice(equals + 1) : args[index + 1] ?? "";
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (/docker\.sock|docker_engine|dockerDesktop/iu.test(arg)) refuse();
    if (!arg.startsWith("-")) continue;
    const flag = arg.split("=", 1)[0]!;
    if (["--privileged", "--cap-add", "--device", "--device-cgroup-rule", "--gpus", "--volume", "-v", "--volumes-from",
      "--pid", "--userns", "--uts", "--add-host", "--publish", "-p", "--publish-all", "-P", "--env-file", "--mount-proc",
      "--sysctl", "--runtime", "--isolation", "--link", "--dns"].includes(flag)) refuse();
    if (flag === "--network" && valueOf(index) !== "none") refuse();
    if (flag === "--ipc" && valueOf(index) !== "private") refuse();
    if (flag === "--security-opt" && !/^no-new-privileges(?:[=:]true)?$/u.test(valueOf(index))) refuse();
    // `-e KEY` without a value would forward the docker client's own environment into the container.
    if ((flag === "--env" || flag === "-e") && !valueOf(index).includes("=")) refuse();
    if (flag === "--mount" && !/^type=bind,source=[^,]+,target=\/fusion\/input,readonly$/u.test(valueOf(index))) refuse();
  }
}

/** Host variables the docker CLI itself may see (for its config and named-pipe/socket discovery). No secret shape. */
export const DOCKER_CLIENT_FORWARDED_KEYS = Object.freeze(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE",
  "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
  "XDG_RUNTIME_DIR"] as const);
/**
 * Environment for the docker CLI process. It is an allowlist: provider credentials, tokens, SSH agents and even
 * `DOCKER_HOST` (which could ship the bundle to a remote daemon) never reach the client, so they cannot reach the
 * container by any `--env` misuse either. Keys are matched case-insensitively (Windows) and keep their real spelling.
 */
export function buildDockerClientEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set<string>(DOCKER_CLIENT_FORWARDED_KEYS);
  const env: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (!allowed.has(upper) || seen.has(upper) || typeof value !== "string" || value.includes("\0")) continue;
    seen.add(upper);
    env[key] = value;
  }
  env.DOCKER_CLI_HINTS = "false";
  assertNoCredentialKeys(env);
  return env;
}

/** Fusion ownership is proven only by ALL labels, never by a container name prefix. */
export function isFusionOwned(labels: unknown, runId?: string): boolean {
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) return false;
  const record = labels as Record<string, unknown>;
  const run = record[OWNER_LABELS.run];
  return record[OWNER_LABELS.owner] === "true" && record[OWNER_LABELS.backend] === DOCKER_BACKEND_ID &&
    typeof run === "string" && RUN_ID.test(run) && (runId === undefined || run === runId) &&
    record[OWNER_LABELS.protocol] === String(DOCKER_PROTOCOL_VERSION) &&
    typeof record[OWNER_LABELS.created] === "string" && ISO_TIME.test(record[OWNER_LABELS.created] as string);
}

export interface OwnedContainerRecord {
  readonly id: string;
  readonly labels: unknown;
}
/**
 * FUTURE crash-recovery scavenger selection (not wired to any command in this release). A container qualifies only
 * with a full 64-hex id, every Fusion ownership label, and a creation label older than `minAgeMs`, so a live run, a
 * foreign container, or one merely named `fusion-*` is never selected. Broad prefix deletion is impossible by design.
 */
export function selectScavengeableContainers(records: readonly OwnedContainerRecord[], nowMs: number,
  minAgeMs: number): string[] {
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(minAgeMs) || minAgeMs < 60_000)
    failWith("InvalidInput", "Scavenger age threshold must be at least one minute.");
  return records.filter(record => typeof record.id === "string" && CONTAINER_ID.test(record.id) &&
    isFusionOwned(record.labels) &&
    nowMs - Date.parse((record.labels as Record<string, string>)[OWNER_LABELS.created]!) >= minAgeMs)
    .map(record => record.id);
}
