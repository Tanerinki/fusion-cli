import { capabilityManifest, type CapabilityManifest, type ResourceLimits } from "../core/isolation/capability-manifest.js";
import { minimizeEnvironment, type MinimizedEnvironment } from "../core/isolation/environment.js";
import { DENY_ALL_NETWORK, networkPolicy, type NetworkPolicy } from "../core/isolation/network-policy.js";
import { decidePosture, type BackendProbe, type PostureDecision, type RequestedPosture, type SandboxBackendKind } from "../core/isolation/posture.js";
import type { SandboxRunSpec } from "../platform/isolation/appcontainer-backend.js";

/**
 * v0.6 I4 — the PROVIDER SANDBOX contract, host side. It builds the capability manifest and minimized environment for an
 * UNTRUSTED provider/candidate execution and decides its posture fail-closed. The trusted control plane (journal,
 * evidence, delivery, approval, recovery state) is NEVER sandboxed to itself; only the provider executable and its child
 * processes are the untrusted execution. Actually ROUTING a real provider turn through the sandbox additionally requires
 * the WFP network provisioning (maintainer gate) and a real-provider validation (§73); this module is the deterministic
 * host-side plumbing + posture decision that those gates build upon.
 *
 * Least authority (§9): the execution reads only its Fusion-owned view, writes only its own scratch, and is DENIED the
 * primary checkout, sibling candidates, Fusion's own state (journal/evidence/delivery) and host credentials — by NOT
 * granting them (the AppContainer denies what it was not granted) and by naming them in `deniedPaths` for auditability.
 */
export const PROVIDER_POLICY_VERSION = "0.6.0";
export const DEFAULT_PROVIDER_LIMITS: ResourceLimits = Object.freeze({
  timeoutMs: 30 * 60_000, maxProcesses: 32, maxOutputBytes: 16 * 1024 * 1024, maxMemoryBytes: null, maxCpuMs: null,
});

export interface ProviderSandboxInput {
  readonly executionId: string;
  readonly runId: string;
  readonly candidateId?: string | null;
  readonly candidateRevision?: string | null;
  readonly backend: SandboxBackendKind;
  readonly sandboxIdentity: string;
  /** The Fusion-owned view the execution may READ (its baseline/candidate copy). */
  readonly viewPath: string;
  /** The Fusion-owned scratch the execution may WRITE (and its working directory). */
  readonly scratchPath: string;
  /** Host paths explicitly denied (primary checkout, sibling candidates, .fusion state, delivery store, credentials). */
  readonly deniedPaths?: readonly string[];
  /** The environment variable NAMES the provider legitimately needs (values are taken from the host, never invented). */
  readonly allowedEnvNames: readonly string[];
  /** DENY_ALL by default; an ALLOWLIST (provider endpoint) needs WFP provisioning (a maintainer gate). */
  readonly network?: NetworkPolicy;
  readonly limits?: ResourceLimits;
}

/** Builds the immutable capability manifest for one untrusted provider/candidate execution. */
export function providerCapabilityManifest(input: ProviderSandboxInput): CapabilityManifest {
  return capabilityManifest({
    executionId: input.executionId, runId: input.runId, candidateId: input.candidateId ?? null,
    candidateRevision: input.candidateRevision ?? null, backend: input.backend, sandboxIdentity: input.sandboxIdentity,
    readPaths: [input.viewPath], writePaths: [input.scratchPath], deniedPaths: input.deniedPaths ?? [],
    network: input.network ?? DENY_ALL_NETWORK, environmentPolicy: "minimal", allowedEnvNames: input.allowedEnvNames,
    limits: input.limits ?? DEFAULT_PROVIDER_LIMITS, workingDirectory: input.scratchPath, policyVersion: PROVIDER_POLICY_VERSION,
  });
}

/** The minimized child environment for the execution, from the host environment and the manifest's allow-list. */
export function providerEnvironment(hostEnv: Readonly<Record<string, string | undefined>>, manifest: CapabilityManifest): MinimizedEnvironment {
  return minimizeEnvironment(hostEnv, manifest);
}

/**
 * The launcher run spec for a provider execution, derived from its capability manifest and minimized environment (§19).
 * This is the single mapping from the host-side manifest to what the AppContainer launcher runs: exactly the manifest's
 * read/write grants, working directory, resource limits, network policy and the minimized child environment. It carries
 * no host authority the manifest did not grant. `prepareSandboxLaunch(launcher, providerRunSpec(...))` is the production
 * path a real provider turn takes into `ProcessSupervisor`.
 */
export function providerRunSpec(manifest: CapabilityManifest, environment: MinimizedEnvironment,
  executable: string, args: readonly string[]): SandboxRunSpec {
  return Object.freeze({
    identity: manifest.sandboxIdentity, workingDirectory: manifest.workingDirectory,
    readPaths: manifest.filesystem.readPaths, writePaths: manifest.filesystem.writePaths,
    executable, args: [...args], timeoutMs: manifest.limits.timeoutMs, maxProcesses: manifest.limits.maxProcesses,
    env: environment.env, network: manifest.network,
  });
}

/**
 * The fail-closed posture decision for a provider execution: a HARD request the backend/network cannot satisfy does NOT
 * silently downgrade to unsandboxed — it returns `satisfied:false` with the reason (e.g. HARD_ISOLATION_UNAVAILABLE /
 * NETWORK_DENIED), and the caller must refuse to run the untrusted execution.
 */
export function decideProviderPosture(requested: RequestedPosture, probe: BackendProbe): PostureDecision {
  return decidePosture(requested, probe);
}

/** A convenience ALLOWLIST for a single provider endpoint (used only once WFP provisioning makes it enforceable). */
export function providerEndpointAllowlist(host: string, port: number | null): NetworkPolicy {
  return networkPolicy({ mode: "ALLOWLIST", loopback: "deny", allowed: [{ host, port }] });
}

/**
 * A DISTINCT AppContainer identity per candidate of a run (§13): each candidate gets its own identity, so the OS
 * derives a distinct package SID and distinct filesystem grants, making sibling candidates MUTUALLY INACCESSIBLE even
 * when they run concurrently. The identity is a deterministic, bounded token of the run and candidate ids; two
 * different candidates never collide, and the same candidate is stable across a resume.
 */
export function candidateSandboxIdentity(runId: string, candidateId: string): string {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "x";
  return `fusion.sandbox.${clean(runId)}.${clean(candidateId)}`;
}
