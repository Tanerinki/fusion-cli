import { isGrantedAcceptance, type VerificationIsolationAcceptance } from "../platform/verification/acceptance.js";

/**
 * The real Writer mode gate. It is a constant, not a setting: no configuration, flag or environment variable can open
 * it. It mirrors `REAL_WRITER_MODE_BLOCKED_UNTIL` in docs/o3-workflow.md, which remains authoritative.
 */
export const REAL_WRITER_MODE_NOT_READY = "REAL_WRITER_MODE_NOT_READY";
/** No milestone so far authorizes a real provider Writer run; opening it needs its own explicit authorization. */
export const REAL_WRITER_LIVE_GATE_AUTHORIZED = false as const;
export const REAL_WRITER_MODE_PREREQUISITES = Object.freeze([
  Object.freeze({ id: "ignoredPathInfluence", text: "Host-applied candidates check ignored paths and the production Writer route runs end to end offline; ignored files in the primary checkout are not fingerprinted (a detection gap, not a prevention)." }),
  Object.freeze({ id: "sharedGitState", text: "Private Git clones exist and confined verification receives no .git; provider change-author processes still run on the host without an OS filesystem boundary." }),
  Object.freeze({ id: "stateFingerprints", text: "Git and controlled-tree fingerprints detect changes, but cannot prevent a process from briefly mutating and restoring the primary workspace." }),
  Object.freeze({ id: "verificationIsolation", text: "Linux-compatible verification can run in the confined docker-linux backend (accepted only per process from freshly observed evidence); Windows-required verification has no confined backend." }),
  Object.freeze({ id: "writerPosture", text: "The production Writer route (read-only Change Author, host application, confined verification, fresh review) is proven only with deterministic fake providers; no real provider has run it." }),
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
/**
 * What kind of evidence backs a row. `mechanical`: enforced by code and covered by deterministic tests.
 * `fakeProviderRehearsal`: the route ran end to end with deterministic fake providers only — it can never prove a real
 * provider's behaviour. `liveProcess`: observed in this process (a granted acceptance). `none`: nothing holds yet.
 */
export type WriterGateEvidence = "mechanical" | "fakeProviderRehearsal" | "liveProcess" | "none";
export interface WriterGateRow {
  readonly id: string;
  readonly state: WriterGateState;
  readonly evidenceKind: WriterGateEvidence;
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
 * a fixture) is ignored and the gate reads `notEvaluated`. No input can change the provider, Writer or live-gate rows:
 * fake-provider evidence proves wiring, never a real provider's posture.
 */
export function writerGateReport(inputs: Readonly<{ linuxVerification?: unknown }> = {}): WriterGateReport {
  const accepted: VerificationIsolationAcceptance | undefined = isGrantedAcceptance(inputs.linuxVerification)
    ? inputs.linuxVerification : undefined;
  const rows: WriterGateRow[] = [
    { id: "primaryProtection", state: "partial", evidenceKind: "mechanical",
      evidence: "Primary Git fingerprints around every turn, application and verification; candidates are private clones outside the primary; the applier refuses any root but its own candidate; confined verification cannot reach any host path.",
      remainingBlocker: "Fingerprints detect but cannot prevent a host process (a provider CLI) from transiently mutating and restoring the primary; ignored primary files are not fingerprinted." },
    { id: "hostControlledApplication", state: "satisfied", evidenceKind: "mechanical",
      evidence: "The workflow engine routes every Writer attempt through core ChangeSet validation and host application into a fresh private candidate with a mutation ledger (O5.5B7).",
      remainingBlocker: "None for application itself; the route is exercised with fake providers only (see hostControlledWriterWorkflow)." },
    { id: "hostControlledWriterWorkflow", state: "partial", evidenceKind: "fakeProviderRehearsal",
      evidence: "Offline rehearsal through the real engine and the `fusion build` seam: Lead plan, read-only Change Author, validation, host application, confined verification, fresh Reviewer, Lead adjudication, bounded correction from baseline.",
      remainingBlocker: "Fake-provider evidence only; no real provider has produced a ChangeSet or review on this route." },
    { id: "providerChangeProposal", state: "blocked", evidenceKind: "none",
      evidence: "Adapters expose a read-only change-proposal turn and the production route consumes it; Worker bindings stay refused by the registry.",
      remainingBlocker: "No authorized real-provider proposal run; adapters bind their working directory at construction, so a real Change Author reads the primary checkout rather than the candidate." },
    { id: "verificationIsolation", state: accepted ? "satisfiedForLinuxScope" : "notEvaluated", evidenceKind: accepted ? "liveProcess" : "none",
      evidence: accepted ? `Granted ${accepted.contract} acceptance: ${accepted.evidence.passed}/${accepted.evidence.required} facts on ${accepted.runtime.image} (${accepted.runtime.node}).`
        : "The docker-linux backend and the acceptance authority exist; no acceptance was granted in this process.",
      remainingBlocker: "Windows-required verification has no confined backend; Linux acceptance never implies Windows acceptance." },
    { id: "platformCompatibility", state: "satisfied", evidenceKind: "mechanical",
      evidence: "Declared platform requirement with deterministic escalation; unknown/missing and windows-required fail closed for docker-linux and end the Writer run as platformIncompatible.",
      remainingBlocker: "Signals are conservative heuristics; tasks without a declaration stay unknown and cannot be verified autonomously." },
    { id: "dependencySupport", state: "partial", evidenceKind: "mechanical",
      evidence: "Restricted npm lane: approved lockfile identity, registry-only sha512 packages, no lifecycle scripts, immutable copy-on-use artifact; a ChangeSet touching a manifest stops at the human gate without explicit host approval.",
      remainingBlocker: "Other package managers, workspaces, git/file dependencies and packages needing install scripts are unsupported." },
    { id: "cleanupAndRecovery", state: "satisfied", evidenceKind: "mechanical",
      evidence: "Per-run ownership-scoped removal, every Writer candidate released and proven gone (an unproven release is never a success), plus a bounded, label-verified, age-gated crash-recovery sweep.",
      remainingBlocker: "The sweep is invoked explicitly; no scheduler runs it at startup." },
    { id: "reviewAndAdjudication", state: "satisfied", evidenceKind: "mechanical",
      evidence: "Fresh Reviewer isolation and Lead adjudication with Fusion-evidence override (O4/O5.5A), integrated into the Writer route.",
      remainingBlocker: "None for the gate itself." },
    { id: "billingAndAuthPosture", state: "partial", evidenceKind: "mechanical",
      evidence: "BillingGuard enforces subscription lanes for read-only roles.",
      remainingBlocker: "Not evaluated for a Writer binding because Worker bindings are refused." },
    { id: "sharedGitAndIgnoredPaths", state: "partial", evidenceKind: "mechanical",
      evidence: "Verification receives no .git and no node_modules; candidates are host-applied with ignored-path checks.",
      remainingBlocker: "Provider change-author processes still run on the host without an OS filesystem boundary." },
    { id: "liveGateAuthorization", state: "blocked", evidenceKind: "none",
      evidence: "REAL_WRITER_LIVE_GATE_AUTHORIZED is a constant false.",
      remainingBlocker: "Requires a separate, explicitly authorized milestone." },
  ];
  return Object.freeze({ realWriterModeReady: false, liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED,
    verificationIsolation: Object.freeze({ linux: accepted ? "accepted" as const : "notEvaluated" as const, windows: "unsupported" as const }),
    rows: Object.freeze(rows.map(row => Object.freeze(row))) });
}
