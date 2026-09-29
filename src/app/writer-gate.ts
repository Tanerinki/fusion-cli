import { createHash } from "node:crypto";
import { isGrantedAcceptance, type VerificationIsolationAcceptance } from "../platform/verification/acceptance.js";
import { adjudicationLiveRecords, changeProposalEnvelopeCoverage, correctionLiveRecords, fullRouteLiveCoverage, fullRouteLiveRecords,
  liveChangeProposalCoverage } from "../runtime/provider-profiles.js";
import { disposableApplyLiveRecords } from "./delivery-live-records.js";

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
  Object.freeze({ id: "writerPosture", text: "The production Writer route is composable (real Change Author bindings, candidate port, provider views, accepted confined verification, fresh review). Authorized live probes, one proposal turn each (O5.5B9, O5.5B11; single-file task, Worker-only flow): every Change Author family has one ChangeSet validated, host-applied into a private candidate and verified in the accepted confined backend (one family only on its second authorized turn, after a refused first reply and the O5.5B10 envelope). Single samples on one fixture. The first authorized live full-route run (O5.5B13) ended at its first turn, the Lead plan (the provider reported a failed turn). A Lead-plan-only live probe under the same bindings (O5.5B15) ended at the CLI's own turn limit (error_max_turns, 6 turns) before any reply, so its plan was never parsed. Its retest under a planning-specific Lead prompt (O5.5B17) answered within the same limit, but its reply, one fenced JSON object, was refused by the Lead's raw-only reply envelope before the plan contract was checked. With the Lead reading one outer JSON fence (O5.5B18), a further Lead-only retest (O5.5B21) passed end to end: the real Lead plan was accepted; no later role ran. A Reviewer-only probe (O5.5B24) passed on the Reviewer family's installed 1.4 release, which is validated for exactly that Reviewer binding and binary. The second live full-route run (O5.5B25) ended at the Change Author's first turn: the Lead plan was accepted again, and the Change Author's model turn answered, but its reply carried prose before one fenced ChangeSet and was refused by the Change Author's reply envelope before the ChangeSet contract; no Reviewer, adjudication or confined verification ran in that run. The third live full-route run (O5.5B27), after the Change Author's output discipline (O5.5B26), passed: the Lead plan was accepted; the first ChangeSet was validated and host-applied into a private candidate but failed confined verification (one unit test), so Fusion retried with a fresh candidate; the second ChangeSet was validated, host-applied and passed confined verification, and the fresh Reviewer reported no findings. No adjudication or review-driven correction ran; nothing was delivered to a primary checkout. One sample on one throw-away fixture. A Lead-adjudication probe (O5.5B29) then passed: one real adjudication of three Fusion-authored findings was accepted by the production contract, and the policy sent one finding back for correction. A review-correction probe (O5.5B31), entered after that decision, ran the corrective Change Author (its ChangeSet validated, host-applied into a fresh private candidate and verified) and, after that verification, a fresh re-review whose contract accepted one finding; the cycle-2 adjudication that finding needs was not run. Nothing was delivered to a primary checkout. Single samples." }),
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
  /** v0.1: how it was authorized — `runConfirmation` (a human confirmed exactly this build), or `none`. */
  readonly basis: "runConfirmation" | "none";
}

/**
 * v0.1 — the HUMAN-ISSUED, RUN-SCOPED Writer authorization this gate always anticipated. The CLI issues one only after a
 * human at an interactive terminal read the build plan (task, risk, workflow, providers per role, verification) and typed
 * the confirmation word; it is bound to that exact task text and repository, and it is used once. It authorizes the
 * HOST-CONTROLLED build only: read-only provider sessions in Fusion-owned views, ChangeSets validated and applied by
 * Fusion into private candidates, confined verification, a fresh review — ending in a prepared delivery the human must
 * still approve and apply. It never grants a provider write access, and nothing a provider says, no configuration, no
 * environment variable and no flag can issue one. The blanket constant `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays false.
 */
export interface WriterRunAuthorization {
  readonly format: "fusion.writerRunAuthorization";
  /** SHA-256 of the confirmed task text AND its confirmed write scope (the exact file list). */
  readonly taskSha256: string;
  readonly repositoryRoot: string;
  /** `typedBuildConfirmation`: the human typed "build" (`fusion build`); `confirmedBuildPlan` (v0.2 shell): an explicit yes. */
  readonly confirmation: "typedBuildConfirmation" | "confirmedBuildPlan";
  readonly issuedAt: string;
}
export const BUILD_CONFIRMATION_WORD = "build";
const ISSUED_RUNS = new WeakSet<object>();
const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
/**
 * What a confirmation covers: the task text and the exact write scope (order-insensitive) — and, v0.5, a tournament's candidate
 * count: several candidates are several authors' runs, so a human confirms that number too. One candidate binds exactly what
 * it bound in v0.4.
 */
const confirmedRequest = (task: string, paths: readonly string[], candidates = 1): string =>
  JSON.stringify(candidates > 1 ? { task, paths: [...paths].sort(), candidates } : { task, paths: [...paths].sort() });
const samePath = (a: string, b: string): boolean => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
/** Issues a run authorization when the human typed exactly the confirmation word (trimmed, any case); otherwise none. */
export function issueWriterRunAuthorization(input: Readonly<{ task: string; paths: readonly string[]; repositoryRoot: string; typed: string | null;
  candidates?: number }>): WriterRunAuthorization | undefined {
  if (input.typed === null || input.typed.trim().toLowerCase() !== BUILD_CONFIRMATION_WORD) return undefined;
  const authorization: WriterRunAuthorization = Object.freeze({ format: "fusion.writerRunAuthorization",
    taskSha256: digest(confirmedRequest(input.task, input.paths, input.candidates)),
    repositoryRoot: input.repositoryRoot, confirmation: "typedBuildConfirmation", issuedAt: new Date().toISOString() });
  ISSUED_RUNS.add(authorization);
  return authorization;
}
/** v0.2: the only answers that confirm a shown build plan in the shell: an explicit yes. There is no default answer. */
export const PLAN_CONFIRMATION_ANSWERS = Object.freeze(["y", "yes", "j", "ja"] as const);
/**
 * v0.2 — the shell's form of the same run-scoped authorization: the human answered an explicit yes (`y`, `yes`, `j`, `ja`)
 * under the shown build plan. It binds exactly what the typed form binds (task text, write scope, repository) and is used
 * once; it is recorded as `confirmedBuildPlan`.
 */
export function issueConfirmedPlanAuthorization(input: Readonly<{ task: string; paths: readonly string[]; repositoryRoot: string; answer: string | null;
  candidates?: number }>): WriterRunAuthorization | undefined {
  if (input.answer === null || !(PLAN_CONFIRMATION_ANSWERS as readonly string[]).includes(input.answer.trim().toLowerCase())) return undefined;
  const authorization: WriterRunAuthorization = Object.freeze({ format: "fusion.writerRunAuthorization",
    taskSha256: digest(confirmedRequest(input.task, input.paths, input.candidates)),
    repositoryRoot: input.repositoryRoot, confirmation: "confirmedBuildPlan", issuedAt: new Date().toISOString() });
  ISSUED_RUNS.add(authorization);
  return authorization;
}
/**
 * Whether a Writer run may start. The blanket constant is false; a run passes only with a run authorization this process
 * issued for exactly this task and repository, which the check consumes (one build per confirmation).
 */
export function liveWriterAuthorization(run?: Readonly<{ authorization?: WriterRunAuthorization; task: string; paths: readonly string[];
  repositoryRoot: string; candidates?: number }>): LiveWriterAuthorization {
  const blanket: boolean = REAL_WRITER_LIVE_GATE_AUTHORIZED;
  if (blanket) return Object.freeze({ authorized: true, code: REAL_WRITER_MODE_NOT_READY, reason: "authorized", basis: "none" });
  const authorization = run?.authorization;
  if (authorization !== undefined && ISSUED_RUNS.has(authorization) &&
      authorization.taskSha256 === digest(confirmedRequest(run!.task, run!.paths, run!.candidates)) &&
      samePath(authorization.repositoryRoot, run!.repositoryRoot)) {
    ISSUED_RUNS.delete(authorization);
    return Object.freeze({ authorized: true, code: REAL_WRITER_MODE_NOT_READY, basis: "runConfirmation",
      reason: "A human confirmed exactly this build at an interactive terminal." });
  }
  return Object.freeze({ authorized: false, code: REAL_WRITER_MODE_NOT_READY, basis: "none",
    reason: "A Writer build runs only after a human confirms it at an interactive terminal (fusion build asks for it)." });
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
  // A live full route is a single sample on one fixture: even a PASS is `partial`, a failure keeps the row blocked.
  const route = fullRouteLiveCoverage();
  // O5.5B27: a passing live route proves only the branches it took; name the conditional ones no passing run exercised.
  const passes = fullRouteLiveRecords().filter(record => record.outcome === "PASS");
  // O5.5B29: a Lead adjudication proven live only as an isolated probe (outside any route) is named as such.
  const isolatedAdjudications = adjudicationLiveRecords().filter(record => record.outcome === "PASS").map(record => record.milestone);
  // O5.5B31: the review-driven correction and the re-review after it, proven live only as an isolated probe of that branch.
  const isolatedCorrections = correctionLiveRecords().filter(record => record.correction === "PASS" && record.rereview === "PASS")
    .map(record => record.milestone);
  const neverLive = [...(passes.some(record => record.adjudication === "PASS") ? [] : [`Lead adjudication of review findings${isolatedAdjudications.length > 0
    ? ` (live only as an isolated probe: ${isolatedAdjudications.join(", ")})` : ""}`]),
    ...(passes.some(record => record.correction === "PASS") ? [] : [`review-driven correction and re-review${isolatedCorrections.length > 0
      ? ` (live only as an isolated probe: ${isolatedCorrections.join(", ")})` : ""}`])];
  /**
   * O5.5B31: the private-candidate Writer workflow is satisfied when (1) every provider turn kind of the route has run live
   * under its production binding, prompt, envelope and contract — the Lead plan, the initial Change Author and the fresh
   * review in a passing route; the Lead adjudication, the corrective Change Author and the re-review after a correction at
   * least in an isolated probe of their branch — (2) every host step has run live (validation, application into private
   * candidates, confined verification passing and failing, the mechanical retry, release, integrity), and (3) every engine
   * transition is exercised offline by the real engine and adapter code (the route rehearsal, including a cycle-2
   * adjudication and its gate). Transitions seen live only in pieces are named in the blocker; single samples.
   */
  const everyTurnKindLive = route.passed > 0 && (passes.some(record => record.adjudication === "PASS") || isolatedAdjudications.length > 0) &&
    (passes.some(record => record.correction === "PASS") || isolatedCorrections.length > 0);
  // O5.5C3 Stage 2: the recorded disposable apply rehearsal, if one passed.
  const disposablePass = disposableApplyLiveRecords().find(record => record.outcome === "PASS");
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
      remainingBlocker: "None for application itself; its live evidence is recorded with the workflow (see hostControlledWriterWorkflow)." },
    { id: "humanApprovedDelivery", state: "partial", evidenceKind: "mechanical",
      evidence: "Offline delivery foundation (O5.5C1): a canonical, digest-bound delivery manifest (identities, exact paths and before/after digests, evidence digests, safety policy; no provider text) and bundle (the exact validated bytes); an approval boundary (only an approval issued in this process for the exact manifest digest approves, once; prepared → approved → applying → applied | failed | rolledBack | rollbackFailed); a local applier with a read-only precheck of every operation before any write (repository identity, HEAD and tree, a clean tree, no filter drivers, preimages, no links, no ignored paths), Fusion-owned staging, per-file atomic replacement where the filesystem provides it, a journaled and verified rollback, and a postcheck — exercised on local test repositories only. " +
        "O5.5C2: a persistent delivery store (write-once, hash-revalidated artifacts and an append-only lifecycle event log in Fusion's application state outside the target repository, O5.5C2.1), `fusion inspect-delivery` (read-only, with a verified diff), a durable human approval (typed exact manifest digest at an interactive terminal; bound to the delivery id, manifest and bundle digests, repository identity and base commit; used once) and `fusion apply` (approval, then the full precheck, then the apply) — the apply exercised on disposable test repositories only. " +
        "O5.5C3: one human-approved live rehearsal of those commands on a disposable repository Fusion created passed (see disposablePrimaryApplyLive). " +
        "O5.5C4: `fusion apply` is the production path for a delivery a human approved — the approval (bound to the checkout) is the delivery authorization; a refused read-only precheck keeps it, a single-use mutation claim taken just before the first write spends it (see productionApplyPolicyImplementation); exercised offline on ordinary temporary repositories through the normal CLI.",
      remainingBlocker: "No ordinary or real checkout has received a delivery through the normal `fusion apply` live (REAL_PRIMARY_APPLY_LIVE not run: the O5.5C4 policy is proven offline only), and no command prepares a delivery from a real Writer run (Writer mode is not ready); multi-file delivery is a journaled rollback, not a filesystem transaction, and nothing resumes an interrupted journal; a dirty tree, a filter driver, or primary bytes that differ from the baseline's (converted line endings included) are refused." },
    { id: "deliveryStoreImplementation", state: "satisfied", evidenceKind: "mechanical",
      evidence: "O5.5C2: a provider-neutral delivery store; its filesystem implementation lives in Fusion's application state outside every target repository (O5.5C2.1: %LOCALAPPDATA%\\Fusion\\deliveries or $XDG_STATE_HOME/fusion/deliveries; one namespace per repository identity, each delivery bound to its checkout; a base overlapping the repository is refused): canonical manifest and exact bundle written once (temporary file, fsync, exclusive link), the same id with different bytes refused, every digest and binding revalidated on each read, bounded sizes, links and reparse points refused, a strict append-only lifecycle event log (metadata only) whose torn or out-of-order entries fail closed.",
      remainingBlocker: "Implementation only: no live delivery used it; nothing resumes an interrupted apply journal." },
    { id: "deliveryInspectImplementation", state: "satisfied", evidenceKind: "mechanical",
      evidence: "O5.5C2: `fusion inspect-delivery <id>` shows a revalidated delivery (digests in full, target, operations with before/after digests and sizes, verification, review and adjudication counts, safety policy and caps, approval and the digests it covers, events) and a bounded unified diff whose preimage is accepted only when its digest matches the manifest; read-only, provider-free.",
      remainingBlocker: "Implementation only; binary, oversized or unverifiable preimages are named, not diffed." },
    { id: "humanApprovalImplementation", state: "satisfied", evidenceKind: "mechanical",
      evidence: "O5.5C2: `fusion approve-delivery <id>` records a durable approval only when a human at an interactive terminal types the exact manifest digest that was shown and the stored delivery still carries it; no default, non-interactive use and `--json` refused; the approval binds the delivery id, manifest and bundle digests, repository identity, base commit and (O5.5C4) the checkout, is re-derived and checked before every apply, authorizes exactly one claimed apply of this delivery in this checkout, and never skips the precheck.",
      remainingBlocker: "Implementation only: no ordinary checkout has been applied with it live (see humanApprovedDelivery); it is never the autonomous Writer live gate." },
    { id: "productionApplyPolicyImplementation", state: "satisfied", evidenceKind: "mechanical",
      evidence: "O5.5C4: `fusion apply <id>` applies an approved delivery through the normal CLI: artifacts reloaded and revalidated; the exact durable approval re-derived (delivery id, manifest, bundle, repository identity, base, checkout); the exact bound checkout resolved from the working directory (another checkout or a same-content clone is refused; no option redirects it); an exclusive attempt lock (a concurrent attempt is refused); the applier's fail-closed read-only precheck (identity, HEAD and tree, clean tree, no filter drivers, preimages, create targets absent, update and delete targets present, no links or reparse points, no ignored paths); only then a single-use mutation claim bound to delivery, manifest, bundle and checkout, immediately before the first write; staged apply of the exact approved bytes, postcheck, verified rollback; every step as bounded events. A refused precheck writes nothing and keeps the approval; after the claim the approval is spent (no replay, not even after a rollback). No force, no `--yes`, no variable or configuration bypass; no provider or model.",
      remainingBlocker: "Implementation only: proven offline on ordinary temporary repositories; not yet run live on a designated ordinary repository (REAL_PRIMARY_APPLY_LIVE not run); an attempt interrupted before its claim leaves the delivery locked (fail closed)." },
    { id: "disposablePrimaryApplyLive", state: disposablePass === undefined ? "notEvaluated" : "satisfied",
      evidenceKind: disposablePass === undefined ? "none" : "recordedLiveProbe",
      evidence: "A one-shot, human-approved rehearsal (authorization O5.5C3-DISPOSABLE-APPLY) of the real preparation, store, `fusion inspect-delivery`, `fusion approve-delivery` (the human types the full manifest digest) and `fusion apply` (precheck, apply, postcheck) against a Git repository Fusion itself creates under the temporary namespace fusion-o5-5c3-delivery; no provider, model or network." +
        (disposablePass === undefined ? " Exercised offline only." : ` Live: the human ran it once (${disposablePass.milestone}, ${disposablePass.outcome}): delivery ${disposablePass.deliveryId}, manifest ${disposablePass.manifestSha256.slice(0, 12)}…; its evidence (${disposablePass.evidenceSha256.slice(0, 12)}…) independently revalidated offline against ${disposablePass.validationCriteria} criteria (${disposablePass.embeddedChecks} embedded checks true): exact typed digest, five-way approval binding, one claim, the production gate closed, precheck before mutation, exact final hashes, both canaries unchanged, no undeclared change, a valid event sequence, no provider or model, the Fusion checkout unchanged.`),
      remainingBlocker: disposablePass === undefined
        ? "Not run: the one authorized rehearsal awaits the human's run. Even a pass proves the delivery mechanics on a disposable repository only: no real checkout is ever a target (no live delivery authorization; REAL_PRIMARY_APPLY is not authorized)."
        : "Satisfied for a disposable, Fusion-created repository only (one sample): no ordinary or real checkout has received a delivery (REAL_PRIMARY_APPLY_LIVE not run)." },
    { id: "hostControlledWriterWorkflow", state: everyTurnKindLive ? "satisfied" : "partial",
      evidenceKind: route.passed > 0 ? "recordedLiveProbe" : "fakeProviderRehearsal",
      evidence: "Offline rehearsal through the real engine and the `fusion build` seam: Lead plan, read-only Change Author, validation, host application, confined verification, fresh Reviewer, Lead adjudication, bounded correction from baseline — every session in a Fusion-owned view." +
        (route.passed > 0 ? ` Live: ${route.passed} authorized full-route run(s) passed with real providers for every role — Lead plan, read-only Change Author, validation and host application into private candidates, a mechanical retry after a failed confined verification, confined verification, fresh Reviewer (see fullRouteLive).` : "") +
        (everyTurnKindLive ? ` Every provider turn kind of the route has run live under its production contract: the Lead adjudication (${isolatedAdjudications.join(", ") || "in a route"}), the corrective Change Author and the re-review after a correction (${isolatedCorrections.join(", ") || "in a route"}) as isolated probes of their branch; every transition, a cycle-2 adjudication and its gate included, is exercised offline by the real engine.` : ""),
      remainingBlocker: everyTurnKindLive
        ? `Satisfied for the private-candidate workflow only. Never run live in a route: ${neverLive.join("; ") || "none"}; never run live at all: a cycle-2 Lead adjudication (the same adjudication turn as the live one; its transition is exercised offline). Single samples on one throw-away fixture. The workflow ends in a private candidate: nothing is delivered to a primary checkout (no command prepares a delivery from a Writer run; see humanApprovedDelivery), and a real Writer run stays refused (liveGateAuthorization).`
        : route.passed > 0
        ? `Never run live in a route: ${neverLive.join("; ") || "none"}. One sample on one throw-away fixture. The workflow ends in a private candidate: nothing is delivered to a primary checkout (no command prepares a delivery from a Writer run; see humanApprovedDelivery), and a real Writer run stays refused (liveGateAuthorization).`
        : "The full route (real Lead plan, fresh Reviewer, adjudication, correction) ran with fake providers only; a real provider's ChangeSet has been proven only on the low-risk Worker-only path (see providerChangeProposal)." },
    { id: "fullRouteRehearsalImplementation", state: "satisfied", evidenceKind: "fakeProcess",
      evidence: "A bounded full-route live rehearsal harness (O5.5B12): a named route authorization freezing, per role, the provider family, executable, runtime versions, lanes and exact binding, and per turn class a maximum count equal to the engine's own bounds; a turn gate that admits a model turn only in the engine state requiring it, in order and within budget, consuming its slot durably before the provider is reached; a pre-launch guard over every process of every role (authorized executable, checked view of the turn's kind, no primary path, no forbidden variable, read-only controls, one model process per turn); per-role static preflight; bounded evidence per role turn. Exercised with the real adapter code of every role against deterministic fake processes.",
      remainingBlocker: "Implementation evidence says nothing about real Lead, Reviewer or adjudication behaviour; the recorded live runs are in fullRouteLive." },
    { id: "fullRouteLive", state: route.passed > 0 ? "partial" : "blocked", evidenceKind: route.attempts > 0 ? "recordedLiveProbe" : "none",
      evidence: `Authorized live full-route rehearsals (real providers for every role on the throw-away fixture, one run per authorization, recorded from an independently validated evidence file): ${route.attempts} run, ${route.passed} passed.${route.latest === undefined ? "" : ` The latest (${route.latest.milestone}) ended ${route.latest.outcome}${route.latest.endedAt === undefined ? "" : ` at ${route.latest.endedAt}`} after ${route.latest.modelTurns} model turn(s), ${route.latest.rolesRun} of 3 roles run.`}`,
      remainingBlocker: route.passed > 0 ? `A live pass is a single sample on one throw-away fixture; it authorizes no Writer run.${neverLive.length > 0 ? ` Never run live in a passing route: ${neverLive.join("; ")}.` : ""}`
        : "No live full route has passed; the roles a failed run never reached are unproven inside the route. Another run needs its cause fixed offline and a new explicit human authorization." },
    { id: "productionWriterComposition", state: "satisfied", evidenceKind: "mechanical",
      evidence: "composeProductionWriter builds real Lead, Explorer, read-only Change Author and Reviewer bindings from the registry (sessions only in views), the private candidate port bound to a granted acceptance (or refusing verification without one; never the trusted host), the provider view port and the confined plan; `fusion build` refuses a Writer task before composing anything while the live gate is closed.",
      remainingBlocker: "Composed and exercised with deterministic fixtures; no actual production Writer run is authorized." },
    { id: "providerChangeProposalImplementation", state: "satisfied", evidenceKind: "fakeProcess",
      evidence: "Change Author bindings of both registered adapter families (read-only launch posture, structured change-proposal turn, view-bound sessions, BillingGuard and auth readback) exercised through the real adapter code against deterministic fake native processes, including a full Writer workflow.",
      remainingBlocker: "Implementation only: it says nothing about a real provider's output or posture (see providerChangeProposal)." },
    { id: "structuredOutputEnvelope", state: "satisfied", evidenceKind: "fakeProcess",
      evidence: `Every structured reply must be one strict JSON value; ${envelopes.singleFence} of ${envelopes.changeAuthors} Change Author families also read a proposal inside exactly one outer json/bare Markdown fence with only whitespace outside it (the O5.5B10 grammar), whose object body then passes the same strict parser, the decoding-schema check and the unchanged ChangeSet validator. Prose, trailing text, several fences or several values are refused, never extracted or repaired; a structure-only diagnostic (classes, flags and counts, never content) describes every structured reply, accepted or refused.`,
      remainingBlocker: `Implementation proven against deterministic fake processes. Live replies through the fence path: Change Author proposals (O5.5B11, and two in the O5.5B27 route) and Lead plans (O5.5B21, O5.5B25, O5.5B27); ${isolatedAdjudications.length > 0 ? `Lead adjudications only as an isolated probe (${isolatedAdjudications.join(", ")})` : "no Lead adjudication reply has run live"}. Single samples on one fixture per context.` },
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
      remainingBlocker: "Live auth readback was observed in the authorized probes and live routes only (per family: the passing proposal probes O5.5B9, O5.5B11; the Lead and Change Author readbacks and the attested Reviewer lane in O5.5B25 and O5.5B27; the Lead adjudication probe O5.5B29); single samples." },
    { id: "sharedGitAndIgnoredPaths", state: "partial", evidenceKind: "mechanical",
      evidence: "Provider views contain no .git and no ignored files; candidates are private clones; verification receives no .git and no node_modules; ignored primary paths are monitored (ignoredPathProtection).",
      remainingBlocker: "Provider processes still run on the host without an OS filesystem boundary." },
    { id: "productionBuildImplementation", state: "satisfied", evidenceKind: "mechanical",
      evidence: "v0.1: `fusion build` runs the host-controlled Writer route in production for ONE build a human confirmed at an interactive terminal (the plan — task, risk, workflow, providers per role, confined verification, the exact files it may write — then the typed confirmation word; a run-scoped authorization bound to that task, that file scope and that repository, used once). Without --path the Lead proposes the file scope in one read-only turn, after a verification preflight. Refused before any model turn of the run: without the confirmation (non-interactive, --json, declined), without a confined verification plan, for a platform without a confined backend, or without a granted verification acceptance. A completed, verified, review-clean run becomes a prepared delivery (exact validated bytes, bound to the checkout and its HEAD at the start); nothing is applied until the human approves and applies it. Exercised offline with the real engine and adapters on fake binaries; an offline rehearsal is never delivered.",
      remainingBlocker: "Implementation only: no live `fusion build` has run (the v0.1 live smoke is the human's); Windows-required verification has no confined backend; an interrupted build leaves its private candidates to the stale sweep." },
    { id: "liveGateAuthorization", state: "blocked", evidenceKind: "none",
      evidence: "REAL_WRITER_LIVE_GATE_AUTHORIZED is a constant false: there is no blanket Writer authorization, and no unattended Writer run is possible. v0.1: liveWriterAuthorization() admits exactly one host-controlled build per run-scoped authorization a human issued at an interactive terminal (see productionBuildImplementation); nothing else — no configuration, flag, variable or provider output — authorizes a Writer run.",
      remainingBlocker: "An unattended (non-interactive) or provider-write-capable Writer requires a separate, explicitly authorized milestone." },
  ];
  return Object.freeze({ realWriterModeReady: false, liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED,
    verificationIsolation: Object.freeze({ linux: accepted ? "accepted" as const : "notEvaluated" as const, windows: "unsupported" as const }),
    rows: Object.freeze(rows.map(row => Object.freeze(row))) });
}
