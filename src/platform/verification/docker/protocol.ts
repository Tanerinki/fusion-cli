import { failWith } from "../../../core/errors.js";
import { parseStrictJson, StrictJsonError } from "../../process/strict-json.js";
import { DOCKER_PROTOCOL_VERSION, NONCE } from "./config.js";

/**
 * Host ⇄ guest protocol of the Docker verification backend. The MANIFEST flows host → guest through the read-only
 * input bundle and is host-authored. The RESULT flows guest → host as the guest runner's attached stdout — the
 * container has no writable host mount — and is UNTRUSTED: untrusted repository code runs in the same container and
 * could overwrite or interleave it. It is therefore bounded, strictly parsed (duplicate keys and excess depth are
 * rejected), closed-shape (unknown or missing keys are rejected), bound to this run by a nonce, cross-checked against
 * daemon-observed facts by the backend, and contains no free-form field except bounded, control-character-free
 * output tails. The nonce binds a result to a run; it is NOT an authenticity proof against code inside the container.
 */
export const DOCKER_RESULT_LIMITS = Object.freeze({
  maxResultBytes: 256 * 1024, maxDepth: 4, stdoutTailBytes: 8 * 1024, stderrTailBytes: 4 * 1024, maxCommands: 8,
  maxArgs: 64, maxArgBytes: 4 * 1024, maxCommandTimeoutMs: 30 * 60 * 1000, maxCopyEntries: 20_000,
  maxCopyBytes: 256 * 1024 * 1024, maxInterfaces: 16, maxUnexpectedDevices: 16,
});

export interface GuestCommand {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  /** POSIX path relative to the in-container copy of the candidate (`.` for its root). */
  readonly cwd: string;
  readonly timeoutMs: number;
}
export interface VerifyManifest {
  readonly protocolVersion: typeof DOCKER_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly env: Readonly<Record<string, string>>;
  readonly limits: Readonly<{ stdoutTailBytes: number; stderrTailBytes: number; maxCopyEntries: number; maxCopyBytes: number }>;
  readonly commands: readonly GuestCommand[];
}
export interface CanaryManifest {
  readonly protocolVersion: typeof DOCKER_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly readableToken: string;
  /** File NAMES placed only on the host outside the input bundle; finding one inside the container is a failure. */
  readonly absentMarkerNames: readonly string[];
  readonly forbiddenEnvKeys: readonly string[];
  readonly forbiddenEnvPrefixes: readonly string[];
  /** Synthetic canary values start with this prefix; it never carries a real secret. */
  readonly canaryValuePrefix: string;
  readonly dnsNames: readonly string[];
  readonly connectTargets: readonly Readonly<{ host: string; port: number }>[];
  readonly pidProbeMax: number;
  readonly allowedDevices: readonly string[];
  readonly descendantMarker: string;
  readonly walkMaxEntries: number;
}

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
export interface VerifyResult {
  readonly protocolVersion: typeof DOCKER_PROTOCOL_VERSION;
  readonly mode: "verify";
  readonly nonce: string;
  readonly copy: Readonly<{ files: number; directories: number; bytes: number; durationMs: number }>;
  readonly commands: readonly GuestCommandResult[];
  readonly notRun: readonly string[];
  readonly complete: true;
}
export interface CanaryResult {
  readonly protocolVersion: typeof DOCKER_PROTOCOL_VERSION;
  readonly mode: "canary";
  readonly nonce: string;
  readonly identity: Readonly<{ uid: number; gid: number; noNewPrivs: boolean; seccompMode: number;
    capabilitiesZero: boolean; ptraceScope: number | null }>;
  readonly filesystem: Readonly<{ inputReadable: boolean; inputCreateDenied: boolean; inputModifyDenied: boolean;
    rootfsWriteDenied: boolean; workWritable: boolean; tmpWritable: boolean; homeWritable: boolean }>;
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
}
const VERIFY_KEYS = ["protocolVersion", "mode", "nonce", "copy", "commands", "notRun", "complete"] as const;
const COPY_KEYS = ["files", "directories", "bytes", "durationMs"] as const;
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
  const copy = exact(value.copy, COPY_KEYS, "copy");
  if (!count(copy.files, DOCKER_RESULT_LIMITS.maxCopyEntries) || !count(copy.directories, DOCKER_RESULT_LIMITS.maxCopyEntries) ||
      !count(copy.bytes, DOCKER_RESULT_LIMITS.maxCopyBytes) || !count(copy.durationMs, expected.hostElapsedMs + CLOCK_SLACK_MS))
    return malformed("copy statistics are impossible");
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
  if (totalMs + (copy.durationMs as number) > expected.hostElapsedMs + CLOCK_SLACK_MS) malformed("durations exceed the observed wall time");
  return Object.freeze({ protocolVersion: DOCKER_PROTOCOL_VERSION, mode: "verify", nonce: expected.nonce,
    copy: Object.freeze({ files: copy.files as number, directories: copy.directories as number, bytes: copy.bytes as number,
      durationMs: copy.durationMs as number }), commands: Object.freeze(commands),
    notRun: Object.freeze([...value.notRun as string[]]), complete: true });
}

const CANARY_SECTIONS = {
  identity: ["uid", "gid", "noNewPrivs", "seccompMode", "capabilitiesZero", "ptraceScope"],
  filesystem: ["inputReadable", "inputCreateDenied", "inputModifyDenied", "rootfsWriteDenied", "workWritable", "tmpWritable",
    "homeWritable"],
  markers: ["walkComplete", "entriesVisited", "unreadableDirectories", "found"],
  credentials: ["forbiddenKeysPresent", "credentialShapedKeysPresent", "canaryValuesPresent", "environSourcesRead",
    "sshOrGitPathsPresent"],
  dockerSocket: ["knownPathsPresent", "socketsNamedDockerFound"],
  network: ["interfaces", "ipv4Routes", "ipv6NonLoopbackRoutes", "dnsAttempts", "dnsFailures", "connectAttempts", "connectFailures"],
  resources: ["memoryMax", "cpuMax", "pidsMax", "pidProbeSpawned", "pidProbeLimited"],
  devices: ["count", "unexpected"],
} as const;
const CANARY_KEYS = ["protocolVersion", "mode", "nonce", ...Object.keys(CANARY_SECTIONS), "complete"];

export function decodeCanaryResult(text: unknown, nonce: string): CanaryResult {
  if (!NONCE.test(nonce)) failWith("InvalidInput", "Docker canary expectation is invalid.");
  const value = exact(decode(text), CANARY_KEYS, "");
  if (value.mode !== "canary") return malformed("has the wrong mode");
  if (value.nonce !== nonce) return malformed("nonce does not match this run");
  if (value.complete !== true) return malformed("has no completion marker");
  const section = Object.fromEntries(Object.entries(CANARY_SECTIONS).map(([name, keys]) => [name, exact(value[name], keys, name)])) as
    Record<keyof typeof CANARY_SECTIONS, Json>;
  const { identity, filesystem, markers, credentials, dockerSocket, network, resources, devices } = section;
  const ok = count(identity.uid, 2 ** 32) && count(identity.gid, 2 ** 32) && bool(identity.noNewPrivs) &&
    count(identity.seccompMode, 2) && bool(identity.capabilitiesZero) && (identity.ptraceScope === null || count(identity.ptraceScope, 3)) &&
    Object.values(filesystem).every(bool) &&
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
  return Object.freeze({ protocolVersion: DOCKER_PROTOCOL_VERSION, mode: "canary", nonce, complete: true,
    identity: freeze(identity), filesystem: freeze(filesystem), markers: freeze(markers), credentials: freeze(credentials),
    dockerSocket: freeze(dockerSocket),
    network: Object.freeze({ ...network, interfaces: Object.freeze([...network.interfaces as string[]]) }),
    resources: freeze(resources), devices: Object.freeze({ ...devices, unexpected: Object.freeze([...devices.unexpected as string[]]) }),
  }) as unknown as CanaryResult;
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
