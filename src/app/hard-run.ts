import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityManifest } from "../core/isolation/capability-manifest.js";
import { locateLauncher, type LauncherIdentity } from "../platform/isolation/appcontainer-backend.js";
import { brokerPolicyFromManifest, startProviderBroker, type RunningBroker } from "../platform/network/provider-broker.js";
import type { HardLaunchProfile } from "../platform/process/sandboxing-supervisor.js";
import { candidateSandboxIdentity, providerCapabilityManifest, providerEndpointAllowlist } from "./provider-sandbox.js";

/**
 * v0.6 I13 — the ONE authoritative production assembly of a HARD provider execution environment. A requested HARD run is
 * turned into a single, lifecycle-owned bundle: the located launcher, an execution identity, a capability manifest, the
 * view/scratch/canary grants, the minimized-env additions, a per-run broker bound to the manifest's endpoint allowlist,
 * and the `HardLaunchProfile` the provider transport consumes. There is no other production path: a HARD request either
 * yields this bundle or FAILS CLOSED with a typed reason — it never degrades into the legacy unsandboxed route.
 *
 * `dispose()` is the single owner of teardown: it stops the broker (freeing its loopback listener and per-run credential)
 * and removes the canary workspace. The AppContainer identity/grants are per-run and revoked by the launcher itself (it
 * creates and deletes the profile around each execution, inside a kill-on-close Job), so a killed launcher tears the child
 * tree down; a Fusion crash leaves no orphan broker (the listener dies with the process) and at most a stale, inert
 * AppContainer profile, which `fusion sandbox` reconciliation removes.
 */
export const HARD_SETUP_FAILURES = Object.freeze([
  "SANDBOX_SETUP_REQUIRED", "SANDBOX_UNAVAILABLE", "NETWORK_POLICY_UNAVAILABLE",
  "BROKER_UNAVAILABLE", "BROKER_POLICY_INVALID", "CREDENTIAL_LANE_UNAVAILABLE",
] as const);
export type HardSetupFailure = (typeof HARD_SETUP_FAILURES)[number];

/** A typed, fail-closed setup failure: a HARD request that cannot be satisfied, never a silent unsandboxed fallback. */
export class HardSetupError extends Error {
  constructor(readonly reason: HardSetupFailure, message: string) { super(message); this.name = "HardSetupError"; }
}

export type CredentialLane = "subscriptionToken" | "none";

export interface HardRunRequest {
  readonly repositoryRoot: string;
  readonly runId: string;
  readonly candidateId?: string;
  readonly providerFamily: "claude" | "muse";
  /** The read-only provider view. */
  readonly viewPath: string;
  /** The writable provider scratch (its working directory). */
  readonly scratchPath: string;
  /** Host paths explicitly denied (primary checkout, siblings, .fusion state, credentials) — for the manifest audit. */
  readonly deniedPaths?: readonly string[];
  /** The provider API endpoint the broker is allowed to reach. */
  readonly endpoint: Readonly<{ host: string; port: number }>;
  /** The environment variable NAMES the provider legitimately needs (values are taken from the host, never invented). */
  readonly allowedEnvNames: readonly string[];
  /** The resolved auth lane. Only the narrow explicit token lane works under HARD; `none` fails closed. */
  readonly credentialLane: CredentialLane;
  /** Test seam: inject a launcher identity instead of locating the built one. */
  readonly launcher?: LauncherIdentity | null;
  readonly tempBase?: string;
}

export interface HardRun {
  readonly hardProfile: HardLaunchProfile;
  readonly manifest: CapabilityManifest;
  readonly broker: RunningBroker;
  readonly canaryPath: string;
  /** The proxy env the child uses to reach the provider endpoint ONLY through the broker. */
  readonly proxyEnv: Readonly<Record<string, string>>;
  /** Revokes/closes everything this run owns (broker + canary). Idempotent; safe on completion, timeout, cancel or error. */
  dispose(): Promise<void>;
}

/**
 * Assembles a HARD provider execution environment, or throws `HardSetupError` with a typed reason. The order is
 * fail-closed: an unusable credential lane, a missing launcher, an invalid endpoint/policy, or a broker that cannot start
 * each stops the assembly before anything runs — the provider is never launched unsandboxed.
 */
export async function assembleHardRun(request: HardRunRequest): Promise<HardRun> {
  // 1. Credential lane: only the narrow explicit token lane authenticates inside the sandbox (host login is denied).
  if (request.credentialLane !== "subscriptionToken")
    throw new HardSetupError("CREDENTIAL_LANE_UNAVAILABLE",
      `${request.providerFamily} has no HARD-compatible credential lane (host-login auth is unreachable in the sandbox).`);

  // 2. Launcher: the OS boundary must be built. Missing ⇒ setup required (never an unsandboxed fallback).
  const launcher = request.launcher !== undefined ? request.launcher : await locateLauncher();
  if (launcher === null)
    throw new HardSetupError("SANDBOX_SETUP_REQUIRED", "The native AppContainer launcher is not built (run `fusion sandbox` provisioning).");

  // 3. Endpoint / network policy.
  const { host, port } = request.endpoint;
  if (typeof host !== "string" || host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new HardSetupError("NETWORK_POLICY_UNAVAILABLE", "The provider endpoint (host/port) is invalid; a HARD run needs an exact allowlisted destination.");
  const network = providerEndpointAllowlist(host, port);

  // 4. Capability manifest (least authority): read the view, write scratch, deny the rest, ALLOWLIST to the endpoint.
  const identity = candidateSandboxIdentity(request.runId, request.candidateId ?? "main");
  const manifest = providerCapabilityManifest({
    executionId: `${request.runId}.${request.candidateId ?? "main"}`, runId: request.runId,
    candidateId: request.candidateId ?? null, candidateRevision: null, backend: "appcontainer",
    sandboxIdentity: identity, viewPath: request.viewPath, scratchPath: request.scratchPath,
    deniedPaths: request.deniedPaths ?? [], allowedEnvNames: request.allowedEnvNames, network,
  });

  // 5. Canary workspace (writable) — so an attestation canary's intentionally-unsafe side effect can reveal itself
  //    rather than being suppressed by OS denial (a false PASS). Disposable; owned by this run.
  const canaryPath = await mkdtemp(join(request.tempBase ?? tmpdir(), "fusion-canary-"));

  // 6. Broker: bound to the manifest's endpoint allowlist; started on loopback with a per-run credential.
  const brokerPolicy = brokerPolicyFromManifest(manifest, request.providerFamily);
  if (brokerPolicy.allowedHosts.length === 0 || brokerPolicy.allowedPorts.length === 0) {
    await rm(canaryPath, { recursive: true, force: true }).catch(() => undefined);
    throw new HardSetupError("BROKER_POLICY_INVALID", "The broker allowlist is empty; a HARD run needs an exact allowed endpoint.");
  }
  let broker: RunningBroker;
  try {
    broker = await startProviderBroker(brokerPolicy);
  } catch (error) {
    await rm(canaryPath, { recursive: true, force: true }).catch(() => undefined);
    throw new HardSetupError("BROKER_UNAVAILABLE", `The host-side broker could not start: ${(error as Error).message}`);
  }

  // 7. The HARD launch profile the transport consumes. The child env gets the broker proxy env (host-owned; the provider
  //    cannot choose it). View is read-only; scratch AND the canary workspace are writable; everything else is denied.
  const hardProfile: HardLaunchProfile = Object.freeze({
    launcher, identity, readPaths: Object.freeze([request.viewPath]),
    writePaths: Object.freeze([request.scratchPath, canaryPath]), network: manifest.network,
    childEnvAdditions: broker.proxyEnv, maxProcesses: manifest.limits.maxProcesses,
    ...(request.tempBase === undefined ? {} : { tempBase: request.tempBase }),
  });

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return; disposed = true;
    await broker.stop().catch(() => undefined);
    await rm(canaryPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  };

  return Object.freeze({ hardProfile, manifest, broker, canaryPath, proxyEnv: broker.proxyEnv, dispose });
}
