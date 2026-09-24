import { failWith } from "../../core/errors.js";
import { isPlatformRequirement, type PlatformRequirement } from "../../core/policy/platform.js";
import { ClassifiedVerificationFailure, executeVerification, failClassified, type RecoveryReport, type VerificationBackend,
  type VerificationConfinement, type VerificationExecutionRequest, type VerificationExecutionResult,
  type VerificationFailureClass } from "./backend.js";
import { FusionFailure } from "../../core/errors.js";
import type { DependencyRequirement } from "./dependency-policy.js";
import { platformEligibility } from "./platform-compat.js";

/**
 * Backend selection and the verification service port. Technology-neutral: it knows backends only through the
 * `VerificationBackend` contract, so no Docker (or any other mechanism) conditional exists here, in the workflow, in
 * provider adapters, in risk policy or in review.
 *
 * Purposes:
 *  - `autonomousWriter`: verification of a Writer's candidate. ONLY an OS-confined backend with declared platform
 *    semantics that satisfy the task's requirement and the needed dependency lane may run it. A trusted/unconfined host
 *    backend is refused outright — there is no fallback of any kind, and an unavailable confined backend fails closed.
 *  - `humanApprovedHost`: an explicitly human-approved flow (e.g. read-only review of the user's own checkout) that may
 *    use the trusted host backend. It is never reachable from the autonomous purpose.
 */
export type VerificationPurpose = "autonomousWriter" | "humanApprovedHost";
export const VERIFICATION_PURPOSES = Object.freeze(["autonomousWriter", "humanApprovedHost"] as const);

export interface BackendConsideration {
  readonly backendId: string;
  readonly confinement: VerificationConfinement;
  readonly eligible: boolean;
  /** Stable, path-free reason code, e.g. `trusted-host-refused`, `platform-ineligible`, `docker-daemon-unavailable`. */
  readonly reason: string;
}
export interface BackendSelection {
  readonly backend: VerificationBackend;
  readonly purpose: VerificationPurpose;
  readonly platformRequirement: PlatformRequirement;
  readonly considered: readonly BackendConsideration[];
}

export interface SelectionRequest {
  readonly purpose: VerificationPurpose;
  /** The effective requirement (see `assessPlatformRequirement`); missing or invalid is `unknown`. */
  readonly platformRequirement?: unknown;
  readonly dependencies?: DependencyRequirement;
  readonly signal?: AbortSignal;
}

/** Static eligibility of one backend for a purpose, before any probe. */
export function staticEligibility(backend: VerificationBackend, request: SelectionRequest): BackendConsideration {
  const base = { backendId: backend.id, confinement: backend.confinement };
  const requirement: PlatformRequirement = isPlatformRequirement(request.platformRequirement) ? request.platformRequirement : "unknown";
  if (request.purpose === "autonomousWriter") {
    if (backend.confinement === "none") return { ...base, eligible: false, reason: "trusted-host-refused" };
    if (backend.platformSemantics === undefined) return { ...base, eligible: false, reason: "platform-semantics-undeclared" };
  }
  if (backend.platformSemantics !== undefined && !platformEligibility(backend.platformSemantics, requirement).eligible)
    return { ...base, eligible: false, reason: requirement === "unknown" ? "platform-requirement-unknown" : "platform-ineligible" };
  const kind = request.dependencies?.kind ?? "none";
  if (kind !== "none" && !(backend.dependencyKinds ?? []).includes(kind)) return { ...base, eligible: false, reason: "dependency-lane-unavailable" };
  return { ...base, eligible: true, reason: "eligible" };
}

/**
 * Chooses the first statically eligible backend whose probe reports it available, in the given order. Every refusal is
 * a typed `CapabilityUnavailable` carrying the per-backend reason codes; nothing ever falls back to a weaker backend.
 */
export async function selectVerificationBackend(backends: readonly VerificationBackend[],
  request: SelectionRequest): Promise<BackendSelection> {
  if (!(VERIFICATION_PURPOSES as readonly unknown[]).includes(request.purpose)) failWith("InvalidInput", "Unknown verification purpose.");
  const requirement: PlatformRequirement = isPlatformRequirement(request.platformRequirement) ? request.platformRequirement : "unknown";
  const considered: BackendConsideration[] = [];
  for (const backend of backends) {
    const verdict = staticEligibility(backend, request);
    if (!verdict.eligible) { considered.push(verdict); continue; }
    const probe = await backend.probe(request.signal);
    if (!probe.available) { considered.push({ ...verdict, eligible: false, reason: probe.reason ?? "backend-unavailable" }); continue; }
    considered.push(verdict);
    return Object.freeze({ backend, purpose: request.purpose, platformRequirement: requirement, considered: Object.freeze(considered) });
  }
  const summary = considered.length === 0 ? "no verification backend is configured"
    : considered.map(entry => `${entry.backendId}: ${entry.reason}`).join("; ");
  return failClassified("CapabilityUnavailable", `No verification backend may run this ${request.purpose} verification (${summary}).`,
    refusalClass(considered));
}

/**
 * The class of a refused selection, judged on the backends that could have run it at all (a trusted host refused for an
 * autonomous Writer is no candidate): all platform refusals → `platformIncompatible`; all platform or dependency-lane
 * refusals with at least one lane refusal → `dependencyLaneFailure`; anything else (none configured, unavailable) →
 * `backendUnavailable`.
 */
function refusalClass(considered: readonly BackendConsideration[]): VerificationFailureClass {
  const candidates = considered.filter(entry => entry.reason !== "trusted-host-refused");
  if (candidates.length === 0) return "backendUnavailable";
  const platform = (entry: BackendConsideration): boolean => entry.reason.startsWith("platform-");
  if (candidates.every(platform)) return "platformIncompatible";
  if (candidates.every(entry => platform(entry) || entry.reason === "dependency-lane-unavailable")) return "dependencyLaneFailure";
  return "backendUnavailable";
}

export interface VerificationServiceRequest extends Omit<VerificationExecutionRequest, "platformRequirement"> {
  readonly purpose: VerificationPurpose;
  readonly platformRequirement?: unknown;
  /** Allow the selected backend's explicit dependency stage to prepare a missing artifact before verification. */
  readonly prepareDependencies?: boolean;
}
export interface VerificationServiceResult {
  readonly selection: Readonly<{ backendId: string; confinement: VerificationConfinement; purpose: VerificationPurpose;
    platformRequirement: PlatformRequirement; considered: readonly BackendConsideration[] }>;
  /** Only for a dependency stage that ran in this call. */
  readonly dependencyStage?: Readonly<{ key: string; cacheHit: boolean }>;
  /** Only on the first use of a backend by this service: its crash-recovery sweep (incomplete is reported, not hidden). */
  readonly recovery?: RecoveryReport;
  readonly result: VerificationExecutionResult;
}

/** The verification port a Writer workspace (or any caller) uses; it owns selection and the fail-closed lifecycle. */
export class VerificationService {
  readonly #backends: readonly VerificationBackend[];
  readonly #recovered = new WeakSet<VerificationBackend>();
  constructor(backends: readonly VerificationBackend[]) { this.#backends = Object.freeze([...backends]); }

  async verify(request: VerificationServiceRequest): Promise<VerificationServiceResult> {
    const selection = await selectVerificationBackend(this.#backends, request);
    const { backend } = selection;
    const requirement = selection.platformRequirement;
    // Crash recovery runs once per backend per service, before its first use. Stale resources of a crashed earlier
    // process cannot affect this run (they are never reused), so an incomplete sweep is reported rather than fatal.
    let recovery: RecoveryReport | undefined;
    if (backend.recoverStale !== undefined && !this.#recovered.has(backend)) {
      this.#recovered.add(backend);
      recovery = await backend.recoverStale(request.signal).catch((): RecoveryReport =>
        ({ complete: false, removed: 0, reasons: ["crash recovery failed"] }));
    }
    let dependencyStage: VerificationServiceResult["dependencyStage"];
    if (request.dependencies !== undefined && request.dependencies.kind !== "none" && request.prepareDependencies === true) {
      if (backend.prepareDependencies === undefined)
        failClassified("CapabilityUnavailable", "The selected backend has no dependency stage.", "dependencyLaneFailure");
      let stage;
      try {
        stage = await backend.prepareDependencies({ workspaceRoot: request.workspaceRoot, dependencies: request.dependencies,
          ...(request.signal ? { signal: request.signal } : {}) });
      } catch (error) {
        // A refused, failed or timed-out dependency environment is a lane failure, never a failed check; a cancellation
        // stays a cancellation.
        if (error instanceof FusionFailure && !(error instanceof ClassifiedVerificationFailure) && error.error.kind !== "Cancelled")
          throw new ClassifiedVerificationFailure(error.error, "dependencyLaneFailure");
        throw error;
      }
      dependencyStage = Object.freeze({ key: stage.key, cacheHit: stage.cacheHit });
    }
    const { purpose: _purpose, prepareDependencies: _prepare, ...execution } = request;
    const result = await executeVerification(backend, { ...execution, platformRequirement: requirement });
    return Object.freeze({ selection: Object.freeze({ backendId: backend.id, confinement: backend.confinement, purpose: selection.purpose,
      platformRequirement: requirement, considered: selection.considered }), ...(dependencyStage ? { dependencyStage } : {}),
      ...(recovery ? { recovery } : {}), result });
  }
}
