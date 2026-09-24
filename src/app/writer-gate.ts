import { isGrantedAcceptance, type VerificationIsolationAcceptance } from "../platform/verification/acceptance.js";
import { changeProposalEnvelopeCoverage, liveChangeProposalCoverage } from "../runtime/provider-profiles.js";

/**
 * The real Writer mode gate. It is a constant, not a setting: no configuration, flag or environment variable can open
 * it. It mirrors `REAL_WRITER_MODE_BLOCKED_UNTIL` in docs/o3-workflow.md, which remains authoritative.
 */
export const REAL_WRITER_MODE_NOT_READY = "REAL_WRITER_MODE_NOT_READY";
/** No milestone so far authorizes a real provider Writer run; opening it needs its own explicit authorization. */
export const REAL_WRITER_LIVE_GATE_AUTHORIZED = false as const;
export const REAL_WRITER_MODE_PREREQUISITES = Object.freeze([
  Object.freeze({ id: "ignoredPathInfluence", text: "Ignored primary paths are monitored with a bounded policy (sensitive and protected files by content, others by metadata, managed directories such as node_modules by a directory-level signal only); coverage is partial by design and detection is not prevention." }),
  Object.freeze({ id: "sharedGitState", text: "Provider sessions run only in Fusion-owned views with no .git, candidates are private clones and confined verification receives no .git; provider CLIs still run on the host under the user's token without an OS filesystem boundary." }),
  Object.freeze({ id: "stateFingerprints", text: "Git, ignored-path and controlled-tree fingerprints detect changes (the primary against the run's first observation), but cannot prevent a process from briefly mutating and restoring content they do not hash." }),
  Object.freeze({ id: "verificationIsolation", text: "Linux-compatible verification can run in the confined docker-linux backend (accepted only per process from freshly observed evidence); Windows-required verification has no confined backend." }),
  Object.freeze({ id: "writerPosture", text: "The production Writer route is composable (real Change Author bindings, candidate port, provider views, accepted confined verification, fresh review). Authorized live probes, one proposal turn each (O5.5B9, O5.5B11; single-file task, Worker-only flow): every Change Author family has one ChangeSet validated, host-applied into a private candidate and verified in the accepted confined backend (one family only on its second authorized turn, after a refused first reply and the O5.5B10 envelope). Single samples on one fixture. The full route with real Lead, Reviewer and adjudication has not run live." }),
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

/** The authorization `fusion build` asks for before composing any production Writer component. */
export interface LiveWriterAuthorization {
  readonly authorized: boolean;
  readonly code: typeof REAL_WRITER_MODE_NOT_READY;
  readonly reason: string;
}
/**
 * Whether an actual autonomous Writer run may start. Today the constant decides, and it is `false`: `fusion build`
 * refuses a Writer task before any adapter, candidate, view or container exists. A future authorization mechanism
 * (an explicit, human-issued, run-scoped authorization) must be added here, in its own authorized milestone; nothing
 * a provider says, no configuration and no fake evidence reaches this function.
 */
export function liveWriterAuthorization(): LiveWriterAuthorization {
  const authorized: boolean = REAL_WRITER_LIVE_GATE_AUTHORIZED;
  return Object.freeze({ authorized, code: REAL_WRITER_MODE_NOT_READY,
    reason: authorized ? "authorized" : "REAL_WRITER_LIVE_GATE_AUTHORIZED is false: no real provider Writer run is authorized." });
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
 * `fakeProcess`: the REAL adapter code ran against deterministic fake native provider processes — it proves the argv,
 * working directory and environment Fusion constructs, never a real provider's behaviour.
 * `fakeProviderRehearsal`: the route ran end to end with deterministic fake providers only — it can never prove a real
 * provider's behaviour. `liveProcess`: observed in this process (a granted acceptance). `recordedLiveProbe`: an
 * authorized real-provider probe whose evidence file was validated and documented in its milestone, recorded as static
 * data bound to the exact runtime version probed — not re-observed in this process. `none`: nothing holds yet.
 */
export type WriterGateEvidence = "mechanical" | "fakeProcess" | "fakeProviderRehearsal" | "liveProcess" | "recordedLiveProbe" | "none";
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
 * fake-provider and fake-process evidence prove wiring and launch construction, never a real provider's posture. The
 * provider change-proposal row reads only the recorded live-probe data of the provider profiles: `satisfied` requires a
 * recorded PASS for every registered Change Author family on a validated version, one or more is `partial`, none `blocked`.
 */
export function writerGateReport(inputs: Readonly<{ linuxVerification?: unknown }> = {}): WriterGateReport {
  const accepted: VerificationIsolationAcceptance | undefined = isGrantedAcceptance(inputs.linuxVerification)
    ? inputs.linuxVerification : undefined;
  const live = liveChangeProposalCoverage();
  const envelopes = changeProposalEnvelopeCoverage();
  const proposalState: WriterGateState = live.passed === 0 ? "blocked" : live.passed === live.changeAuthors ? "satisfied" : "partial";
  const rows: WriterGateRow[] = [
    { id: "primaryProtection", state: "partial", evidenceKind: "mechanical",
      evidence: "No provider session of a workflow runs in the primary (Fusion-owned views only); the primary fingerprint — Git state, tracked and untracked files, bounded ignored-path monitoring including .env and protected paths — is held to the run's first observation around every turn, application and verification; the applier refuses any root but its own candidate; confined verification cannot reach any host path.",
      remainingBlocker: "Detection, not prevention: a provider CLI running under the user's token can still open absolute host paths (NOT OS-ISOLATED); a transient mutate-and-restore of content Fusion does not hash, and changes inside managed ignored directories, are not detected." },
    { id: "providerWorkspaceBoundary", state: "partial", evidenceKind: "fakeProcess",
      evidence: "Every provider session of a workflow is bound to a Fusion-owned view (baseline, candidate copy or working-tree copy, no .git, no provider state paths) whose fingerprint must stay equal to its identity; the real one-shot and exec adapter code starts every process with the view as working directory and workspace and refuses the primary; a durable-host transport that cannot bind a per-session workspace refuses view-bound sessions.",
      remainingBlocker: "A view is a working directory, not an OS filesystem boundary; the binding is proven against fake native processes only." },
    { id: "ignoredPathProtection", state: "partial", evidenceKind: "mechanical",
      evidence: "Git's ignored listing plus sensitive (.env*, keys, credential stores, *.local) and user-protected paths by content hash, other ignored files by metadata, sensitive directories walked; digests and counts only, never content.",
      remainingBlocker: "Managed ignored directories (node_modules, dist, .venv, …) are monitored by a directory-level signal only; non-sensitive ignored files by metadata only; bounds turn coverage partial." },
    { id: "hostControlledApplication", state: "satisfied", evidenceKind: "mechanical",
      evidence: "The workflow engine routes every Writer attempt through core ChangeSet validation and host application into a fresh private candidate with a mutation ledger (O5.5B7).",
      remainingBlocker: "None for application itself; the route is exercised with fake providers only (see hostControlledWriterWorkflow)." },
    { id: "hostControlledWriterWorkflow", state: "partial", evidenceKind: "fakeProviderRehearsal",
      evidence: "Offline rehearsal through the real engine and the `fusion build` seam: Lead plan, read-only Change Author, validation, host application, confined verification, fresh Reviewer, Lead adjudication, bounded correction from baseline — every session in a Fusion-owned view.",
      remainingBlocker: "The full route (real Lead plan, fresh Reviewer, adjudication, correction) ran with fake providers only; a real provider's ChangeSet has been proven only on the low-risk Worker-only path (see providerChangeProposal)." },
    { id: "productionWriterComposition", state: "satisfied", evidenceKind: "mechanical",
      evidence: "composeProductionWriter builds real Lead, Explorer, read-only Change Author and Reviewer bindings from the registry (sessions only in views), the private candidate port bound to a granted acceptance (or refusing verification without one; never the trusted host), the provider view port and the confined plan; `fusion build` refuses a Writer task before composing anything while the live gate is closed.",
      remainingBlocker: "Composed and exercised with deterministic fixtures; no actual production Writer run is authorized." },
    { id: "providerChangeProposalImplementation", state: "satisfied", evidenceKind: "fakeProcess",
      evidence: "Change Author bindings of both registered adapter families (read-only launch posture, structured change-proposal turn, view-bound sessions, BillingGuard and auth readback) exercised through the real adapter code against deterministic fake native processes, including a full Writer workflow.",
      remainingBlocker: "Implementation only: it says nothing about a real provider's output or posture (see providerChangeProposal)." },
    { id: "structuredOutputEnvelope", state: "satisfied", evidenceKind: "fakeProcess",
      evidence: `Every structured reply must be one strict JSON value; ${envelopes.singleFence} of ${envelopes.changeAuthors} Change Author families also read a proposal inside exactly one outer json/bare Markdown fence with only whitespace outside it (the O5.5B10 grammar), whose object body then passes the same strict parser, the decoding-schema check and the unchanged ChangeSet validator. Prose, trailing text, several fences or several values are refused, never extracted or repaired; a structure-only diagnostic (classes, flags and counts, never content) describes every structured reply, accepted or refused.`,
      remainingBlocker: "Implementation proven against deterministic fake processes; exactly one real reply (O5.5B11) has passed through the fence path, a single sample (see providerChangeProposal)." },
    { id: "providerChangeProposal", state: proposalState, evidenceKind: live.passed + live.failedOnly > 0 ? "recordedLiveProbe" : "none",
      evidence: `Authorized live change-proposal probes (one proposal turn per Change Author family through the production composition, bound to the exact runtime version, model and effort probed; the O5.5B9 and O5.5B11 milestone documents): ${live.passed} of ${live.changeAuthors} families' proposals validated, host-applied and verified in the accepted confined backend; ${live.failedOnly} refused fail-closed; ${live.unprobed} unprobed.`,
      remainingBlocker: proposalState === "satisfied" ? "Single-sample evidence per family on one trivial fixture, Worker-only flow; another runtime version, model or effort is not covered, and a passing proposal proves no Lead, Reviewer or adjudication behaviour."
        : "Not every Change Author family has a passing live probe on its validated runtime version; fake processes and provider text can never add one. Single-sample evidence on one fixture." },
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
      evidence: "Per-run ownership-scoped removal: every Writer candidate and provider view released and proven gone (an unproven release is never a success), marker-verified stale-view sweep, plus a bounded, label-verified, age-gated container crash-recovery sweep.",
      remainingBlocker: "The sweeps are invoked explicitly; no scheduler runs them at startup." },
    { id: "reviewAndAdjudication", state: "satisfied", evidenceKind: "mechanical",
      evidence: "Fresh Reviewer isolation and Lead adjudication with Fusion-evidence override (O4/O5.5A), integrated into the Writer route; review sessions read a copy of the candidate, never the candidate or the primary.",
      remainingBlocker: "None for the gate itself." },
    { id: "billingAndAuthPosture", state: "satisfied", evidenceKind: "mechanical",
      evidence: "BillingGuard and per-turn auth readback enforce subscription lanes for every binding, the read-only Change Author included; API-key, gateway and third-party routes block, and no PAYG fallback exists.",
      remainingBlocker: "Live Change Author auth readback was observed only in the single passing probe per family (O5.5B9, O5.5B11; see providerChangeProposal)." },
    { id: "sharedGitAndIgnoredPaths", state: "partial", evidenceKind: "mechanical",
      evidence: "Provider views contain no .git and no ignored files; candidates are private clones; verification receives no .git and no node_modules; ignored primary paths are monitored (ignoredPathProtection).",
      remainingBlocker: "Provider processes still run on the host without an OS filesystem boundary." },
    { id: "liveGateAuthorization", state: "blocked", evidenceKind: "none",
      evidence: "REAL_WRITER_LIVE_GATE_AUTHORIZED is a constant false; liveWriterAuthorization() refuses every Writer run.",
      remainingBlocker: "Requires a separate, explicitly authorized milestone." },
  ];
  return Object.freeze({ realWriterModeReady: false, liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED,
    verificationIsolation: Object.freeze({ linux: accepted ? "accepted" as const : "notEvaluated" as const, windows: "unsupported" as const }),
    rows: Object.freeze(rows.map(row => Object.freeze(row))) });
}
