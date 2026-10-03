/**
 * Windows-required verification-isolation capability evidence and its DETERMINISTIC, FAIL-CLOSED validator.
 *
 * The Linux path is accepted in-process by the acceptance authority (a WeakMap brand that a copy or fixture can never
 * forge; see acceptance.ts). The Windows Hyper-V verification isolation was instead proven by an authorized, audited,
 * out-of-process live run (docs/v0.6-verification-isolation-audit.json): a fresh isolated Hyper-V worker
 * (--isolation=hyperv, --network none, zero host bind mounts) ran the approved VerificationPlan against an explicitly
 * transferred candidate, a read-only-mutation attempt was detected and rejected, a timeout was classified distinctly,
 * and the Primary workspace was unchanged. That capability is therefore carried as RECORDED, VERSION-BOUND evidence
 * (the same trust model as the recorded live-probe rows) and re-validated here on every read.
 *
 * Nothing is hardcoded to "proven": the state is DERIVED from the evidence. Evidence that is missing, malformed, stale
 * or incompatible (wrong contract/schema), on the wrong platform, for the wrong backend, or not a clean PASS fails
 * CLOSED to "blocked". This never opens the Writer gate: a proven capability is reported, not an authorization.
 */
import { platformEligibility, type VerificationPlatformSemantics } from "./platform-compat.js";

export const WINDOWS_VERIFICATION_CONTRACT = "fusion-verification-confinement-v0.1-windows-hyperv";
export const WINDOWS_VERIFICATION_EVIDENCE_SCHEMA = "v0.6-verification-isolation-audit-1";
export const WINDOWS_VERIFICATION_BACKEND_ID = "hyperv-ephemeral-worker";

export interface WindowsVerificationIsolationGateProofs {
  readonly cleanVerifiedPass: boolean;
  readonly timeoutClassifiedDistinctly: boolean;
  readonly mutationDetectedAndRejected: boolean;
  readonly cleanExitCannotMaskMutation: boolean;
}
export interface WindowsVerificationIsolationEvidence {
  readonly contract: string;
  readonly evidenceSchemaVersion: string;
  /** Must be "windows"; any other platform fails closed. */
  readonly semantics: string;
  /** Must be the Hyper-V ephemeral-worker backend; any other backend fails closed. */
  readonly backendId: string;
  readonly isolationMode: string;
  readonly networkMode: string;
  readonly bindMountCount: number;
  readonly verdict: string;
  readonly outcome: string;
  readonly primaryMutationDetected: boolean;
  readonly gateProofs: WindowsVerificationIsolationGateProofs;
  readonly runId: string;
  readonly evidencePath: string;
  readonly observedAt: string;
}

export type WindowsIsolationState = "proven" | "blocked";
export interface WindowsIsolationVerdict {
  readonly state: WindowsIsolationState;
  readonly supported: boolean;
  readonly reasons: readonly string[];
  readonly contract?: string;
  readonly runId?: string;
}

/**
 * A registered verification backend, reduced to what decides windows-confined eligibility. The production registry's
 * backends are assignable to this (VerificationBackend is a superset).
 */
export interface ConfinedBackendDescriptor {
  readonly id: string;
  readonly confinement: string;
  readonly platformSemantics?: VerificationPlatformSemantics;
}
export type WindowsBackendState = "available" | "unavailable";
export interface WindowsBackendVerdict {
  readonly state: WindowsBackendState;
  readonly backendId?: string;
  readonly reasons: readonly string[];
}

/**
 * Whether a REGISTERED, CONFINED production verification backend can execute a windows-required task. A backend
 * qualifies ONLY when it is confined (confinement !== "none") AND its declared platform semantics prove a
 * windows-required requirement (see platformEligibility). Today's registry is [docker-linux] (linux semantics, refuses
 * windows-required) plus the unconfined trusted host, so the state is "unavailable" - DERIVED from the registry, never
 * hardcoded; registering a real confined Windows backend flips it. Proven isolation EVIDENCE does not make a backend
 * exist: evidence and executable backend are independent, and both are required before this dimension is effective.
 */
export function windowsConfinedBackendState(backends: readonly ConfinedBackendDescriptor[]): WindowsBackendVerdict {
  for (const b of backends ?? []) {
    if (b.confinement === "none" || b.platformSemantics === undefined) continue;
    if (platformEligibility(b.platformSemantics, "windows-required").eligible) return { state: "available", backendId: b.id, reasons: [] };
  }
  return { state: "unavailable", reasons: ["no registered confined verification backend proves windows-required semantics"] };
}

const GATE_PROOF_KEYS = ["cleanVerifiedPass", "timeoutClassifiedDistinctly", "mutationDetectedAndRejected",
  "cleanExitCannotMaskMutation"] as const;

/**
 * Derives the Windows verification-isolation state from candidate evidence. PASS ("proven") ONLY when the evidence is a
 * present, well-formed object carrying the current contract + schema, Windows semantics, the Hyper-V backend, the
 * no-network/zero-bind-mount invariants, a clean verified PASS with an unmutated Primary and all four gate proofs true.
 * Everything else — missing, malformed, stale/incompatible, wrong platform, wrong backend, or not a clean PASS — is
 * "blocked", with the reasons named. UNKNOWN is never a PASS.
 */
export function windowsVerificationIsolationState(evidence: unknown): WindowsIsolationVerdict {
  if (evidence === null || evidence === undefined || typeof evidence !== "object") {
    return { state: "blocked", supported: false, reasons: ["no Windows verification-isolation evidence is present"] };
  }
  const e = evidence as Record<string, unknown>;
  const reasons: string[] = [];
  // stale / incompatible: the contract and evidence schema must be EXACTLY the current ones (a version bump invalidates).
  if (e.contract !== WINDOWS_VERIFICATION_CONTRACT) reasons.push(`contract ${JSON.stringify(e.contract)} is not ${WINDOWS_VERIFICATION_CONTRACT} (stale or incompatible)`);
  if (e.evidenceSchemaVersion !== WINDOWS_VERIFICATION_EVIDENCE_SCHEMA) reasons.push(`evidence schema ${JSON.stringify(e.evidenceSchemaVersion)} is not ${WINDOWS_VERIFICATION_EVIDENCE_SCHEMA} (stale or incompatible)`);
  // wrong platform / backend.
  if (e.semantics !== "windows") reasons.push(`semantics ${JSON.stringify(e.semantics)} is not "windows" (wrong platform)`);
  if (e.backendId !== WINDOWS_VERIFICATION_BACKEND_ID) reasons.push(`backend ${JSON.stringify(e.backendId)} is not ${WINDOWS_VERIFICATION_BACKEND_ID} (wrong backend)`);
  if (e.isolationMode !== "hyperv") reasons.push(`isolation ${JSON.stringify(e.isolationMode)} is not "hyperv" (wrong backend)`);
  if (e.networkMode !== "none") reasons.push(`network ${JSON.stringify(e.networkMode)} is not "none" (no-network invariant)`);
  // malformed / not a clean PASS.
  if (typeof e.bindMountCount !== "number" || e.bindMountCount !== 0) reasons.push(`bindMountCount ${JSON.stringify(e.bindMountCount)} is not 0`);
  if (e.verdict !== "PASS") reasons.push(`verdict ${JSON.stringify(e.verdict)} is not "PASS"`);
  if (e.outcome !== "verified") reasons.push(`outcome ${JSON.stringify(e.outcome)} is not "verified"`);
  if (e.primaryMutationDetected !== false) reasons.push("the Primary workspace was mutated during the proof");
  const gp = e.gateProofs;
  if (gp === null || typeof gp !== "object") reasons.push("gateProofs is missing or malformed");
  else for (const k of GATE_PROOF_KEYS) if ((gp as Record<string, unknown>)[k] !== true) reasons.push(`gate proof ${k} is not true`);
  if (typeof e.runId !== "string" || e.runId.length === 0) reasons.push("runId is missing");
  if (typeof e.observedAt !== "string" || e.observedAt.length === 0) reasons.push("observedAt is missing");
  if (reasons.length > 0) return { state: "blocked", supported: false, reasons };
  return { state: "proven", supported: true, reasons: [], contract: String(e.contract), runId: String(e.runId) };
}
