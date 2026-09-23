/**
 * The real Writer mode gate. It is a constant, not a setting: no configuration, flag or environment variable can open
 * it. It mirrors `REAL_WRITER_MODE_BLOCKED_UNTIL` in docs/o3-workflow.md, which remains authoritative.
 */
export const REAL_WRITER_MODE_NOT_READY = "REAL_WRITER_MODE_NOT_READY";
export const REAL_WRITER_MODE_PREREQUISITES = Object.freeze([
  Object.freeze({ id: "ignoredPathInfluence", text: "Controlled-tree verification exists, but no production Writer route uses it or confines verifier access to ambient paths." }),
  Object.freeze({ id: "sharedGitState", text: "Private Git clones exist, but no real Writer launch is restricted to their filesystem boundary." }),
  Object.freeze({ id: "stateFingerprints", text: "Git control-state hashes exist, but runtime primary mutation prevention and external hook/config paths are not fully proven." }),
  Object.freeze({ id: "verificationIsolation", text: "Reconstructed verification exists, but production Writer flow is not wired to it or OS-confined." }),
  Object.freeze({ id: "writerPosture", text: "No real adapter proves the separate Writer isolation capability set." }),
]);

export interface WriterReadiness {
  readonly ready: false;
  readonly code: typeof REAL_WRITER_MODE_NOT_READY;
  readonly prerequisites: typeof REAL_WRITER_MODE_PREREQUISITES;
}
/** Always not ready in this release. */
export function writerReadiness(): WriterReadiness {
  return { ready: false, code: REAL_WRITER_MODE_NOT_READY, prerequisites: REAL_WRITER_MODE_PREREQUISITES };
}
