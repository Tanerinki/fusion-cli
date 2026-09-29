import { failWith } from "../errors.js";

/**
 * v0.6 — ISOLATION POSTURE contracts (pure, provider- and platform-neutral).
 *
 * Fusion runs untrusted provider/candidate processes. v0.6 states, honestly and mechanically, HOW MUCH the operating
 * system enforces for a given execution. There is no security theater: a dimension is `enforced` only when the OS itself
 * denies a deliberate violation (proven by a probe), never because a flag was passed or a policy said so.
 *
 * Posture is DERIVED from a backend probe and a requested policy; it is never asserted. A HARD request that the backend
 * cannot satisfy fails closed (`HARD_ISOLATION_UNAVAILABLE`) — it never silently runs unsandboxed.
 */

/** The isolation backends v0.6 may select. `none` is not a backend; it is the absence of OS enforcement. */
export const SANDBOX_BACKENDS = Object.freeze(["appcontainer", "sandboxSpec", "none"] as const);
export type SandboxBackendKind = (typeof SANDBOX_BACKENDS)[number];

/**
 * The posture a caller REQUIRES of an untrusted execution.
 * - `hard`: the OS must enforce filesystem, network and process-tree boundaries; anything less fails closed.
 * - `confined`: filesystem and process-tree must be OS-enforced; the network need not be (e.g. no provisioning yet).
 * - `bestEffort`: use whatever the backend offers; never claim HARD. For read-only, non-mutating local work only.
 */
export const REQUESTED_POSTURES = Object.freeze(["hard", "confined", "bestEffort"] as const);
export type RequestedPosture = (typeof REQUESTED_POSTURES)[number];

/** The posture actually established for an execution, derived from a probe. */
export const ISOLATION_POSTURES = Object.freeze(["HARD", "CONFINED", "UNAVAILABLE"] as const);
export type IsolationPosture = (typeof ISOLATION_POSTURES)[number];

/** Per-dimension enforcement, as a probe established it. `enforced` means the OS denied a deliberate violation. */
export const ENFORCEMENT_STATES = Object.freeze(["enforced", "notProvisioned", "unavailable", "unknown"] as const);
export type EnforcementState = (typeof ENFORCEMENT_STATES)[number];

/** The dimensions a posture is composed of. */
export interface IsolationDimensions {
  readonly filesystem: EnforcementState;
  readonly network: EnforcementState;
  readonly processTree: EnforcementState;
}

/**
 * Explicit ISOLATION FAILURE states (section 59). A denied malicious operation is evidence the sandbox WORKED, not that
 * Fusion crashed — these are the honest, closed labels a caller maps onto its outcome. Kept separate from the core
 * `FusionErrorKind` so the core union stays closed; a thrown failure maps to `SecurityViolation`/`WorkspaceConflict`/
 * `CapabilityUnavailable`/`InvalidInput` as appropriate.
 */
export const ISOLATION_FAILURES = Object.freeze([
  "HARD_ISOLATION_UNAVAILABLE",
  "SANDBOX_SETUP_REQUIRED",
  "SANDBOX_POLICY_INVALID",
  "SANDBOX_BACKEND_UNAVAILABLE",
  "FILESYSTEM_DENIED",
  "NETWORK_DENIED",
  "PROCESS_LIMIT_EXCEEDED",
  "SANDBOX_ESCAPE_DETECTED",
  "SANDBOX_CLEANUP_FAILED",
] as const);
export type IsolationFailure = (typeof ISOLATION_FAILURES)[number];

/**
 * The result of probing a backend on this host, for one requested policy shape. `mechanicallyProven` per dimension is the
 * only thing that may raise a posture: it is true only when a harmless canary confirmed OS denial (the platform backend
 * sets it; a config value never does). `notes` are closed labels, never paths or secrets.
 */
export const PROBE_NOTES = Object.freeze([
  "backendMissing", "featureDisabled", "adminRequired", "loopbackExemptionRequired", "networkNotProvisioned",
  "profileCreateFailed", "canaryPassed", "canaryFailed", "providerRuntimeUnproven", "unsupportedBuild",
] as const);
export type ProbeNote = (typeof PROBE_NOTES)[number];

export interface BackendProbe {
  readonly backend: SandboxBackendKind;
  /** Whether the backend can be used at all on this host right now. */
  readonly available: boolean;
  /** Per-dimension enforcement the probe MECHANICALLY established (canary-proven), never assumed. */
  readonly dimensions: IsolationDimensions;
  /** Bounded, closed observation labels. */
  readonly notes: readonly ProbeNote[];
}

const MAX_NOTES = 32;

/** Validates a backend probe (untrusted platform output is still checked before it decides posture). */
export function validateBackendProbe(value: unknown): BackendProbe {
  const p = value as Record<string, unknown> | null;
  const keys = ["backend", "available", "dimensions", "notes"];
  if (p === null || typeof p !== "object" || Array.isArray(p) || Object.keys(p).length !== keys.length ||
      !keys.every(k => Object.hasOwn(p, k)) || !(SANDBOX_BACKENDS as readonly unknown[]).includes(p.backend) ||
      typeof p.available !== "boolean" || !Array.isArray(p.notes) || p.notes.length > MAX_NOTES ||
      !p.notes.every(n => (PROBE_NOTES as readonly unknown[]).includes(n)))
    failWith("InvalidInput", "The sandbox backend probe is malformed.");
  const d = p.dimensions as Record<string, unknown> | null;
  const dk = ["filesystem", "network", "processTree"];
  if (d === null || typeof d !== "object" || Array.isArray(d) || Object.keys(d).length !== dk.length ||
      !dk.every(k => Object.hasOwn(d, k) && (ENFORCEMENT_STATES as readonly unknown[]).includes(d[k])))
    failWith("InvalidInput", "The sandbox backend probe has malformed dimensions.");
  return Object.freeze({
    backend: p.backend as SandboxBackendKind, available: p.available,
    dimensions: Object.freeze({ filesystem: d.filesystem as EnforcementState, network: d.network as EnforcementState,
      processTree: d.processTree as EnforcementState }),
    notes: Object.freeze([...new Set(p.notes as ProbeNote[])]),
  });
}

/**
 * The posture a probe establishes, on its own (no request): HARD when all three dimensions are OS-enforced, CONFINED when
 * filesystem and process-tree are enforced (network may be unprovisioned), UNAVAILABLE otherwise.
 */
export function postureOfProbe(probe: BackendProbe): IsolationPosture {
  if (!probe.available || probe.backend === "none") return "UNAVAILABLE";
  const { filesystem, network, processTree } = probe.dimensions;
  if (filesystem === "enforced" && network === "enforced" && processTree === "enforced") return "HARD";
  if (filesystem === "enforced" && processTree === "enforced") return "CONFINED";
  return "UNAVAILABLE";
}

export interface PostureDecision {
  readonly requested: RequestedPosture;
  readonly established: IsolationPosture;
  /** True when the request is satisfied and the execution may proceed. */
  readonly satisfied: boolean;
  /** When not satisfied, the closed reason a caller reports and fails closed on. */
  readonly failure?: IsolationFailure;
  readonly dimensions: IsolationDimensions;
  readonly backend: SandboxBackendKind;
}

/**
 * The FAIL-CLOSED decision: does a probe satisfy the requested posture? A `hard` request needs `HARD`; a `confined`
 * request accepts `HARD` or `CONFINED`; `bestEffort` always proceeds (never claiming HARD). When a request is not met,
 * the decision names why and `satisfied` is false — the caller MUST NOT run the untrusted execution.
 */
export function decidePosture(requested: RequestedPosture, probe: BackendProbe): PostureDecision {
  const established = postureOfProbe(probe);
  const base = { requested, established, dimensions: probe.dimensions, backend: probe.backend } as const;
  if (requested === "bestEffort") return Object.freeze({ ...base, satisfied: true });
  if (requested === "confined") {
    if (established === "HARD" || established === "CONFINED") return Object.freeze({ ...base, satisfied: true });
    return Object.freeze({ ...base, satisfied: false, failure: failureFor(probe) });
  }
  // hard
  if (established === "HARD") return Object.freeze({ ...base, satisfied: true });
  if (established === "CONFINED") return Object.freeze({ ...base, satisfied: false, failure: "NETWORK_DENIED" });
  return Object.freeze({ ...base, satisfied: false, failure: failureFor(probe) });
}

function failureFor(probe: BackendProbe): IsolationFailure {
  if (!probe.available) {
    if (probe.notes.includes("adminRequired") || probe.notes.includes("featureDisabled")) return "SANDBOX_SETUP_REQUIRED";
    return "SANDBOX_BACKEND_UNAVAILABLE";
  }
  return "HARD_ISOLATION_UNAVAILABLE";
}
