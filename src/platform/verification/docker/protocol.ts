import { failWith } from "../../../core/errors.js";
import { parseStrictJson, StrictJsonError } from "../../process/strict-json.js";
import { DOCKER_PROTOCOL_VERSION, NONCE, SHA256 } from "./config.js";
import type { ArchiveLimits } from "./transfer-archive.js";

/**
 * Host ⇄ guest protocol of the Docker verification backend (protocol 2). The MANIFEST flows host → guest as a hashed
 * frame on the container's stdin, right after the guest bundle; it is host-authored, never written to any filesystem,
 * and its SHA-256 is pinned in the container's argv. The RESULT flows guest → host as the runner's attached stdout and
 * is UNTRUSTED: untrusted repository code runs in the same container. It is therefore bounded, strictly parsed
 * (duplicate keys and excess depth are rejected), closed-shape (unknown or missing keys are rejected), bound to this run
 * by a nonce that exists only in the runner's memory, bound to the exact input by the input digests, cross-checked
 * against daemon-observed facts by the backend, and contains no free-form field except bounded, control-character-free
 * output tails.
 */
export const DOCKER_RESULT_LIMITS = Object.freeze({
  maxResultBytes: 256 * 1024, maxDepth: 4, stdoutTailBytes: 8 * 1024, stderrTailBytes: 4 * 1024, maxCommands: 8,
  maxArgs: 64, maxArgBytes: 4 * 1024, maxCommandTimeoutMs: 30 * 60 * 1000, maxInterfaces: 16, maxUnexpectedDevices: 16,
  maxManifestBytes: 1024 * 1024,
});
/** Repository source limits (unchanged from O5.5B5); `node_modules` never enters through the source archive. */
export const SOURCE_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({ maxEntries: 20_000, maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024, forbiddenSegments: Object.freeze(["node_modules"]) });

export interface GuestCommand {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  /** POSIX path relative to the in-container copy of the candidate (`.` for its root). */
  readonly cwd: string;
  readonly timeoutMs: number;
}
export interface InputPart {
  readonly sha256: string;
  readonly bytes: number;
  readonly limits: ArchiveLimits;
}
/** A gzip-compressed dependency archive; `bytes` counts compressed bytes, which `sha256` covers. */
export interface DependencyInputPart extends InputPart {
  readonly compressed: "gzip";
}
export interface VerifyManifest {
  readonly protocolVersion: typeof DOCKER_PROTOCOL_VERSION;
  readonly mode: "verify";
  readonly nonce: string;
  readonly env: Readonly<Record<string, string>>;
  readonly limits: Readonly<{ stdoutTailBytes: number; stderrTailBytes: number }>;
  readonly input: Readonly<{ source: InputPart; dependencies: DependencyInputPart | null }>;
  readonly commands: readonly GuestCommand[];
}
export interface CanaryManifest {
  readonly protocolVersion: typeof DOCKER_PROTOCOL_VERSION;
  readonly mode: "canary";
  readonly nonce: string;
  readonly input: InputPart;
  readonly readableToken: string;
  /** File NAMES placed only on the host outside the container; finding one inside the container is a failure. */
  readonly absentMarkerNames: readonly string[];
  /** Substrings that must not appear in /proc/self/mountinfo (host run-root name, Docker Desktop host-share roots). */
  readonly mountinfoForbidden: readonly string[];
  readonly forbiddenEnvKeys: readonly string[];
  readonly forbiddenEnvPrefixes: readonly string[];
  /** Synthetic canary values start with this prefix; it never carries a real secret. */
  readonly canaryValuePrefix: string;
  readonly dnsNames: readonly string[];
  readonly connectTargets: readonly Readonly<{ host: string; port: number }>[];
  readonly pidProbeMax: number;
  readonly allowedDevices: readonly string[];
  readonly walkMaxEntries: number;
}
export interface DescendantManifest {
  readonly protocolVersion: typeof DOCKER_PROTOCOL_VERSION;
  readonly mode: "descendant";
  readonly nonce: string;
  readonly descendantMarker: string;
}
export interface DependencyManifest {
  readonly protocolVersion: typeof DOCKER_PROTOCOL_VERSION;
  readonly mode: "deps";
  readonly nonce: string;
  /** Archive holding exactly `package.json` and `package-lock.json`; no repository code. */
  readonly input: InputPart;
  /** Host-authored npm argv (see `dependency-policy.ts`); run as `node <npm-cli.js> ...args`. */
  readonly npmArgs: readonly string[];
  readonly npmTimeoutMs: number;
  readonly output: Readonly<{ limits: ArchiveLimits; maxCompressedBytes: number }>;
  readonly limits: Readonly<{ stdoutTailBytes: number; stderrTailBytes: number }>;
}
export type GuestManifest = VerifyManifest | CanaryManifest | DescendantManifest | DependencyManifest;

export type GuestCommandStatus = "exited" | "timeout" | "spawnError";
export interface GuestCommandResult {
  readonly id: string;
  readonly status: GuestCommandStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}
export interface GuestRuntime {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
}
export interface ObservedInput {
  readonly sourceSha256: string;
  readonly sourceEntries: number;
  readonly sourceBytes: number;
  readonly dependencySha256: string | null;
  readonly dependencyEntries: number;
  readonly dependencyBytes: number;
  readonly durationMs: number;
}
export interface VerifyResult {
  readonly protocolVersion: typeof DOCKER_PROTOCOL_VERSION;
  readonly mode: "verify";
  readonly nonce: string;
  readonly input: ObservedInput;
  readonly runtime: GuestRuntime;
  readonly commands: readonly GuestCommandResult[];
  readonly notRun: readonly string[];
  readonly complete: true;
}
export interface CanaryResult {
  readonly protocolVersion: typeof DOCKER_PROTOCOL_VERSION;
  readonly mode: "canary";
  readonly nonce: string;
  readonly runtime: GuestRuntime;
  readonly identity: Readonly<{ uid: number; gid: number; noNewPrivs: boolean; seccompMode: number;
    capabilitiesZero: boolean; ptraceScope: number | null }>;
  readonly filesystem: Readonly<{ transferredReadable: boolean; transferDigestMatched: boolean; rootfsWriteDenied: boolean;
    workWritable: boolean; tmpWritable: boolean; homeWritable: boolean }>;
  readonly mounts: Readonly<{ entries: number; forbiddenFound: number; hostShareFilesystems: number; bindLikeFromOutsideVm: number }>;
  readonly markers: Readonly<{ walkComplete: boolean; entriesVisited: number; unreadableDirectories: number; found: number }>;
  readonly credentials: Readonly<{ forbiddenKeysPresent: number; credentialShapedKeysPresent: number;
    canaryValuesPresent: number; environSourcesRead: number; sshOrGitPathsPresent: number }>;
  readonly dockerSocket: Readonly<{ knownPathsPresent: number; socketsNamedDockerFound: number }>;
  readonly network: Readonly<{ interfaces: readonly string[]; ipv4Routes: number; ipv6NonLoopbackRoutes: number;
    dnsAttempts: number; dnsFailures: number; connectAttempts: number; connectFailures: number }>;
  readonly resources: Readonly<{ memoryMax: string; cpuMax: string; pidsMax: string; pidProbeSpawned: number;
    pidProbeLimited: boolean }>;
  readonly devices: Readonly<{ count: number; unexpected: readonly string[] }>;
  readonly complete: true;
}
export interface DependencyResult {
  readonly protocolVersion: typeof DOCKER_PROTOCOL_VERSION;
  readonly mode: "deps";
  readonly nonce: string;
  readonly inputSha256: string;
  readonly runtime: GuestRuntime;
  readonly npm: Readonly<{ version: string; exitCode: number | null; signal: string | null; durationMs: number;
    timedOut: boolean; stdoutTail: string; stderrTail: string }>;
  /** Null when npm failed; then no artifact bytes may precede the result. */
  readonly artifact: Readonly<{ sha256: string; compressedBytes: number; entries: number; files: number; directories: number;
    bytes: number; symlinksRefused: number }> | null;
  readonly complete: true;
}

type Json = Record<string, unknown>;
const malformed = (what: string): never => failWith("MalformedOutput", `Docker guest result ${what}.`);
const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
function exact(value: unknown, keys: readonly string[], what: string): Json {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)))
    return malformed(`${what} has missing or unknown fields`);
  return value;
}
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const bool = (value: unknown): value is boolean => typeof value === "boolean";
/** Tails may carry tab and newline only; every other control character (incl. ESC and C1) was replaced by the guest. */
const SAFE_TEXT = /^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]*$/u;
const tail = (value: unknown, maxBytes: number): value is string =>
  typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes && SAFE_TEXT.test(value);
const SIGNAL = /^SIG[A-Z0-9]{2,10}$/u;
const INTERFACE = /^[a-z0-9._-]{1,15}$/u;
const DEVICE = /^[a-z0-9._-]{1,32}$/u;
const CGROUP_VALUE = /^(?:max|\d{1,20})$/u;
const CPU_MAX = /^(?:max|\d{1,20}) \d{1,20}$/u;
const NODE_VERSION = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/u;
const SEMVER = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/u;
const RUNTIME_KEYS = ["node", "platform", "arch"] as const;
function runtime(value: unknown): GuestRuntime {
  const entry = exact(value, RUNTIME_KEYS, "runtime");
  if (typeof entry.node !== "string" || !NODE_VERSION.test(entry.node) || !/^[a-z0-9]{1,16}$/u.test(String(entry.platform)) ||
      !/^[a-z0-9]{1,16}$/u.test(String(entry.arch)))
    malformed("runtime identity is invalid");
  return Object.freeze({ node: entry.node as string, platform: entry.platform as string, arch: entry.arch as string });
}

/** Untrusted text: bounded bytes, strict JSON, then the closed shape. */
function decode(text: unknown): Json {
  if (typeof text !== "string") return malformed("is missing");
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (trimmed.length === 0) return malformed("is missing");
  if (Buffer.byteLength(trimmed, "utf8") > DOCKER_RESULT_LIMITS.maxResultBytes) return malformed("exceeds the size limit");
  let value: unknown;
  try { value = parseStrictJson(trimmed, DOCKER_RESULT_LIMITS.maxDepth); }
  catch (error) {
    if (error instanceof StrictJsonError) return malformed(`JSON was rejected (${error.reason})`);
    throw error;
  }
  if (!isRecord(value) || !Object.hasOwn(value, "protocolVersion")) return malformed("has no protocol version");
  if (value.protocolVersion !== DOCKER_PROTOCOL_VERSION) failWith("ProtocolError", "Docker guest result protocol version is not supported.");
  return value;
}

export interface VerifyExpectation {
  readonly nonce: string;
  readonly commands: readonly GuestCommand[];
  /** Host-measured wall time of the attached container run; the guest cannot report more time than elapsed. */
  readonly hostElapsedMs: number;
  /** The exact input the host streamed; a guest that extracted anything else is rejected. */
  readonly input: Readonly<{ sourceSha256: string; dependencySha256: string | null }>;
}
const VERIFY_KEYS = ["protocolVersion", "mode", "nonce", "input", "runtime", "commands", "notRun", "complete"] as const;
const INPUT_KEYS = ["sourceSha256", "sourceEntries", "sourceBytes", "dependencySha256", "dependencyEntries",
  "dependencyBytes", "durationMs"] as const;
const COMMAND_KEYS = ["id", "status", "exitCode", "signal", "durationMs", "stdoutTail", "stderrTail", "stdoutBytes",
  "stderrBytes"] as const;
/** Slack for clock granularity between the guest's monotonic clock and the host's measurement. */
const CLOCK_SLACK_MS = 1_000;

export function decodeVerifyResult(text: unknown, expected: VerifyExpectation): VerifyResult {
  if (!NONCE.test(expected.nonce)) failWith("InvalidInput", "Docker verify expectation is invalid.");
  const value = exact(decode(text), VERIFY_KEYS, "");
  if (value.mode !== "verify") return malformed("has the wrong mode");
  if (value.nonce !== expected.nonce) return malformed("nonce does not match this run");
  if (value.complete !== true) return malformed("has no completion marker");
  const input = exact(value.input, INPUT_KEYS, "input");
  if (input.sourceSha256 !== expected.input.sourceSha256 || input.dependencySha256 !== expected.input.dependencySha256)
    return malformed("input digest does not match the streamed input");
  if (!count(input.sourceEntries, SOURCE_ARCHIVE_LIMITS.maxEntries) || !count(input.sourceBytes, SOURCE_ARCHIVE_LIMITS.maxTotalBytes) ||
      !count(input.dependencyEntries) || !count(input.dependencyBytes) ||
      (input.dependencySha256 === null && (input.dependencyEntries !== 0 || input.dependencyBytes !== 0)) ||
      !count(input.durationMs, expected.hostElapsedMs + CLOCK_SLACK_MS))
    return malformed("input statistics are impossible");
  const observedRuntime = runtime(value.runtime);
  if (!Array.isArray(value.commands) || !Array.isArray(value.notRun)) return malformed("command lists are invalid");
  const ran = value.commands.length;
  if (ran > expected.commands.length || ran + value.notRun.length !== expected.commands.length)
    return malformed("command identity does not match the plan");
  let totalMs = 0;
  const commands = value.commands.map((raw, index): GuestCommandResult => {
    const entry = exact(raw, COMMAND_KEYS, "command");
    const plan = expected.commands[index]!;
    if (entry.id !== plan.id) malformed("command identity does not match the plan");
    const status = entry.status as GuestCommandStatus;
    if (status !== "exited" && status !== "timeout" && status !== "spawnError") malformed("command status is invalid");
    const exitCode = entry.exitCode, signal = entry.signal;
    if (!(exitCode === null || count(exitCode, 255)) || !(signal === null || (typeof signal === "string" && SIGNAL.test(signal))))
      malformed("command exit status is invalid");
    if (status === "exited" && (exitCode === null) === (signal === null)) malformed("command exit status is contradictory");
    if (status === "spawnError" && (exitCode !== null || signal !== null)) malformed("command exit status is contradictory");
    if (!count(entry.durationMs, plan.timeoutMs + CLOCK_SLACK_MS)) malformed("command duration is impossible");
    totalMs += entry.durationMs as number;
    if (!tail(entry.stdoutTail, DOCKER_RESULT_LIMITS.stdoutTailBytes) || !tail(entry.stderrTail, DOCKER_RESULT_LIMITS.stderrTailBytes))
      malformed("command output excerpt is invalid or oversized");
    if (!count(entry.stdoutBytes) || !count(entry.stderrBytes) ||
        (entry.stdoutBytes as number) < (entry.stdoutTail === "" ? 0 : 1) || (entry.stderrBytes as number) < (entry.stderrTail === "" ? 0 : 1))
      malformed("command output counts are impossible");
    // The guest stops at the first command that does not pass; only the last executed command may have failed.
    const passed = status === "exited" && exitCode === 0;
    if (!passed && index !== ran - 1) malformed("reports execution after a failed command");
    return Object.freeze({ id: plan.id, status, exitCode: exitCode as number | null, signal: signal as string | null,
      durationMs: entry.durationMs as number, stdoutTail: entry.stdoutTail as string, stderrTail: entry.stderrTail as string,
      stdoutBytes: entry.stdoutBytes as number, stderrBytes: entry.stderrBytes as number });
  });
  // The guest always runs the first command and continues only while commands pass.
  if (ran === 0) malformed("ran no command");
  const last = commands[ran - 1]!;
  if (last.status === "exited" && last.exitCode === 0 && value.notRun.length > 0)
    malformed("skipped commands after a passing command");
  if (!value.notRun.every((id, index) => id === expected.commands[ran + index]!.id)) malformed("command identity does not match the plan");
  if (totalMs + (input.durationMs as number) > expected.hostElapsedMs + CLOCK_SLACK_MS) malformed("durations exceed the observed wall time");
  return Object.freeze({ protocolVersion: DOCKER_PROTOCOL_VERSION, mode: "verify", nonce: expected.nonce,
    input: Object.freeze({ sourceSha256: input.sourceSha256 as string, sourceEntries: input.sourceEntries as number,
      sourceBytes: input.sourceBytes as number, dependencySha256: input.dependencySha256 as string | null,
      dependencyEntries: input.dependencyEntries as number, dependencyBytes: input.dependencyBytes as number,
      durationMs: input.durationMs as number }),
    runtime: observedRuntime, commands: Object.freeze(commands), notRun: Object.freeze([...value.notRun as string[]]), complete: true });
}

const CANARY_SECTIONS = {
  identity: ["uid", "gid", "noNewPrivs", "seccompMode", "capabilitiesZero", "ptraceScope"],
  filesystem: ["transferredReadable", "transferDigestMatched", "rootfsWriteDenied", "workWritable", "tmpWritable", "homeWritable"],
  mounts: ["entries", "forbiddenFound", "hostShareFilesystems", "bindLikeFromOutsideVm"],
  markers: ["walkComplete", "entriesVisited", "unreadableDirectories", "found"],
  credentials: ["forbiddenKeysPresent", "credentialShapedKeysPresent", "canaryValuesPresent", "environSourcesRead",
    "sshOrGitPathsPresent"],
  dockerSocket: ["knownPathsPresent", "socketsNamedDockerFound"],
  network: ["interfaces", "ipv4Routes", "ipv6NonLoopbackRoutes", "dnsAttempts", "dnsFailures", "connectAttempts", "connectFailures"],
  resources: ["memoryMax", "cpuMax", "pidsMax", "pidProbeSpawned", "pidProbeLimited"],
  devices: ["count", "unexpected"],
} as const;
const CANARY_KEYS = ["protocolVersion", "mode", "nonce", "runtime", ...Object.keys(CANARY_SECTIONS), "complete"];

export function decodeCanaryResult(text: unknown, nonce: string): CanaryResult {
  if (!NONCE.test(nonce)) failWith("InvalidInput", "Docker canary expectation is invalid.");
  const value = exact(decode(text), CANARY_KEYS, "");
  if (value.mode !== "canary") return malformed("has the wrong mode");
  if (value.nonce !== nonce) return malformed("nonce does not match this run");
  if (value.complete !== true) return malformed("has no completion marker");
  const observedRuntime = runtime(value.runtime);
  const section = Object.fromEntries(Object.entries(CANARY_SECTIONS).map(([name, keys]) => [name, exact(value[name], keys, name)])) as
    Record<keyof typeof CANARY_SECTIONS, Json>;
  const { identity, filesystem, mounts, markers, credentials, dockerSocket, network, resources, devices } = section;
  const ok = count(identity.uid, 2 ** 32) && count(identity.gid, 2 ** 32) && bool(identity.noNewPrivs) &&
    count(identity.seccompMode, 2) && bool(identity.capabilitiesZero) && (identity.ptraceScope === null || count(identity.ptraceScope, 3)) &&
    Object.values(filesystem).every(bool) && Object.values(mounts).every(entry => count(entry, 100_000)) &&
    bool(markers.walkComplete) && count(markers.entriesVisited, 10_000_000) && count(markers.unreadableDirectories, 10_000_000) &&
    count(markers.found, 10_000_000) &&
    Object.values(credentials).every(entry => count(entry, 100_000)) && Object.values(dockerSocket).every(entry => count(entry, 100_000)) &&
    Array.isArray(network.interfaces) && network.interfaces.length <= DOCKER_RESULT_LIMITS.maxInterfaces &&
    network.interfaces.every(name => typeof name === "string" && INTERFACE.test(name)) &&
    ["ipv4Routes", "ipv6NonLoopbackRoutes", "dnsAttempts", "dnsFailures", "connectAttempts", "connectFailures"]
      .every(key => count(network[key], 100_000)) &&
    (network.dnsFailures as number) <= (network.dnsAttempts as number) &&
    (network.connectFailures as number) <= (network.connectAttempts as number) &&
    typeof resources.memoryMax === "string" && CGROUP_VALUE.test(resources.memoryMax) &&
    typeof resources.cpuMax === "string" && CPU_MAX.test(resources.cpuMax) &&
    typeof resources.pidsMax === "string" && CGROUP_VALUE.test(resources.pidsMax) &&
    count(resources.pidProbeSpawned, 100_000) && bool(resources.pidProbeLimited) &&
    count(devices.count, 10_000) && Array.isArray(devices.unexpected) &&
    devices.unexpected.length <= DOCKER_RESULT_LIMITS.maxUnexpectedDevices &&
    devices.unexpected.every(name => typeof name === "string" && DEVICE.test(name));
  if (!ok) return malformed("canary observations are invalid or impossible");
  const freeze = <T extends Json>(entry: T): Readonly<T> => Object.freeze({ ...entry });
  return Object.freeze({ protocolVersion: DOCKER_PROTOCOL_VERSION, mode: "canary", nonce, complete: true, runtime: observedRuntime,
    identity: freeze(identity), filesystem: freeze(filesystem), mounts: freeze(mounts), markers: freeze(markers),
    credentials: freeze(credentials), dockerSocket: freeze(dockerSocket),
    network: Object.freeze({ ...network, interfaces: Object.freeze([...network.interfaces as string[]]) }),
    resources: freeze(resources), devices: Object.freeze({ ...devices, unexpected: Object.freeze([...devices.unexpected as string[]]) }),
  }) as unknown as CanaryResult;
}

const DEPS_KEYS = ["protocolVersion", "mode", "nonce", "inputSha256", "runtime", "npm", "artifact", "complete"] as const;
const NPM_KEYS = ["version", "exitCode", "signal", "durationMs", "timedOut", "stdoutTail", "stderrTail"] as const;
const ARTIFACT_KEYS = ["sha256", "compressedBytes", "entries", "files", "directories", "bytes", "symlinksRefused"] as const;
export interface DependencyExpectation {
  readonly nonce: string;
  readonly inputSha256: string;
  readonly npmTimeoutMs: number;
  readonly maxCompressedBytes: number;
  readonly limits: ArchiveLimits;
}
/** The dependency-stage result. It runs no repository code, but its output is still validated like untrusted data. */
export function decodeDependencyResult(text: unknown, expected: DependencyExpectation): DependencyResult {
  if (!NONCE.test(expected.nonce) || !SHA256.test(expected.inputSha256)) failWith("InvalidInput", "Docker dependency expectation is invalid.");
  const value = exact(decode(text), DEPS_KEYS, "");
  if (value.mode !== "deps") return malformed("has the wrong mode");
  if (value.nonce !== expected.nonce) return malformed("nonce does not match this run");
  if (value.complete !== true) return malformed("has no completion marker");
  if (value.inputSha256 !== expected.inputSha256) return malformed("input digest does not match the streamed input");
  const observedRuntime = runtime(value.runtime);
  const npm = exact(value.npm, NPM_KEYS, "npm");
  if (typeof npm.version !== "string" || !(npm.version === "" || SEMVER.test(npm.version)) ||
      !(npm.exitCode === null || count(npm.exitCode, 255)) || !(npm.signal === null || (typeof npm.signal === "string" && SIGNAL.test(npm.signal))) ||
      !count(npm.durationMs, expected.npmTimeoutMs + CLOCK_SLACK_MS) || !bool(npm.timedOut) ||
      !tail(npm.stdoutTail, DOCKER_RESULT_LIMITS.stdoutTailBytes) || !tail(npm.stderrTail, DOCKER_RESULT_LIMITS.stderrTailBytes))
    return malformed("npm observation is invalid");
  let artifact: DependencyResult["artifact"] = null;
  if (value.artifact !== null) {
    const entry = exact(value.artifact, ARTIFACT_KEYS, "artifact");
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256) || !count(entry.compressedBytes, expected.maxCompressedBytes) ||
        !count(entry.entries, expected.limits.maxEntries) || !count(entry.files) || !count(entry.directories) ||
        (entry.files as number) + (entry.directories as number) !== entry.entries ||
        !count(entry.bytes, expected.limits.maxTotalBytes) || entry.symlinksRefused !== 0 || npm.exitCode !== 0)
      return malformed("artifact statistics are impossible");
    artifact = Object.freeze({ sha256: entry.sha256, compressedBytes: entry.compressedBytes as number, entries: entry.entries as number,
      files: entry.files as number, directories: entry.directories as number, bytes: entry.bytes as number, symlinksRefused: 0 });
  }
  return Object.freeze({ protocolVersion: DOCKER_PROTOCOL_VERSION, mode: "deps", nonce: expected.nonce,
    inputSha256: expected.inputSha256, runtime: observedRuntime,
    npm: Object.freeze({ version: npm.version as string, exitCode: npm.exitCode as number | null, signal: npm.signal as string | null,
      durationMs: npm.durationMs as number, timedOut: npm.timedOut as boolean, stdoutTail: npm.stdoutTail as string,
      stderrTail: npm.stderrTail as string }), artifact, complete: true });
}

/** Deterministic `node --test` summary counts from an output tail (TAP `# pass N` or spec `ℹ pass N`), or null. */
export interface TestCounts {
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly todo: number;
}
const SUMMARY = /^(?:# |ℹ )(tests|pass|fail|cancelled|skipped|todo) (\d{1,9})$/gmu;
export function parseTestCounts(stdoutTail: string): TestCounts | null {
  const found = new Map<string, number>();
  for (const match of stdoutTail.matchAll(SUMMARY)) found.set(match[1]!, Number(match[2]));
  const keys = ["tests", "pass", "fail", "cancelled", "skipped", "todo"] as const;
  if (!keys.every(key => found.has(key))) return null;
  const counts = Object.fromEntries(keys.map(key => [key, found.get(key)!])) as unknown as TestCounts;
  return counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo === counts.tests ? Object.freeze(counts) : null;
}
