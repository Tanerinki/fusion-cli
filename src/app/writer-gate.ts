/**
 * The real Writer mode gate. It is a constant, not a setting: no configuration, flag or environment variable can open
 * it. It mirrors `REAL_WRITER_MODE_BLOCKED_UNTIL` in docs/o3-workflow.md, which remains authoritative.
 */
export const REAL_WRITER_MODE_NOT_READY = "REAL_WRITER_MODE_NOT_READY";
export const REAL_WRITER_MODE_PREREQUISITES = Object.freeze([
  Object.freeze({ id: "ignoredPathInfluence", text: "Host-applied candidates check ignored paths, but the production Writer route and verifier confinement are not proven." }),
  Object.freeze({ id: "sharedGitState", text: "Private Git clones exist; production change-author and verifier processes still lack an OS filesystem boundary." }),
  Object.freeze({ id: "stateFingerprints", text: "Git and controlled-tree fingerprints detect changes, but cannot prevent a process from briefly mutating and restoring the primary workspace." }),
  Object.freeze({ id: "verificationIsolation", text: "Reconstructed verification runs a native process without OS confinement; absolute paths can still address outside files." }),
  Object.freeze({ id: "writerPosture", text: "The read-only Change Author path exists offline, but no production Worker route or real-provider run proves the complete host-controlled flow." }),
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
