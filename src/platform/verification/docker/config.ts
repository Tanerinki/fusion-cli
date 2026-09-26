import { failWith } from "../../../core/errors.js";
import { assertNoCredentialKeys } from "../verifier-environment.js";

/**
 * Host-controlled configuration of the Docker/Linux verification container. Every value that reaches the `docker`
 * argv is produced here from validated host data — never from a model, a task, or repository content — and the argv
 * is always spawned directly (no shell). Nothing here can mount anything: since protocol 2 the container has NO host
 * mount at all (no bind, no volume); every input arrives over the attached stdin. Nothing can mount the Docker socket,
 * share a host namespace, add a capability or pass a device.
 */
export const DOCKER_BACKEND_ID = "docker-linux";
export const DOCKER_PROTOCOL_VERSION = 2;
/** Protocol labels a crash-recovery sweep recognises as Fusion-owned (the O5.5B5 prototype used protocol 1). */
export const OWNED_PROTOCOL_VERSIONS = Object.freeze(["1", "2"]);

export const GUEST_PATHS = Object.freeze({
  work: "/fusion/work", tmp: "/tmp", guest: "/fusion/work/.fusion", source: "/fusion/work/src", deps: "/fusion/work/deps",
  home: "/fusion/work/home", node: "/usr/local/bin/node", npmCli: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
});
/** Unprivileged numeric identity; `1000:1000` is the `node` user of the official Node images. */
export const GUEST_USER = "1000:1000";
/** `deps` is the dependency-preparation stage (see `dependency-policy.ts`); every other mode is network-less. */
export const GUEST_MODES = Object.freeze(["verify", "canary", "descendant", "hang", "deps"] as const);
export type GuestMode = typeof GUEST_MODES[number];

export const OWNER_LABELS = Object.freeze({ owner: "fusion.owner", backend: "fusion.backend", run: "fusion.run",
  protocol: "fusion.protocol", created: "fusion.created", mode: "fusion.mode" });

export const RUN_ID = /^[0-9a-f]{32}$/u;
export const NONCE = /^[0-9a-f]{32}$/u;
export const SHA256 = /^[0-9a-f]{64}$/u;
export const CONTAINER_ID = /^[0-9a-f]{64}$/u;
/**
 * Production images are pinned by digest only (`repository@sha256:<64 hex>`). A tag — `latest` or any other — is a
 * floating reference and is refused, so the backend can never silently run a different image. The backend never pulls.
 */
const PINNED_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*){0,3}@sha256:[0-9a-f]{64}$/u;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;
const ENV_VALUE = /^[\x20-\x7e]{0,512}$/u;

/**
 * The validated production runtime: `node:22.20.0-bookworm-slim` for linux/amd64, pinned by digest (OBSERVED in
 * O5.5B5 and O5.5B6). A different image is never substituted; the backend refuses to run when it is absent.
 */
export const PRODUCTION_DOCKER_IMAGE = "node@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e";
export const PRODUCTION_NODE_VERSION = "v22.20.0";

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
export const LIMIT_BOUNDS: Readonly<Record<keyof DockerResourceLimits, readonly [number, number]>> = Object.freeze({
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

/**
 * The fixed in-container bootstrap, passed as `node -e` source. It is the ONLY code the image runs before the guest
 * bundle arrives: it reads one length-prefixed frame from stdin, refuses it unless its SHA-256 equals the host-pinned
 * hash in argv, writes the bundle's files (runner + archive reader) into tmpfs, and hands the rest of stdin to the
 * runner. It contains no backslash, so Windows argv quoting round-trips it unchanged. In `hang` mode it never ends.
 */
export const GUEST_BOOTSTRAP = [
  '"use strict";const c=require("node:crypto"),f=require("node:fs"),u=require("node:url");',
  "const[,h,m,mh]=process.argv;const D=\"/fusion/work/.fusion\";let b=Buffer.alloc(0),go=false;const s=process.stdin;",
  'const x=e=>{go=true;process.stderr.write("fusion-runner-error:"+e+String.fromCharCode(10),()=>process.exit(2))};',
  'const on=d=>{if(go)return;b=b.length?Buffer.concat([b,d]):d;if(b.length<12)return;',
  'if(b.toString("latin1",0,8)!=="FUSIONB1")return x("bootstrap-magic");const n=b.readUInt32BE(8);',
  'if(n>8388608)return x("bootstrap-size");if(b.length<12+n)return;go=true;s.pause();s.removeListener("data",on);',
  'const g=b.subarray(12,12+n);if(c.createHash("sha256").update(g).digest("hex")!==h)return x("bootstrap-hash");',
  "f.mkdirSync(D,{mode:448});let o=0;const k=g[o++];for(let i=0;i<k;i++){const l=g[o++];const nm=g.toString(\"utf8\",o,o+l);",
  'o+=l;const z=g.readUInt32BE(o);o+=4;if(!/^[a-z][a-z0-9-]{0,40}[.](?:js|json)$/.test(nm))return x("bootstrap-name");',
  'f.writeFileSync(D+"/"+nm,g.subarray(o,o+z),{mode:256,flag:"wx"});o+=z}if(o!==g.length)return x("bootstrap-layout");',
  'import(u.pathToFileURL(D+"/guest-runner.js").href).then(r=>r.runGuest(m,mh,b.subarray(12+n),s)).catch(()=>x("runner-load"))};',
  'if(m==="hang")setInterval(()=>{},1073741824);else{s.on("data",on);s.on("end",()=>{if(!go)x("bootstrap-eof")})}',
].join("");

export interface ContainerSpec {
  readonly runId: string;
  readonly mode: GuestMode;
  readonly image: string;
  readonly limits: DockerResourceLimits;
  /** Complete container environment (see `buildContainerVerifierEnvironment`). No host value is forwarded. */
  readonly env: Readonly<Record<string, string>>;
  readonly createdAt: string;
  /** SHA-256 of the guest bundle frame the bootstrap must receive. */
  readonly bundleSha256: string;
  /** SHA-256 of the manifest the runner must receive (all-zero for `hang`, which reads nothing). */
  readonly manifestSha256: string;
}

export const containerName = (runId: string, mode: GuestMode): string => `fusion-${mode}-${runId}`;
export function ownershipLabels(runId: string, createdAt: string, mode?: GuestMode): Readonly<Record<string, string>> {
  return Object.freeze({ [OWNER_LABELS.owner]: "true", [OWNER_LABELS.backend]: DOCKER_BACKEND_ID, [OWNER_LABELS.run]: runId,
    [OWNER_LABELS.protocol]: String(DOCKER_PROTOCOL_VERSION), [OWNER_LABELS.created]: createdAt,
    ...(mode === undefined ? {} : { [OWNER_LABELS.mode]: mode }) });
}

const cpus = (nano: number): string => String(nano / 1_000_000_000);
/** Only dependency preparation may reach a network, and only Docker's default bridge; verification never does. */
export const networkFor = (mode: GuestMode): "none" | "bridge" => mode === "deps" ? "bridge" : "none";

/**
 * The complete `docker create` argv for one Fusion container. Hardening, in order: never pull; Fusion ownership
 * labels; no network (the `deps` stage alone uses the default bridge and runs no repository code); every capability
 * dropped; no privilege escalation; read-only root filesystem; unprivileged user; bounded memory (swap equal), CPU and
 * PIDs; private IPC and cgroup namespaces; a minimal init that reaps descendants; no log storage for untrusted output;
 * no core dumps; two size-bounded tmpfs scratch areas; stdin kept open for the input stream; and node running the
 * fixed bootstrap, so no shell interprets anything. There is no `--mount`, `--volume` or bind of any kind.
 */
export function buildCreateArgs(spec: ContainerSpec): string[] {
  if (!RUN_ID.test(spec.runId)) failWith("InvalidInput", "Docker run id is invalid.");
  if (!(GUEST_MODES as readonly string[]).includes(spec.mode)) failWith("InvalidInput", "Docker guest mode is invalid.");
  if (!ISO_TIME.test(spec.createdAt)) failWith("InvalidInput", "Docker creation time is invalid.");
  if (!SHA256.test(spec.bundleSha256) || !SHA256.test(spec.manifestSha256)) failWith("InvalidInput", "Docker bootstrap hashes are invalid.");
  const image = assertPinnedImage(spec.image);
  const limits = resolveLimits(spec.limits);
  const envArgs: string[] = [];
  assertNoCredentialKeys(spec.env);
  for (const [key, value] of Object.entries(spec.env)) {
    if (!ENV_KEY.test(key) || typeof value !== "string" || !ENV_VALUE.test(value))
      failWith("InvalidInput", "Docker container environment entries must be fixed printable key=value pairs.");
    envArgs.push("--env", `${key}=${value}`);
  }
  const labels = Object.entries(ownershipLabels(spec.runId, spec.createdAt, spec.mode))
    .flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  return [
    "create", "--pull", "never", "--name", containerName(spec.runId, spec.mode), ...labels,
    "--interactive",
    "--network", networkFor(spec.mode),
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
    "--workdir", GUEST_PATHS.work,
    "--entrypoint", GUEST_PATHS.node,
    ...envArgs,
    image, "-e", GUEST_BOOTSTRAP, spec.bundleSha256, spec.mode, spec.manifestSha256,
  ];
}

/** The only docker subcommands the backend may ever run; `image`/`container` only for `inspect`. */
const ALLOWED_SUBCOMMANDS = new Set(["version", "image", "container", "create", "start", "wait", "kill", "rm", "top", "ps"]);
const TMPFS_TARGETS = new Set<string>([GUEST_PATHS.work, GUEST_PATHS.tmp]);
/**
 * Defense in depth for every docker invocation, independent of the builder: refuses any argv that could weaken the
 * container (privileged, host namespaces, added capabilities, devices, ANY mount or volume, a network other than
 * `none` — except the default bridge for a `deps` container —, disabled confinement profiles, the Docker socket) or run
 * destructive/global subcommands (`system prune`, `volume rm`, `rmi`, `pull`, `exec`, …).
 */
export function assertSafeDockerArgs(args: readonly string[]): void {
  const refuse = (): never => failWith("SecurityViolation", "A docker invocation outside the backend's hardened allowlist was refused.");
  if (!Array.isArray(args) || args.length === 0 || args.length > 256 ||
      !args.every(arg => typeof arg === "string" && !arg.includes("\0") && arg.length <= 8192)) refuse();
  const [command, sub] = args;
  if (!ALLOWED_SUBCOMMANDS.has(command!)) refuse();
  if ((command === "image" || command === "container") && sub !== "inspect") refuse();
  if (args.some(arg => /docker\.sock|docker_engine|dockerDesktop/iu.test(arg))) refuse();
  // For `create`, only the region before the image holds docker flags; the container command after it must be exactly
  // the fixed bootstrap with two hashes and a known mode, so nothing else can ever run as the entrypoint's program.
  let end = args.length, mode: string | undefined;
  if (command === "create") {
    end = args.findIndex((arg, index) => index > 0 && PINNED_IMAGE.test(arg) && !args[index - 1]!.startsWith("-"));
    if (end < 0 || args.length !== end + 6 || args[end + 1] !== "-e" || args[end + 2] !== GUEST_BOOTSTRAP ||
        !SHA256.test(args[end + 3]!) || !(GUEST_MODES as readonly string[]).includes(args[end + 4]!) || !SHA256.test(args[end + 5]!))
      refuse();
    mode = args[end + 4];
  }
  // A flag's value is either inline (`--flag=value`) or the next argument.
  const valueOf = (index: number): string => {
    const arg = args[index]!, equals = arg.indexOf("=");
    return arg.startsWith("--") && equals > 0 ? arg.slice(equals + 1) : args[index + 1] ?? "";
  };
  const depsContainer = mode === "deps" && args.slice(0, end).includes(`${OWNER_LABELS.mode}=deps`);
  for (let index = 0; index < end; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) continue;
    const flag = arg.split("=", 1)[0]!;
    if (["--privileged", "--cap-add", "--device", "--device-cgroup-rule", "--gpus", "--volume", "-v", "--volumes-from",
      "--mount", "--pid", "--userns", "--uts", "--add-host", "--publish", "-p", "--publish-all", "-P", "--env-file",
      "--mount-proc", "--sysctl", "--runtime", "--isolation", "--link", "--dns", "--network-alias", "--ip", "--ip6",
      "--mac-address", "--privileged-without-host-devices", "--group-add", "--cgroup-parent"].includes(flag)) refuse();
    if (flag === "--network" && !(valueOf(index) === "none" || (valueOf(index) === "bridge" && depsContainer))) refuse();
    if (flag === "--ipc" && valueOf(index) !== "private") refuse();
    if (flag === "--security-opt" && !/^no-new-privileges(?:[=:]true)?$/u.test(valueOf(index))) refuse();
    if (flag === "--tmpfs" && !TMPFS_TARGETS.has(valueOf(index).split(":", 1)[0]!)) refuse();
    if (flag === "--user" && valueOf(index) !== GUEST_USER) refuse();
    // `-e KEY` without a value would forward the docker client's own environment into the container.
    if ((flag === "--env" || flag === "-e") && !valueOf(index).includes("=")) refuse();
  }
  if (command === "create" && (!args.slice(0, end).includes("--network") || !args.slice(0, end).includes("--read-only") ||
      !args.slice(0, end).includes("--cap-drop")))
    refuse();
}

/** Host variables the docker CLI itself may see (for its config and named-pipe/socket discovery). No secret shape. */
export const DOCKER_CLIENT_FORWARDED_KEYS = Object.freeze(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE",
  "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
  "XDG_RUNTIME_DIR"] as const);
/**
 * Environment for the docker CLI process. It is an allowlist: provider credentials, tokens, SSH agents and even
 * `DOCKER_HOST` (which could ship the input to a remote daemon) never reach the client, so they cannot reach the
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

/**
 * Fusion ownership is proven only by ALL ownership labels, never by a container name prefix: `fusion.owner=true`,
 * `fusion.backend=docker-linux`, a 32-hex run id (equal to `runId` when given), a recognised protocol version and a
 * well-formed creation time. Anything missing, malformed or extra-valued makes the object foreign.
 */
export function isFusionOwned(labels: unknown, runId?: string): boolean {
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) return false;
  const record = labels as Record<string, unknown>;
  const run = record[OWNER_LABELS.run], created = record[OWNER_LABELS.created];
  return record[OWNER_LABELS.owner] === "true" && record[OWNER_LABELS.backend] === DOCKER_BACKEND_ID &&
    typeof run === "string" && RUN_ID.test(run) && (runId === undefined || run === runId) &&
    typeof record[OWNER_LABELS.protocol] === "string" && OWNED_PROTOCOL_VERSIONS.includes(record[OWNER_LABELS.protocol] as string) &&
    typeof created === "string" && ISO_TIME.test(created) && !Number.isNaN(Date.parse(created));
}

export interface OwnedContainerRecord {
  readonly id: string;
  readonly labels: unknown;
}
/**
 * Pure age-based selection (see `sweeper.ts` for the wired crash-recovery sweep). A container qualifies only with a
 * full 64-hex id, every Fusion ownership label, and a creation label older than `minAgeMs`, so a live run, a foreign
 * container, or one merely named `fusion-*` is never selected. Broad prefix deletion is impossible by design.
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
