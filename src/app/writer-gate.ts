import { isGrantedAcceptance, type VerificationIsolationAcceptance } from "../platform/verification/acceptance.js";

/**
 * The real Writer mode gate. It is a constant, not a setting: no configuration, flag or environment variable can open
 * it. It mirrors `REAL_WRITER_MODE_BLOCKED_UNTIL` in docs/o3-workflow.md, which remains authoritative.
 */
export const REAL_WRITER_MODE_NOT_READY = "REAL_WRITER_MODE_NOT_READY";
/** No milestone so far authorizes a real provider Writer run; opening it needs its own explicit authorization. */
export const REAL_WRITER_LIVE_GATE_AUTHORIZED = false as const;
export const REAL_WRITER_MODE_PREREQUISITES = Object.freeze([
  Object.freeze({ id: "ignoredPathInfluence", text: "Host-applied candidates check ignored paths, but the production Writer route is not proven end to end." }),
  Object.freeze({ id: "sharedGitState", text: "Private Git clones exist and confined verification receives no .git; provider change-author processes still run on the host without an OS filesystem boundary." }),
  Object.freeze({ id: "stateFingerprints", text: "Git and controlled-tree fingerprints detect changes, but cannot prevent a process from briefly mutating and restoring the primary workspace." }),
  Object.freeze({ id: "verificationIsolation", text: "Linux-compatible verification can run in the confined docker-linux backend (accepted only per process from freshly observed evidence); Windows-required verification has no confined backend." }),
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

/**
 * - `satisfied`: the component exists and its own evidence holds for its whole scope;
 * - `satisfiedForLinuxScope`: holds for platform-neutral/linux-compatible tasks only, from a granted acceptance;
 * - `partial`: a substrate exists but a named part of the prerequisite is unproven;
 * - `notEvaluated`: the evidence this gate needs was not produced in this process;
 * - `blocked`: known not to hold.
 */
export type WriterGateState = "satisfied" | "satisfiedForLinuxScope" | "partial" | "notEvaluated" | "blocked";
export interface WriterGateRow {
  readonly id: string;
  readonly state: WriterGateState;
  readonly evidence: string;
  readonly remainingBlocker: string;
}
export interface WriterGateReport {
  /** Every row must be `satisfied` (or Linux-scoped for a Linux-scoped Writer) AND the live gate authorized. Never true here. */
  readonly realWriterModeReady: false;
  readonly liveGateAuthorized: typeof REAL_WRITER_LIVE_GATE_AUTHORIZED;
  readonly verificationIsolation: Readonly<{ linux: "accepted" | "notEvaluated"; windows: "unsupported" }>;
  readonly rows: readonly WriterGateRow[];
}

/**
 * Derives the Writer gate table from component readiness instead of a master switch. `linuxVerification` must be an
 * acceptance granted by the verification acceptance authority in this process; anything else (a copy, a parsed object,
 * a fixture) is ignored and the gate reads `notEvaluated`.
 */
export function writerGateReport(inputs: Readonly<{ linuxVerification?: unknown }> = {}): WriterGateReport {
  const accepted: VerificationIsolationAcceptance | undefined = isGrantedAcceptance(inputs.linuxVerification)
    ? inputs.linuxVerification : undefined;
  const rows: WriterGateRow[] = [
    { id: "primaryProtection", state: "partial",
      evidence: "Primary Git/controlled-tree fingerprints around every step; private clones; no push remote; confined verification cannot reach any host path.",
      remainingBlocker: "Fingerprints detect but cannot prevent a host process (a provider CLI) from transiently mutating and restoring the primary." },
    { id: "hostControlledApplication", state: "satisfied",
      evidence: "ChangeSets are validated and applied by Fusion into a private candidate with a mutation ledger (O5.5B).",
      remainingBlocker: "Exercised offline only; no production Worker route calls it yet." },
    { id: "providerChangeProposal", state: "blocked",
      evidence: "Adapters expose a read-only structured change-proposal turn; Worker bindings stay blocked by the registry.",
      remainingBlocker: "No production Worker route and no authorized real-provider proposal run." },
    { id: "verificationIsolation", state: accepted ? "satisfiedForLinuxScope" : "notEvaluated",
      evidence: accepted ? `Granted ${accepted.contract} acceptance: ${accepted.evidence.passed}/${accepted.evidence.required} facts on ${accepted.runtime.image} (${accepted.runtime.node}).`
        : "The docker-linux backend and the acceptance authority exist; no acceptance was granted in this process.",
      remainingBlocker: "Windows-required verification has no confined backend; Linux acceptance never implies Windows acceptance." },
    { id: "platformCompatibility", state: "satisfied",
      evidence: "Declared platform requirement with deterministic escalation; unknown/missing and windows-required fail closed for docker-linux.",
      remainingBlocker: "Signals are conservative heuristics; tasks without a declaration stay unknown and cannot be verified autonomously." },
    { id: "dependencySupport", state: "partial",
      evidence: "Restricted npm lane: approved lockfile identity, registry-only sha512 packages, no lifecycle scripts, immutable copy-on-use artifact.",
      remainingBlocker: "Other package managers, workspaces, git/file dependencies and packages needing install scripts are unsupported." },
    { id: "cleanupAndRecovery", state: "satisfied",
      evidence: "Per-run ownership-scoped removal plus a bounded, label-verified, age-gated crash-recovery sweep.",
      remainingBlocker: "The sweep is invoked explicitly; no scheduler runs it at startup." },
    { id: "reviewAndAdjudication", state: "satisfied",
      evidence: "Fresh Reviewer isolation and Lead adjudication with Fusion-evidence override (O4/O5.5A), unchanged.",
      remainingBlocker: "None for the gate itself." },
    { id: "billingAndAuthPosture", state: "partial",
      evidence: "BillingGuard enforces subscription lanes for read-only roles.",
      remainingBlocker: "Not evaluated for a Writer binding because Worker bindings are refused." },
    { id: "sharedGitAndIgnoredPaths", state: "partial",
      evidence: "Verification receives no .git and no node_modules; candidates are host-applied with ignored-path checks.",
      remainingBlocker: "Provider change-author processes still run on the host without an OS filesystem boundary." },
    { id: "liveGateAuthorization", state: "blocked",
      evidence: "REAL_WRITER_LIVE_GATE_AUTHORIZED is a constant false.",
      remainingBlocker: "Requires a separate, explicitly authorized milestone." },
  ];
  return Object.freeze({ realWriterModeReady: false, liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED,
    verificationIsolation: Object.freeze({ linux: accepted ? "accepted" as const : "notEvaluated" as const, windows: "unsupported" as const }),
    rows: Object.freeze(rows.map(row => Object.freeze(row))) });
}
