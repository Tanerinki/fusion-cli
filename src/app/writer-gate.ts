/**
 * The real Writer mode gate. It is a constant, not a setting: no configuration, flag or environment variable can open
 * it. It mirrors `REAL_WRITER_MODE_BLOCKED_UNTIL` in docs/o3-workflow.md, which remains authoritative.
 */
export const REAL_WRITER_MODE_NOT_READY = "REAL_WRITER_MODE_NOT_READY";
export const REAL_WRITER_MODE_PREREQUISITES = Object.freeze([
  Object.freeze({ id: "ignoredPathInfluence", text: "Ignored-path influence on verification is not controlled." }),
  Object.freeze({ id: "sharedGitState", text: "Shared Git/common-directory state (config, hooks, refs, info/) is not isolated." }),
  Object.freeze({ id: "stateFingerprints", text: "Index flags and shared refs/config are not fully fingerprinted." }),
  Object.freeze({ id: "verificationIsolation", text: "Verification does not yet run in an isolated or reconstructed environment." }),
  Object.freeze({ id: "writerPosture", text: "No real adapter has a capability-proven Writer posture." }),
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
