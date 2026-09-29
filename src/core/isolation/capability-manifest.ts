import { canonicalJson, sha256Hex } from "../delivery/canonical.js";
import { failWith } from "../errors.js";
import { DENY_ALL_NETWORK, validateNetworkPolicy, type NetworkPolicy } from "./network-policy.js";
import { SANDBOX_BACKENDS, type SandboxBackendKind } from "./posture.js";

/**
 * v0.6 — the CAPABILITY MANIFEST: the explicit, immutable, host-built contract for ONE untrusted execution (section 8).
 * It binds what the execution may touch — its backend and sandbox identity, the exact host paths it may read/write and
 * those explicitly denied, its network policy, which environment variable NAMES it inherits (never values), its process
 * and resource limits, timeout and working directory — and hashes all of it.
 *
 * LEAST AUTHORITY by construction (section 9): a manifest is built by host policy, never from model output. A model may
 * *request* a capability (`CapabilityRequest`, a bounded hint); it may not grant one — there is no path from a provider
 * reply into `capabilityManifest`. The manifest is control-plane data the backend consumes; it is never handed to the
 * sandbox, and only its hash, counts and closed labels are persisted as evidence (paths and identities are not — §67).
 */
export const CAPABILITY_MANIFEST_FORMAT = "fusion.capabilityManifest" as const;
export const CAPABILITY_MANIFEST_VERSION = 1 as const;

export const CAPABILITY_LIMITS = Object.freeze({
  maxPaths: 64, maxPathLength: 4096, maxEnvNames: 64, maxIdentityLength: 128,
  maxTimeoutMs: 60 * 60_000, maxProcesses: 512, maxOutputBytes: 256 * 1024 * 1024,
  maxMemoryBytes: 16 * 1024 * 1024 * 1024, maxCpuMs: 24 * 60 * 60_000,
});

/** How the child environment is composed. `minimal`: only the named variables (the default for untrusted execution). */
export const ENVIRONMENT_POLICIES = Object.freeze(["minimal", "inheritAllowed"] as const);
export type EnvironmentPolicyKind = (typeof ENVIRONMENT_POLICIES)[number];

export interface ResourceLimits {
  readonly timeoutMs: number;
  readonly maxProcesses: number;
  readonly maxOutputBytes: number;
  /** `null` when the backend cannot enforce it reliably — never claim a limit that is merely advisory (§23). */
  readonly maxMemoryBytes: number | null;
  readonly maxCpuMs: number | null;
}

export interface CapabilityManifest {
  readonly format: typeof CAPABILITY_MANIFEST_FORMAT;
  readonly version: typeof CAPABILITY_MANIFEST_VERSION;
  readonly executionId: string;
  readonly runId: string;
  readonly candidateId: string | null;
  readonly candidateRevision: string | null;
  readonly backend: SandboxBackendKind;
  /** The sandbox identity this execution runs under (e.g. an AppContainer profile name); a per-execution label. */
  readonly sandboxIdentity: string;
  readonly filesystem: Readonly<{
    readPaths: readonly string[];
    writePaths: readonly string[];
    deniedPaths: readonly string[];
  }>;
  readonly network: NetworkPolicy;
  readonly environment: Readonly<{ policy: EnvironmentPolicyKind; allowedNames: readonly string[] }>;
  readonly limits: ResourceLimits;
  readonly workingDirectory: string;
  readonly policyVersion: string;
  /** SHA-256 of the canonical manifest with `manifestHash` set to "" — binds every field above. */
  readonly manifestHash: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REVISION = /^[0-9a-f]{64}$/u;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const POLICY_VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/u;

const absolutePath = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > CAPABILITY_LIMITS.maxPathLength || value.includes("\0"))
    failWith("InvalidInput", `A ${what} path is malformed.`);
  const v = value as string;
  // Windows drive-absolute, UNC, or POSIX-absolute. Never relative — the backend grants concrete host locations.
  if (!(/^[A-Za-z]:[\\/]/u.test(v) || v.startsWith("\\\\") || v.startsWith("/")))
    failWith("InvalidInput", `A ${what} path must be absolute.`);
  return v;
};

const pathList = (value: unknown, what: string): readonly string[] => {
  if (!Array.isArray(value) || value.length > CAPABILITY_LIMITS.maxPaths) failWith("InvalidInput", `The ${what} path list is malformed.`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of value) {
    const abs = absolutePath(p, what);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out.sort();
};

const positive = (value: unknown, max: number, what: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) failWith("InvalidInput", `Invalid ${what}.`);
  return value as number;
};
const optionalPositive = (value: unknown, max: number, what: string): number | null => {
  if (value === null) return null;
  return positive(value, max, what);
};

function validateLimits(value: unknown): ResourceLimits {
  const l = value as Record<string, unknown> | null;
  const keys = ["timeoutMs", "maxProcesses", "maxOutputBytes", "maxMemoryBytes", "maxCpuMs"];
  if (l === null || typeof l !== "object" || Array.isArray(l) || Object.keys(l).length !== keys.length || !keys.every(k => Object.hasOwn(l, k)))
    failWith("InvalidInput", "The resource limits are malformed.");
  return Object.freeze({
    timeoutMs: positive(l.timeoutMs, CAPABILITY_LIMITS.maxTimeoutMs, "timeout"),
    maxProcesses: positive(l.maxProcesses, CAPABILITY_LIMITS.maxProcesses, "process limit"),
    maxOutputBytes: positive(l.maxOutputBytes, CAPABILITY_LIMITS.maxOutputBytes, "output limit"),
    maxMemoryBytes: optionalPositive(l.maxMemoryBytes, CAPABILITY_LIMITS.maxMemoryBytes, "memory limit"),
    maxCpuMs: optionalPositive(l.maxCpuMs, CAPABILITY_LIMITS.maxCpuMs, "CPU limit"),
  });
}

function envNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > CAPABILITY_LIMITS.maxEnvNames) failWith("InvalidInput", "The environment name list is malformed.");
  const seen = new Set<string>();
  for (const n of value) {
    if (typeof n !== "string" || !ENV_NAME.test(n)) failWith("InvalidInput", "An environment variable name is malformed.");
    if (seen.has(n)) continue;
    seen.add(n);
  }
  return [...seen].sort();
}

/** The bytes a manifest hash is computed over: the manifest with an empty hash field, canonicalized. */
function hashableForm(m: Omit<CapabilityManifest, "manifestHash">): string {
  return canonicalJson({ ...m, manifestHash: "" });
}
export function capabilityManifestHash(manifest: CapabilityManifest): string {
  return sha256Hex(canonicalJson({ ...manifest, manifestHash: "" }));
}

export interface CapabilityManifestInput {
  readonly executionId: string;
  readonly runId: string;
  readonly candidateId?: string | null;
  readonly candidateRevision?: string | null;
  readonly backend: SandboxBackendKind;
  readonly sandboxIdentity: string;
  readonly readPaths?: readonly string[];
  readonly writePaths?: readonly string[];
  readonly deniedPaths?: readonly string[];
  readonly network?: NetworkPolicy;
  readonly environmentPolicy?: EnvironmentPolicyKind;
  readonly allowedEnvNames?: readonly string[];
  readonly limits: ResourceLimits;
  readonly workingDirectory: string;
  readonly policyVersion: string;
}

/**
 * Builds an immutable, hashed capability manifest from HOST inputs. The working directory must be one of the writable
 * paths (an execution writes only where it may). Deep-frozen and self-hashed: any later mutation breaks the hash.
 */
export function capabilityManifest(input: CapabilityManifestInput): CapabilityManifest {
  if (typeof input.executionId !== "string" || !ID.test(input.executionId)) failWith("InvalidInput", "The execution id is malformed.");
  if (typeof input.runId !== "string" || !ID.test(input.runId)) failWith("InvalidInput", "The run id is malformed.");
  const candidateId = input.candidateId ?? null;
  if (candidateId !== null && (typeof candidateId !== "string" || !ID.test(candidateId))) failWith("InvalidInput", "The candidate id is malformed.");
  const candidateRevision = input.candidateRevision ?? null;
  if (candidateRevision !== null && (typeof candidateRevision !== "string" || !REVISION.test(candidateRevision)))
    failWith("InvalidInput", "The candidate revision is malformed.");
  if (!(SANDBOX_BACKENDS as readonly unknown[]).includes(input.backend)) failWith("InvalidInput", "Unknown sandbox backend.");
  if (typeof input.sandboxIdentity !== "string" || !IDENTITY.test(input.sandboxIdentity)) failWith("InvalidInput", "The sandbox identity is malformed.");
  if (typeof input.policyVersion !== "string" || !POLICY_VERSION.test(input.policyVersion)) failWith("InvalidInput", "The policy version is malformed.");

  const readPaths = pathList(input.readPaths ?? [], "read");
  const writePaths = pathList(input.writePaths ?? [], "write");
  const deniedPaths = pathList(input.deniedPaths ?? [], "denied");
  const network = input.network === undefined ? DENY_ALL_NETWORK : validateNetworkPolicy(input.network);
  const environmentPolicy = input.environmentPolicy ?? "minimal";
  if (!(ENVIRONMENT_POLICIES as readonly unknown[]).includes(environmentPolicy)) failWith("InvalidInput", "Unknown environment policy.");
  const allowedNames = envNames(input.allowedEnvNames ?? []);
  const limits = validateLimits(input.limits);
  const workingDirectory = absolutePath(input.workingDirectory, "working directory");
  if (!writePaths.includes(workingDirectory) && !writePaths.some(w => isUnder(workingDirectory, w)))
    failWith("InvalidInput", "The working directory must be within a writable path.");

  const withoutHash: Omit<CapabilityManifest, "manifestHash"> = {
    format: CAPABILITY_MANIFEST_FORMAT, version: CAPABILITY_MANIFEST_VERSION, executionId: input.executionId, runId: input.runId,
    candidateId, candidateRevision, backend: input.backend, sandboxIdentity: input.sandboxIdentity,
    filesystem: Object.freeze({ readPaths: Object.freeze(readPaths), writePaths: Object.freeze(writePaths), deniedPaths: Object.freeze(deniedPaths) }),
    network, environment: Object.freeze({ policy: environmentPolicy, allowedNames: Object.freeze(allowedNames) }),
    limits, workingDirectory, policyVersion: input.policyVersion,
  };
  const manifestHash = sha256Hex(hashableForm(withoutHash));
  return Object.freeze({ ...withoutHash, manifestHash });
}

/** Case-sensitive containment by simple prefix on normalized separators (both inputs are validated absolute paths). */
function isUnder(child: string, parent: string): boolean {
  const c = child.replace(/[\\/]+/gu, "/").replace(/\/$/u, "");
  const p = parent.replace(/[\\/]+/gu, "/").replace(/\/$/u, "");
  return c === p || c.startsWith(`${p}/`);
}

/**
 * Validates an untrusted manifest object into its canonical, hash-verified form. Rebuilds it through `capabilityManifest`
 * (so every field rule re-runs) and confirms the stored hash equals the recomputed one. Any mismatch fails closed.
 */
export function validateCapabilityManifest(value: unknown): CapabilityManifest {
  const m = value as Record<string, unknown> | null;
  const keys = ["format", "version", "executionId", "runId", "candidateId", "candidateRevision", "backend", "sandboxIdentity",
    "filesystem", "network", "environment", "limits", "workingDirectory", "policyVersion", "manifestHash"];
  if (m === null || typeof m !== "object" || Array.isArray(m) || Object.keys(m).length !== keys.length || !keys.every(k => Object.hasOwn(m, k)) ||
      m.format !== CAPABILITY_MANIFEST_FORMAT || m.version !== CAPABILITY_MANIFEST_VERSION)
    failWith("InvalidInput", "The capability manifest is malformed.");
  const fs = m.filesystem as Record<string, unknown> | null;
  if (fs === null || typeof fs !== "object" || Array.isArray(fs) || Object.keys(fs).length !== 3 ||
      !["readPaths", "writePaths", "deniedPaths"].every(k => Object.hasOwn(fs, k)))
    failWith("InvalidInput", "The capability manifest filesystem section is malformed.");
  const env = m.environment as Record<string, unknown> | null;
  if (env === null || typeof env !== "object" || Array.isArray(env) || Object.keys(env).length !== 2 ||
      !["policy", "allowedNames"].every(k => Object.hasOwn(env, k)))
    failWith("InvalidInput", "The capability manifest environment section is malformed.");
  const rebuilt = capabilityManifest({
    executionId: m.executionId as string, runId: m.runId as string, candidateId: m.candidateId as string | null,
    candidateRevision: m.candidateRevision as string | null, backend: m.backend as SandboxBackendKind,
    sandboxIdentity: m.sandboxIdentity as string, readPaths: fs.readPaths as readonly string[], writePaths: fs.writePaths as readonly string[],
    deniedPaths: fs.deniedPaths as readonly string[], network: validateNetworkPolicy(m.network), environmentPolicy: env.policy as EnvironmentPolicyKind,
    allowedEnvNames: env.allowedNames as readonly string[], limits: validateLimits(m.limits), workingDirectory: m.workingDirectory as string,
    policyVersion: m.policyVersion as string,
  });
  if (typeof m.manifestHash !== "string" || m.manifestHash !== rebuilt.manifestHash)
    failWith("SecurityViolation", "The capability manifest hash does not bind its contents; it is not used.");
  return rebuilt;
}

/**
 * A model may REQUEST a capability — a bounded, closed hint the host weighs against policy. It cannot set a backend,
 * identity, path or limit; it only asks. The host decides whether to widen a manifest. Recorded here so the interface
 * for a future feature exists (section 8); no v0.6 command feeds model output into manifest construction.
 */
export const CAPABILITY_REQUEST_KINDS = Object.freeze(["network", "additionalReadPath", "additionalWritePath"] as const);
export type CapabilityRequestKind = (typeof CAPABILITY_REQUEST_KINDS)[number];
export interface CapabilityRequest {
  readonly kind: CapabilityRequestKind;
  /** A bounded, human-readable reason (never executed, never a path grant); the host is free to ignore it. */
  readonly reason: string;
}
export function validateCapabilityRequest(value: unknown): CapabilityRequest {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== 2 ||
      !(CAPABILITY_REQUEST_KINDS as readonly unknown[]).includes(r.kind) || typeof r.reason !== "string" ||
      r.reason.length === 0 || r.reason.length > 400 || /[\x00-\x1f\x7f]/u.test(r.reason))
    failWith("InvalidInput", "A capability request is malformed.");
  return Object.freeze({ kind: r.kind as CapabilityRequestKind, reason: r.reason });
}
