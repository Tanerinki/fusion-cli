import { WINDOWS_VERIFICATION_BACKEND_ID, WINDOWS_VERIFICATION_CONTRACT, WINDOWS_VERIFICATION_EVIDENCE_SCHEMA,
  type WindowsVerificationIsolationEvidence } from "../platform/verification/windows-isolation.js";

/**
 * The RECORDED, VERSION-BOUND Windows verification-isolation capability evidence, transcribed from the authorized live
 * proof audited in docs/v0.6-verification-isolation-audit.json (run vi261003091053, 2026-10-03; Docker 29.8.1 Windows
 * engine; host build 26200). It is static recorded-live-probe data — NOT re-observed in this process — and the Writer
 * gate re-validates it deterministically with windowsVerificationIsolationState(), failing closed on anything missing,
 * malformed, stale/incompatible or wrong. This is the only recorded Windows proof; a reconfiguration or a fixture is
 * not one, and this evidence authorizes nothing — it reports a proven capability, never a Writer run.
 */
const RECORD: WindowsVerificationIsolationEvidence = Object.freeze({
  contract: WINDOWS_VERIFICATION_CONTRACT,
  evidenceSchemaVersion: WINDOWS_VERIFICATION_EVIDENCE_SCHEMA,
  semantics: "windows",
  backendId: WINDOWS_VERIFICATION_BACKEND_ID,
  isolationMode: "hyperv",
  networkMode: "none",
  bindMountCount: 0,
  verdict: "PASS",
  outcome: "verified",
  primaryMutationDetected: false,
  gateProofs: Object.freeze({
    cleanVerifiedPass: true,
    timeoutClassifiedDistinctly: true,
    mutationDetectedAndRejected: true,
    cleanExitCannotMaskMutation: true,
  }),
  runId: "vi261003091053",
  evidencePath: "docs/v0.6-verification-isolation-audit.json",
  observedAt: "2026-10-03",
});

/** The single recorded Windows verification-isolation proof (frozen). The gate re-validates it; it is not trusted blindly. */
export function recordedWindowsVerificationIsolation(): WindowsVerificationIsolationEvidence {
  return RECORD;
}
