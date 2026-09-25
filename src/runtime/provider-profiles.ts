import type { AuthLane, ProviderId } from "../core/domain.js";
import type { EnvironmentRuleSet } from "../core/policy/billing-guard.js";
import type { EnvelopePolicy, StructuredOutputClass } from "../platform/process/structured-envelope.js";
import type { TurnTerminalDiagnostic } from "../platform/process/terminal-diagnostic.js";
import { claudeEnvironmentRules, museEnvironmentRules } from "./provider-environment-rules.js";

/**
 * Declarative, provider-neutral descriptions of the providers Fusion can bind. This is a single source of truth for
 * the *static* facts about a provider — identity, transports, auth lanes, environment policy, and which release we
 * have actually validated — so those facts are not re-derived in scattered adapter code. It is deliberately data, not
 * behavior: adapters and the registry read it, and core workflow code never imports it, so no provider name leaks into
 * routing or policy. A profile proves nothing at runtime; capability and auth are still observed per turn by the
 * adapters and the billing/runtime gates.
 *
 * Compatibility is represented honestly. `validatedRuntimeVersions` lists only releases we have actually verified; an
 * unlisted installed version is treated as unverified by the adapters, never assumed compatible. We invent no version
 * ranges: where a bound is genuinely unknown it is `"unconstrained"`, not a guessed ceiling.
 */

export type ProviderCompatibility =
  /** Exactly these observed releases carry the validated launch posture; anything else is unverified. */
  | Readonly<{ kind: "validatedVersions"; versions: readonly string[] }>
  /** No version constraint is known or claimed. */
  | Readonly<{ kind: "unconstrained" }>;

export interface ProviderTransportProfile {
  readonly transport: string;
  /** Whether this transport implements Fusion's structured review/adjudication/change-proposal turns. */
  readonly structuredTurns: boolean;
  /** The releases whose read-only launch posture Fusion has validated for this transport. */
  readonly compatibility: ProviderCompatibility;
  /**
   * Whether the transport can serve as a read-only Change Author (structured change proposals in a per-session
   * Fusion-owned view). Only such transports need live change-proposal evidence.
   */
  readonly changeAuthor: boolean;
  /**
   * The envelope a change proposal's reply text is read under (O5.5B10, platform/process/structured-envelope.ts):
   * `rawOnly`, or `rawOrSingleJsonFence` — raw JSON, or exactly one outer json/bare Markdown fence with only whitespace
   * outside it and a schema-conforming object body. Implementation data only: it proves nothing about a real provider.
   */
  readonly changeProposalEnvelope: EnvelopePolicy;
  /**
   * O5.5B18: the envelope the Lead's PLAN reply (its ResultPacket) is read under — the same two policies, with the
   * ResultPacket shape as the fence body's schema predicate. Every other packet turn (exploration, delegate, Lead review)
   * and every review turn stays raw-only; adjudication has its own field (O5.5B22). Implementation data only: it proves
   * nothing about a real provider.
   */
  readonly leadPlanEnvelope: EnvelopePolicy;
  /**
   * O5.5B22: the envelope the Lead's ADJUDICATION reply is read under — the same two policies, with the adjudication
   * decoding schema as the fence body's predicate; the core adjudication validator stays authoritative. Review turns stay
   * raw-only. Implementation data only: it proves nothing about a real provider.
   */
  readonly adjudicationEnvelope: EnvelopePolicy;
  /**
   * Authorized live change-proposal probes of this transport, each bound to the exact runtime version, model and effort it
   * ran with. RECORDED evidence (validated evidence file, documented in the milestone doc), never re-observed at runtime;
   * another installed version, model or effort is not covered by it. Records are history: a later probe is appended, an
   * earlier one never rewritten.
   */
  readonly changeProposalLiveEvidence: readonly LiveProbeRecord[];
  /**
   * O5.5B24: releases validated for ONE exact binding only (see `BindingValidation`). They never widen `compatibility`:
   * `isValidatedRuntimeVersion` and every other role, model, effort, step budget, binary or release are unchanged.
   */
  readonly bindingValidations: readonly BindingValidation[];
}
/**
 * O5.5B24: a release validated for ONE exact binding — role, model, effort and the listed options — on ONE exact binary
 * (SHA-256), by an independently reviewed authorized live PASS of exactly that binding. RECORDED evidence, never
 * re-observed at runtime; the adapter still checks the binary's bytes before claiming anything for it.
 */
export interface BindingValidation {
  readonly release: string;
  readonly role: string;
  readonly model: string;
  readonly effort: string;
  /** Behavior-relevant binding options, each compared exactly (the provider, the step budget, the retry policy). */
  readonly options: Readonly<Record<string, string | number>>;
  readonly executable: string;
  readonly executableSha256: string;
  readonly milestone: string;
  readonly evidenceSha256: string;
  readonly document: string;
}
/** One authorized real-provider change-proposal probe (O5.5B9 onward). `PASS` is the only passing outcome. */
export interface LiveProbeRecord {
  readonly milestone: string;
  readonly runtimeVersion: string;
  /** The binding's model as configured (requested) and the effort the turn ran at. */
  readonly model: string;
  readonly effort: string;
  readonly outcome: string;
  readonly probedAt: string;
  readonly document: string;
}

export interface ProviderProfile {
  readonly id: ProviderId;
  readonly displayName: string;
  /** Registered adapter kinds that realize this provider (concrete construction lives in the provider registry). */
  readonly adapterKinds: readonly string[];
  readonly transports: readonly ProviderTransportProfile[];
  /** Credential lanes this provider supports. Fusion only ever runs the subscription lanes; API lanes fail closed. */
  readonly authLanes: readonly AuthLane[];
  /** Basename of the runtime executable, lowercased, for identity checks; `undefined` when the runtime is a directory. */
  readonly executableBasename?: string;
  /** How the provider's own state directory is handled today (see docs/o5-5b4-runtime-hardening.md). */
  readonly stateDirectoryStrategy: "providerManaged";
  /**
   * Top-level repository names this provider may read as its own project state or configuration. They are never copied
   * into a Fusion provider view (a committed settings file cannot steer a session's posture from inside its view).
   */
  readonly workspaceStatePaths: readonly string[];
  /** Factory for the environment rule set the BillingGuard applies to this provider's child processes. */
  readonly environmentRules: () => EnvironmentRuleSet;
}

const CLAUDE_PROFILE: ProviderProfile = Object.freeze({
  id: "claude",
  displayName: "Claude Code (subscription)",
  adapterKinds: Object.freeze(["claude-one-shot"]),
  transports: Object.freeze([Object.freeze({ transport: "claude-one-shot", structuredTurns: true,
    compatibility: Object.freeze({ kind: "validatedVersions", versions: Object.freeze(["2.1.280"]) }), changeAuthor: true,
    // O5.5B10: a single outer json/bare fence is read mechanically.
    changeProposalEnvelope: "rawOrSingleJsonFence",
    // O5.5B18: the same narrow envelope for the Lead's plan; live (O5.5B17) its successful reply was one fenced JSON object.
    leadPlanEnvelope: "rawOrSingleJsonFence",
    // O5.5B22: and for the Lead's adjudication: every observed live structured reply of this transport was one fenced object.
    adjudicationEnvelope: "rawOrSingleJsonFence",
    changeProposalLiveEvidence: Object.freeze([
      // O5.5B9: one real proposal turn (haiku, effort low); the result text began with a Markdown fence and was refused.
      // That record stays a failure: the refused text was never persisted, so no later parser can re-judge it.
      Object.freeze({ milestone: "O5.5B9", runtimeVersion: "2.1.280", model: "haiku", effort: "low", outcome: "MALFORMED_PROPOSAL",
        probedAt: "2026-09-24T13:36:05.870Z", document: "docs/o5-5b9-real-provider-probe.md" }),
      // O5.5B11: one real proposal turn, same binding, after the O5.5B10 envelope: one json fence around a valid ChangeSet,
      // validated, host-applied into a private candidate, verified 3/3 in the accepted confined backend.
      Object.freeze({ milestone: "O5.5B11", runtimeVersion: "2.1.280", model: "haiku", effort: "low", outcome: "PASS",
        probedAt: "2026-09-24T19:13:22.255Z", document: "docs/o5-5b11-claude-live-reprobe.md" }),
    ]), bindingValidations: Object.freeze([]) })]),
  authLanes: Object.freeze<AuthLane[]>(["subscription", "subscriptionToken"]),
  executableBasename: "claude.exe",
  stateDirectoryStrategy: "providerManaged",
  // Project settings (`.claude/settings.json`, `settings.local.json`), agents, commands and skills; and personal memory.
  workspaceStatePaths: Object.freeze([".claude", "CLAUDE.local.md"]),
  environmentRules: () => claudeEnvironmentRules(),
});

const MUSE_PROFILE: ProviderProfile = Object.freeze({
  id: "muse",
  displayName: "Muse Code (account login)",
  adapterKinds: Object.freeze(["muse-exec", "muse-msp"]),
  transports: Object.freeze([
    Object.freeze({ transport: "muse-exec", structuredTurns: true,
      compatibility: Object.freeze({ kind: "validatedVersions", versions: Object.freeze(["1.3.0-R3401.1"]) }), changeAuthor: true,
      changeProposalEnvelope: "rawOnly", leadPlanEnvelope: "rawOnly", adjudicationEnvelope: "rawOnly",
      // O5.5B9: one real proposal turn (effort minimal): validated, host-applied, verified 3/3 in the accepted confined backend.
      changeProposalLiveEvidence: Object.freeze([Object.freeze({ milestone: "O5.5B9", runtimeVersion: "1.3.0-R3401.1", model: "muse-spark-1.3",
        effort: "minimal", outcome: "PASS", probedAt: "2026-09-24T13:37:06.691Z", document: "docs/o5-5b9-real-provider-probe.md" })]),
      // O5.5B24: the installed 1.4.0-R4161.1 — validated ONLY as the fresh Reviewer with exactly this binding on exactly
      // this binary (one authorized live Reviewer-only turn, PASS, independently validated). 1.3.0-R3401.1 stays the only
      // transport-wide validated release (its history unchanged); no other role, model, effort, budget or release is covered.
      bindingValidations: Object.freeze([Object.freeze({ release: "1.4.0-R4161.1", role: "Reviewer", model: "muse-spark-1.3", effort: "low",
        options: Object.freeze({ provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0 }), executable: "muse-bin-1.4.0-R4161.1.exe",
        executableSha256: "b33b493069a2593e97cc63f9a4063feb64269bf7f07a233f5db2db681ad5d950", milestone: "O5.5B24",
        evidenceSha256: "a6ead8a22418996be9571677cf11a406f482b3db324efdc20559b3e88cea5c45", document: "docs/o5-5b24-muse14-reviewer-live.md" })]) }),
    // The MSP host's read-only posture is not tied to a single validated release; we make no version claim.
    Object.freeze({ transport: "muse-msp", structuredTurns: false, compatibility: Object.freeze({ kind: "unconstrained" }),
      changeAuthor: false, changeProposalEnvelope: "rawOnly", leadPlanEnvelope: "rawOnly", adjudicationEnvelope: "rawOnly",
      changeProposalLiveEvidence: Object.freeze([]), bindingValidations: Object.freeze([]) }),
  ]),
  authLanes: Object.freeze<AuthLane[]>(["subscription"]),
  stateDirectoryStrategy: "providerManaged",
  // The provider's state-directory name; excluded conservatively (not verified as a project-level config location).
  workspaceStatePaths: Object.freeze([".muse"]),
  environmentRules: () => museEnvironmentRules(),
});

const PROFILES: ReadonlyMap<ProviderId, ProviderProfile> = new Map([
  [CLAUDE_PROFILE.id, CLAUDE_PROFILE], [MUSE_PROFILE.id, MUSE_PROFILE],
]);

/** The registered provider profiles, in a stable order. */
export function providerProfiles(): readonly ProviderProfile[] {
  return Object.freeze([CLAUDE_PROFILE, MUSE_PROFILE]);
}
/** The profile for a provider id, or `undefined` for an unknown provider (never a fabricated default). */
export function providerProfile(id: ProviderId): ProviderProfile | undefined {
  return PROFILES.get(id);
}
/** The profile that registers a given adapter kind, or `undefined` when no profile claims it. */
export function profileForAdapterKind(adapterKind: string): ProviderProfile | undefined {
  for (const profile of PROFILES.values()) if (profile.adapterKinds.includes(adapterKind)) return profile;
  return undefined;
}
/** The transport profile within a provider, or `undefined`. */
export function transportProfile(id: ProviderId, transport: string): ProviderTransportProfile | undefined {
  return providerProfile(id)?.transports.find(entry => entry.transport === transport);
}
/** Every registered provider's workspace state paths: what no provider view contains. */
export function providerWorkspaceStatePaths(): readonly string[] {
  return Object.freeze([...new Set(providerProfiles().flatMap(profile => profile.workspaceStatePaths))].sort());
}
/**
 * The latest recorded live change-proposal probe of a transport for exactly `version` — and, when `binding` is given,
 * exactly that model and effort — or undefined. A record for another version, model or effort, or for a version no longer
 * validated, covers nothing.
 */
export function changeProposalLiveEvidence(id: ProviderId, transport: string, version: string,
  binding?: Readonly<{ model: string; effort: string }>): LiveProbeRecord | undefined {
  const profile = transportProfile(id, transport);
  if (profile === undefined || !isValidatedRuntimeVersion(id, transport, version)) return undefined;
  return profile.changeProposalLiveEvidence.filter(record => record.runtimeVersion === version &&
    (binding === undefined || (record.model === binding.model && record.effort === binding.effort))).at(-1);
}
/** Every recorded live change-proposal probe of a transport, oldest first (history; earlier records are never rewritten). */
export function changeProposalLiveRecords(id: ProviderId, transport: string): readonly LiveProbeRecord[] {
  return transportProfile(id, transport)?.changeProposalLiveEvidence ?? Object.freeze([]);
}
/**
 * Live change-proposal coverage across every registered Change Author transport: how many have a recorded PASS for a
 * currently validated version, and how many have only recorded failures. Provider-neutral counts; no name leaves.
 */
export function liveChangeProposalCoverage(): Readonly<{ changeAuthors: number; passed: number; failedOnly: number; unprobed: number }> {
  const authors = providerProfiles().flatMap(profile => profile.transports.filter(entry => entry.changeAuthor)
    .map(entry => ({ entry, validated: (version: string) => isValidatedRuntimeVersion(profile.id, entry.transport, version) })));
  const current = authors.map(({ entry, validated }) => entry.changeProposalLiveEvidence.filter(record => validated(record.runtimeVersion)));
  const passed = current.filter(records => records.some(record => record.outcome === "PASS")).length;
  const failedOnly = current.filter(records => records.length > 0 && !records.some(record => record.outcome === "PASS")).length;
  return Object.freeze({ changeAuthors: authors.length, passed, failedOnly, unprobed: authors.length - passed - failedOnly });
}
/**
 * How the registered Change Author transports read a proposal's reply text: how many accept only raw JSON and how many
 * also accept exactly one outer json/bare fence. Provider-neutral counts; implementation data, never live evidence.
 */
export function changeProposalEnvelopeCoverage(): Readonly<{ changeAuthors: number; rawOnly: number; singleFence: number }> {
  const authors = providerProfiles().flatMap(profile => profile.transports.filter(entry => entry.changeAuthor));
  const singleFence = authors.filter(entry => entry.changeProposalEnvelope === "rawOrSingleJsonFence").length;
  return Object.freeze({ changeAuthors: authors.length, rawOnly: authors.length - singleFence, singleFence });
}
/** The binding facts a `BindingValidation` is compared against (a configured binding's role, model, effort and options). */
export type ValidatedBindingFacts = Readonly<{ role: string; model: string; effort: string; options: Readonly<Record<string, unknown>> }>;
/** O5.5B24: every binding-scoped validation of a transport whose binding facts match exactly (any release). */
export function bindingValidationsFor(id: ProviderId, transport: string, binding: ValidatedBindingFacts): readonly BindingValidation[] {
  return (transportProfile(id, transport)?.bindingValidations ?? []).filter(entry => entry.role === binding.role &&
    entry.model === binding.model && entry.effort === binding.effort &&
    Object.entries(entry.options).every(([key, value]) => binding.options[key] === value));
}
/** O5.5B24: the validation covering exactly this binding on exactly this release, or undefined. */
export function bindingValidation(id: ProviderId, transport: string, version: string, binding: ValidatedBindingFacts): BindingValidation | undefined {
  return bindingValidationsFor(id, transport, binding).find(entry => entry.release === version);
}
/**
 * Whether a release is validated for this binding: transport-wide (`isValidatedRuntimeVersion`), or for exactly this
 * binding (O5.5B24). The binary's identity is checked where it runs (the adapter) and where a grant pins it.
 */
export function isValidatedForBinding(id: ProviderId, transport: string, version: string, binding: ValidatedBindingFacts): boolean {
  return isValidatedRuntimeVersion(id, transport, version) || bindingValidation(id, transport, version, binding) !== undefined;
}
/** Whether a specific installed runtime version is one Fusion has validated for a transport. */
export function isValidatedRuntimeVersion(id: ProviderId, transport: string, version: string): boolean {
  const compatibility = transportProfile(id, transport)?.compatibility;
  return compatibility?.kind === "validatedVersions" && compatibility.versions.includes(version);
}

/** What one role's real turns did in a live full-route rehearsal; `NOT_RUN` when none of its turns started. */
export type RouteRoleLiveOutcome = "PASS" | "FAIL" | "NOT_RUN";
/**
 * One authorized live full-route rehearsal (O5.5B13 onward): the production Writer route with real providers for every
 * role on the throw-away fixture, one run per authorization. RECORDED evidence (an independently validated evidence
 * file, documented in the milestone doc), never re-observed at runtime and never derived from provider text. Records
 * are history: a later run is appended, an earlier one never rewritten. `PASS` is the only passing route outcome.
 */
export interface FullRouteLiveRecord {
  readonly milestone: string;
  readonly authorization: string;
  /** The route outcome label of the evidence file (`PASS`, `PROVIDER_FAILED`, …). */
  readonly outcome: string;
  /** The turn the route ended at (`<turn class>#<slot>`) when it did not pass. */
  readonly endedAt?: string;
  readonly modelTurns: number;
  /** Per role: the binding it ran under and what its real turns did. */
  readonly roles: Readonly<Record<"Lead" | "Worker" | "Reviewer", Readonly<{ provider: ProviderId; transport: string; runtimeVersion: string;
    model: string; effort: string; outcome: RouteRoleLiveOutcome }>>>;
  readonly adjudication: RouteRoleLiveOutcome;
  readonly correction: RouteRoleLiveOutcome;
  readonly confinedVerification: RouteRoleLiveOutcome;
  readonly primaryUnchanged: boolean;
  readonly viewsUnchanged: boolean;
  readonly cleanupComplete: boolean;
  /**
   * O5.5B25 onward: per started role turn, whether the MODEL TURN itself succeeded (its terminal diagnostic) and what the
   * CONTRACT made of its reply, with the reply's shape — labels, counts and flags only, never text.
   */
  readonly turnDiagnostics?: readonly Readonly<{ turn: string; modelTurn: "PASS" | "FAIL"; contract: string;
    replyEnvelope: Readonly<{ policy: EnvelopePolicy; classification: StructuredOutputClass; accepted: boolean; extraTextLocation: string;
      bodyMatchesExpectedSchema: boolean | "notChecked" | "n/a" }>;
    terminal: Pick<TurnTerminalDiagnostic, "classification" | "internalTurnCount" | "resultTextByteLength" | "structuredParsingReached" |
      "schemaValidationReached" | "processExitCode"> }>[];
  /** O5.5B27 onward: the engine's own retry transitions (reasons only), e.g. a mechanical retry after a failed verification. */
  readonly retries?: readonly string[];
  /** O5.5B27 onward: each confined verification of a candidate — passed, commands run, and the unit test counts. */
  readonly verificationAttempts?: readonly Readonly<{ attempt: number; passed: boolean; commandsRun: number;
    unitTests: Readonly<{ tests: number; fail: number }> }>[];
  readonly ranAt: string;
  readonly evidenceSha256: string;
  readonly document: string;
}
const FULL_ROUTE_LIVE_RECORDS: readonly FullRouteLiveRecord[] = Object.freeze([
  // O5.5B13: the one authorized run ended at its first turn. The Lead's plan turn started, its init frame was verified
  // (2.1.280, haiku -> claude-haiku-4-5-20251001, no API key, dontAsk, Read/Grep/Glob, subscription token), and the
  // CLI's result frame reported a failed turn (exit 1); which of its failure fields was set was not retained. No
  // Change Author, Reviewer, adjudication, correction or confined verification ran; primary and view unchanged.
  Object.freeze({ milestone: "O5.5B13", authorization: "O5.5B13-LIVE", outcome: "PROVIDER_FAILED", endedAt: "leadPlan#1", modelTurns: 1,
    roles: Object.freeze({
      Lead: Object.freeze({ provider: "claude" as const, transport: "claude-one-shot", runtimeVersion: "2.1.280", model: "haiku", effort: "low",
        outcome: "FAIL" as const }),
      Worker: Object.freeze({ provider: "claude" as const, transport: "claude-one-shot", runtimeVersion: "2.1.280", model: "haiku", effort: "low",
        outcome: "NOT_RUN" as const }),
      Reviewer: Object.freeze({ provider: "muse" as const, transport: "muse-exec", runtimeVersion: "1.3.0-R3401.1", model: "muse-spark-1.3",
        effort: "low", outcome: "NOT_RUN" as const }) }),
    adjudication: "NOT_RUN", correction: "NOT_RUN", confinedVerification: "NOT_RUN",
    primaryUnchanged: true, viewsUnchanged: true, cleanupComplete: true, ranAt: "2026-09-25T00:04:14.748Z",
    evidenceSha256: "e035d457100ddb2a0aaa032a1efc21c88311966509c0deb50fb10027101a6313", document: "docs/o5-5b13-full-route-live-proof.md" }),
  // O5.5B25: the second run ended at the Change Author's first turn. The Lead plan passed again (RESULT_OK, one json fence,
  // contract accepted). The Change Author's MODEL TURN succeeded (RESULT_OK, 4 turns, exit 0) and its one json fence held a
  // body matching the Change Author schema, but non-whitespace text stood BEFORE the fence, so the reply was refused as
  // EXTRA_TEXT before the ChangeSet contract. No Reviewer, adjudication, correction or confined verification ran; primary
  // and views unchanged; cleanup complete. Not a full-route pass.
  Object.freeze({ milestone: "O5.5B25", authorization: "O5.5B25-LIVE", outcome: "MALFORMED_OUTPUT", endedAt: "changeAuthor#1", modelTurns: 2,
    roles: Object.freeze({
      Lead: Object.freeze({ provider: "claude" as const, transport: "claude-one-shot", runtimeVersion: "2.1.280", model: "haiku", effort: "low",
        outcome: "PASS" as const }),
      Worker: Object.freeze({ provider: "claude" as const, transport: "claude-one-shot", runtimeVersion: "2.1.280", model: "haiku", effort: "low",
        outcome: "FAIL" as const }),
      Reviewer: Object.freeze({ provider: "muse" as const, transport: "muse-exec", runtimeVersion: "1.4.0-R4161.1", model: "muse-spark-1.3",
        effort: "low", outcome: "NOT_RUN" as const }) }),
    adjudication: "NOT_RUN", correction: "NOT_RUN", confinedVerification: "NOT_RUN",
    primaryUnchanged: true, viewsUnchanged: true, cleanupComplete: true,
    turnDiagnostics: Object.freeze([
      Object.freeze({ turn: "leadPlan#1", modelTurn: "PASS" as const, contract: "accepted",
        replyEnvelope: Object.freeze({ policy: "rawOrSingleJsonFence" as const, classification: "SINGLE_FENCED_VALID_JSON" as const, accepted: true,
          extraTextLocation: "none", bodyMatchesExpectedSchema: true }),
        terminal: Object.freeze({ classification: "RESULT_OK" as const, internalTurnCount: 6, resultTextByteLength: 1116, structuredParsingReached: true,
          schemaValidationReached: true, processExitCode: 0 }) }),
      Object.freeze({ turn: "changeAuthor#1", modelTurn: "PASS" as const, contract: "refused:EXTRA_TEXT",
        replyEnvelope: Object.freeze({ policy: "rawOrSingleJsonFence" as const, classification: "EXTRA_TEXT" as const, accepted: false,
          extraTextLocation: "beforeFence", bodyMatchesExpectedSchema: true }),
        terminal: Object.freeze({ classification: "RESULT_OK" as const, internalTurnCount: 4, resultTextByteLength: 3069, structuredParsingReached: true,
          schemaValidationReached: false, processExitCode: 0 }) }),
    ]),
    ranAt: "2026-09-25T18:47:00.381Z", evidenceSha256: "89ff988d53a353e7370c2da91c1cb834308f6fb8f0baf3bb77ba2d1bc0605b44",
    document: "docs/o5-5b25-full-route-live-rehearsal.md" }),
  // O5.5B27: the first full-route PASS. Lead plan accepted; Change Author #1's ChangeSet was validated and host-applied into
  // a private candidate but failed confined verification (unit: 1 of 11 tests failed), so the engine moved to
  // retrying:verificationFailed with a fresh candidate; Change Author #2's ChangeSet was validated, host-applied and passed
  // confined verification (12 of 12); the fresh Reviewer (Muse 1.4) reported 0 findings, so no adjudication and no
  // correction ran. Primary, views and the Reviewer binary unchanged; cleanup complete. One sample on one fixture.
  Object.freeze({ milestone: "O5.5B27", authorization: "O5.5B27-LIVE", outcome: "PASS", modelTurns: 4,
    roles: Object.freeze({
      Lead: Object.freeze({ provider: "claude" as const, transport: "claude-one-shot", runtimeVersion: "2.1.280", model: "haiku", effort: "low",
        outcome: "PASS" as const }),
      Worker: Object.freeze({ provider: "claude" as const, transport: "claude-one-shot", runtimeVersion: "2.1.280", model: "haiku", effort: "low",
        outcome: "PASS" as const }),
      Reviewer: Object.freeze({ provider: "muse" as const, transport: "muse-exec", runtimeVersion: "1.4.0-R4161.1", model: "muse-spark-1.3",
        effort: "low", outcome: "PASS" as const }) }),
    adjudication: "NOT_RUN", correction: "NOT_RUN", confinedVerification: "PASS",
    primaryUnchanged: true, viewsUnchanged: true, cleanupComplete: true,
    turnDiagnostics: Object.freeze([
      Object.freeze({ turn: "leadPlan#1", modelTurn: "PASS" as const, contract: "accepted",
        replyEnvelope: Object.freeze({ policy: "rawOrSingleJsonFence" as const, classification: "SINGLE_FENCED_VALID_JSON" as const, accepted: true,
          extraTextLocation: "none", bodyMatchesExpectedSchema: true }),
        terminal: Object.freeze({ classification: "RESULT_OK" as const, internalTurnCount: 6, resultTextByteLength: 825, structuredParsingReached: true,
          schemaValidationReached: true, processExitCode: 0 }) }),
      Object.freeze({ turn: "changeAuthor#1", modelTurn: "PASS" as const, contract: "validated",
        replyEnvelope: Object.freeze({ policy: "rawOrSingleJsonFence" as const, classification: "SINGLE_FENCED_VALID_JSON" as const, accepted: true,
          extraTextLocation: "none", bodyMatchesExpectedSchema: true }),
        terminal: Object.freeze({ classification: "RESULT_OK" as const, internalTurnCount: 3, resultTextByteLength: 2765, structuredParsingReached: true,
          schemaValidationReached: true, processExitCode: 0 }) }),
      Object.freeze({ turn: "changeAuthor#2", modelTurn: "PASS" as const, contract: "validated",
        replyEnvelope: Object.freeze({ policy: "rawOrSingleJsonFence" as const, classification: "SINGLE_FENCED_VALID_JSON" as const, accepted: true,
          extraTextLocation: "none", bodyMatchesExpectedSchema: true }),
        terminal: Object.freeze({ classification: "RESULT_OK" as const, internalTurnCount: 3, resultTextByteLength: 2889, structuredParsingReached: true,
          schemaValidationReached: true, processExitCode: 0 }) }),
      Object.freeze({ turn: "freshReview#1", modelTurn: "PASS" as const, contract: "accepted:0 finding(s)",
        replyEnvelope: Object.freeze({ policy: "rawOnly" as const, classification: "RAW_VALID_JSON" as const, accepted: true,
          extraTextLocation: "none", bodyMatchesExpectedSchema: true }),
        terminal: Object.freeze({ classification: "RESULT_OK" as const, internalTurnCount: null, resultTextByteLength: 214, structuredParsingReached: true,
          schemaValidationReached: true, processExitCode: 0 }) }),
    ]),
    retries: Object.freeze(["verificationFailed"]),
    verificationAttempts: Object.freeze([
      Object.freeze({ attempt: 1, passed: false, commandsRun: 2, unitTests: Object.freeze({ tests: 11, fail: 1 }) }),
      Object.freeze({ attempt: 2, passed: true, commandsRun: 2, unitTests: Object.freeze({ tests: 12, fail: 0 }) }),
    ]),
    ranAt: "2026-09-25T20:25:59.591Z", evidenceSha256: "4b93df3b315b7ede9fdc6147443bcaf27913efda20586fc9048c33b91010f242",
    document: "docs/o5-5b27-full-route-live-pass.md" }),
]);
/** Every recorded live full-route rehearsal, oldest first (history). */
export function fullRouteLiveRecords(): readonly FullRouteLiveRecord[] {
  return FULL_ROUTE_LIVE_RECORDS;
}
/**
 * Live full-route coverage, provider-neutral: how many authorized runs were recorded, how many passed, and where the
 * latest one ended. No provider name, model or reply leaves.
 */
export function fullRouteLiveCoverage(): Readonly<{ attempts: number; passed: number;
  latest?: Readonly<{ milestone: string; outcome: string; endedAt?: string; modelTurns: number; rolesRun: number }> }> {
  const latest = FULL_ROUTE_LIVE_RECORDS.at(-1);
  return Object.freeze({ attempts: FULL_ROUTE_LIVE_RECORDS.length, passed: FULL_ROUTE_LIVE_RECORDS.filter(record => record.outcome === "PASS").length,
    ...(latest === undefined ? {} : { latest: Object.freeze({ milestone: latest.milestone, outcome: latest.outcome,
      ...(latest.endedAt === undefined ? {} : { endedAt: latest.endedAt }), modelTurns: latest.modelTurns,
      rolesRun: Object.values(latest.roles).filter(role => role.outcome !== "NOT_RUN").length }) }) });
}

/**
 * One authorized live Lead-plan probe (O5.5B15 onward): exactly one real Lead plan turn through the route harness, every
 * other turn class at budget 0 — a diagnosis of the Lead role, never a full-route attempt (`fullRouteLiveRecords`).
 * RECORDED evidence (independently validated evidence file, milestone doc); history, never re-judged. `terminal` holds
 * the bounded terminal diagnostic of that turn exactly as recorded (labels, counts, flags — no text).
 */
export interface LeadPlanLiveRecord {
  readonly milestone: string;
  readonly authorization: string;
  readonly provider: ProviderId;
  readonly transport: string;
  readonly runtimeVersion: string;
  readonly model: string;
  readonly effort: string;
  readonly maxTurns: number;
  /** `PASS` only when the plan turn completed and its packet was accepted (the Lead CONTRACT). */
  readonly outcome: "PASS" | "FAIL";
  /** O5.5B17: whether the provider's model turn itself succeeded (its terminal diagnostic RESULT_OK), contract aside. */
  readonly modelTurn: "PASS" | "FAIL";
  /** Which Lead plan instruction the turn received: the generic delegated-task wording, or the O5.5B16 planning contract. */
  readonly leadPrompt: "genericDelegation" | "planningLead";
  readonly routeOutcome: string;
  /** Where Fusion refused a successful model turn's reply, if it did (labels only). */
  readonly contractRefusal?: Readonly<{ stage: "envelope"; policy: EnvelopePolicy; classification: StructuredOutputClass }>;
  /** O5.5B21: how an accepted reply's envelope was read (labels only). */
  readonly replyEnvelope?: Readonly<{ policy: EnvelopePolicy; classification: StructuredOutputClass; accepted: boolean }>;
  readonly terminal: Readonly<Pick<TurnTerminalDiagnostic, "classification" | "resultSubtype" | "terminalReason" | "isError" | "internalTurnCount" |
    "permissionDenialCount" | "errorEntryCount" | "resultTextPresent" | "structuredParsingReached" | "schemaValidationReached" | "processExitCode">>;
  readonly ranAt: string;
  readonly evidenceSha256: string;
  readonly document: string;
}
const LEAD_PLAN_LIVE_RECORDS: readonly LeadPlanLiveRecord[] = Object.freeze([
  // O5.5B15: the real Lead plan turn (Claude Code 2.1.280, haiku/low, --max-turns 6) ended at the CLI's turn limit:
  // error_max_turns / max_turns, 7 turns counted against the limit of 6, no reply text, exit 1; never parsed.
  Object.freeze({ milestone: "O5.5B15", authorization: "O5.5B15-LEAD", provider: "claude" as const, transport: "claude-one-shot",
    runtimeVersion: "2.1.280", model: "haiku", effort: "low", maxTurns: 6, outcome: "FAIL" as const, modelTurn: "FAIL" as const,
    leadPrompt: "genericDelegation" as const, routeOutcome: "PROVIDER_FAILED",
    terminal: Object.freeze({ classification: "RESULT_ERROR_MAX_TURNS" as const, resultSubtype: "error_max_turns", terminalReason: "max_turns",
      isError: true, internalTurnCount: 7, permissionDenialCount: 0, errorEntryCount: 1, resultTextPresent: false, structuredParsingReached: false,
      schemaValidationReached: false, processExitCode: 1 }),
    ranAt: "2026-09-25T09:32:23.643Z", evidenceSha256: "301e78180f29a78b6a584a02b141b89f185c199bea8a29a59f920e74ed9273ea",
    document: "docs/o5-5b15-lead-live-probe.md" }),
  // O5.5B17: the same binding and limit under the O5.5B16 planning prompt. The model turn succeeded (RESULT_OK, 6 turns,
  // exit 0) and replied with exactly one fenced JSON object; the Lead's packet envelope was raw-only, so Fusion refused
  // the reply before its ResultPacket check ran. `schemaValidationReached` is recorded as observed under its O5.5B14
  // definition ("the reply body parsed as JSON"), which O5.5B18 narrowed; no ResultPacket check ran in this turn.
  Object.freeze({ milestone: "O5.5B17", authorization: "O5.5B17-LEAD", provider: "claude" as const, transport: "claude-one-shot",
    runtimeVersion: "2.1.280", model: "haiku", effort: "low", maxTurns: 6, outcome: "FAIL" as const, modelTurn: "PASS" as const,
    leadPrompt: "planningLead" as const, routeOutcome: "MALFORMED_OUTPUT",
    contractRefusal: Object.freeze({ stage: "envelope" as const, policy: "rawOnly" as const, classification: "SINGLE_FENCED_VALID_JSON" as const }),
    terminal: Object.freeze({ classification: "RESULT_OK" as const, resultSubtype: "success", terminalReason: "completed", isError: false,
      internalTurnCount: 6, permissionDenialCount: 0, errorEntryCount: null, resultTextPresent: true, structuredParsingReached: true,
      schemaValidationReached: true, processExitCode: 0 }),
    ranAt: "2026-09-25T10:50:40.323Z", evidenceSha256: "86ad482dcfacfb0eec56eab82cecbccfe82a1be1254357bb5943ec7ef18b9c85",
    document: "docs/o5-5b17-lead-live-retest.md" }),
  // O5.5B21: the same binding and limit under the O5.5B16 planning prompt AND the O5.5B18 single-fence Lead envelope: the
  // model turn succeeded (RESULT_OK, 6 turns, exit 0), its one fenced JSON reply was accepted and passed the ResultPacket
  // check, and the Lead-only budget then refused the Worker's session (TURN_REFUSED, as designed). The first live Lead
  // contract PASS — for exactly this binding, prompt and envelope; no later role ran.
  Object.freeze({ milestone: "O5.5B21", authorization: "O5.5B21-LEAD", provider: "claude" as const, transport: "claude-one-shot",
    runtimeVersion: "2.1.280", model: "haiku", effort: "low", maxTurns: 6, outcome: "PASS" as const, modelTurn: "PASS" as const,
    leadPrompt: "planningLead" as const, routeOutcome: "TURN_REFUSED",
    replyEnvelope: Object.freeze({ policy: "rawOrSingleJsonFence" as const, classification: "SINGLE_FENCED_VALID_JSON" as const, accepted: true }),
    terminal: Object.freeze({ classification: "RESULT_OK" as const, resultSubtype: "success", terminalReason: "completed", isError: false,
      internalTurnCount: 6, permissionDenialCount: 0, errorEntryCount: null, resultTextPresent: true, structuredParsingReached: true,
      schemaValidationReached: true, processExitCode: 0 }),
    ranAt: "2026-09-25T13:29:44.657Z", evidenceSha256: "c37ae087438580830f782ea47173e6922d03191c957fe2f75605307174a2054c",
    document: "docs/o5-5b21-lead-contract-live-retest.md" }),
]);
/** Every recorded live Lead-plan probe, oldest first (history). */
export function leadPlanLiveRecords(): readonly LeadPlanLiveRecord[] {
  return LEAD_PLAN_LIVE_RECORDS;
}

/**
 * An authorized live attempt that stopped in PREFLIGHT (O5.5B19 onward): no claim was written and no provider model turn
 * ran, so it is neither a Lead nor a route result — only the recorded reason it could not start. History; never re-judged.
 */
export interface RoutePreflightBlockRecord {
  readonly milestone: string;
  readonly authorization: string;
  /** The route outcome label of the preflight evidence (VERSION_BLOCKED, AUTH_BLOCKED, …). */
  readonly outcome: string;
  readonly blockedRole: "Lead" | "Worker" | "Reviewer";
  readonly blockedProvider: ProviderId;
  readonly transport: string;
  readonly installedVersion: string;
  readonly validatedVersions: readonly string[];
  /** The blocked role's authorized model turns: 0 means the role could never have started in that run. */
  readonly blockedRoleBudget: number;
  readonly modelTurns: 0;
  readonly claimWritten: false;
  readonly ranAt: string;
  readonly evidenceSha256: string;
  readonly document: string;
}
const ROUTE_PREFLIGHT_BLOCKS: readonly RoutePreflightBlockRecord[] = Object.freeze([
  // O5.5B19: the Lead-only contract retest stopped in preflight on the INACTIVE Reviewer (budget 0): the installed Muse had
  // moved to 1.4.0-R4161.1, which is not validated. The Lead was never started; O5.5B20 made preflight check only the
  // roles an authorization lets start.
  Object.freeze({ milestone: "O5.5B19", authorization: "O5.5B19-LEAD", outcome: "VERSION_BLOCKED", blockedRole: "Reviewer" as const,
    blockedProvider: "muse" as const, transport: "muse-exec", installedVersion: "1.4.0-R4161.1", validatedVersions: Object.freeze(["1.3.0-R3401.1"]),
    blockedRoleBudget: 0, modelTurns: 0 as const, claimWritten: false as const, ranAt: "2026-09-25T12:38:18.712Z",
    evidenceSha256: "65377221e5d8742208346b209be606449e72fe5a0ae0c8ed70b88d2c1c9968dc", document: "docs/o5-5b19-lead-contract-live-retest.md" }),
]);
/** Every recorded preflight-blocked live attempt, oldest first (history). */
export function routePreflightBlocks(): readonly RoutePreflightBlockRecord[] {
  return ROUTE_PREFLIGHT_BLOCKS;
}

/**
 * One authorized live Reviewer-only probe (O5.5B24 onward): exactly one fresh-review turn of one Reviewer binding on one
 * release, with no Lead, Change Author or adjudication. It is not a full-route attempt. `PASS` requires the production
 * review contract to have accepted the reply, with integrity and cleanup complete. History; never re-judged.
 */
export interface ReviewerLiveRecord {
  readonly milestone: string;
  readonly authorization: string;
  readonly provider: ProviderId;
  readonly transport: string;
  readonly runtimeVersion: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly model: string;
  readonly effort: string;
  readonly maxModelSteps: number;
  readonly malformedOutputRetries: number;
  readonly outcome: "PASS" | "FAIL";
  readonly modelTurns: number;
  /** The production review contract's verdict label and the finding count (never a finding's text). */
  readonly contract: string;
  readonly findings: number;
  readonly replyEnvelope: Readonly<{ policy: EnvelopePolicy; classification: StructuredOutputClass; accepted: boolean }>;
  readonly terminal: Pick<TurnTerminalDiagnostic, "classification" | "resultSubtype" | "terminalReason" | "isError" | "resultTextByteLength" |
    "structuredParsingReached" | "schemaValidationReached" | "processExitCode">;
  /** The pre-claim runtime readback: the attested lane and the running host's own version report. */
  readonly readback: Readonly<{ lane: string; reportedRuntimeVersion: string }>;
  /** Fusion's confined verification of the Fusion-authored candidate the Reviewer saw. */
  readonly candidateVerification: Readonly<{ passed: boolean; commandsRun: number; acceptance: string }>;
  readonly ranAt: string;
  readonly evidenceSha256: string;
  readonly document: string;
}
const REVIEWER_LIVE_RECORDS: readonly ReviewerLiveRecord[] = Object.freeze([
  // O5.5B24: the installed Muse Exec 1.4.0-R4161.1 as the fresh Reviewer (muse-spark-1.3, low, 4 steps, no retry): one
  // turn, RAW_VALID_JSON under raw-only, contract accepted (0 findings), integrity and cleanup complete; 74 checks passed.
  Object.freeze({ milestone: "O5.5B24", authorization: "O5.5B24-REVIEWER", provider: "muse" as const, transport: "muse-exec",
    runtimeVersion: "1.4.0-R4161.1", executable: "muse-bin-1.4.0-R4161.1.exe",
    executableSha256: "b33b493069a2593e97cc63f9a4063feb64269bf7f07a233f5db2db681ad5d950", model: "muse-spark-1.3", effort: "low",
    maxModelSteps: 4, malformedOutputRetries: 0, outcome: "PASS" as const, modelTurns: 1, contract: "accepted", findings: 0,
    replyEnvelope: Object.freeze({ policy: "rawOnly" as const, classification: "RAW_VALID_JSON" as const, accepted: true }),
    terminal: Object.freeze({ classification: "RESULT_OK" as const, resultSubtype: "completed", terminalReason: "completed", isError: false,
      resultTextByteLength: 247, structuredParsingReached: true, schemaValidationReached: true, processExitCode: 0 }),
    readback: Object.freeze({ lane: "subscription", reportedRuntimeVersion: "1.4.0" }),
    candidateVerification: Object.freeze({ passed: true, commandsRun: 2, acceptance: "granted" }),
    ranAt: "2026-09-25T15:41:37.801Z", evidenceSha256: "a6ead8a22418996be9571677cf11a406f482b3db324efdc20559b3e88cea5c45",
    document: "docs/o5-5b24-muse14-reviewer-live.md" }),
]);
/** Every recorded live Reviewer-only probe, oldest first (history). */
export function reviewerLiveRecords(): readonly ReviewerLiveRecord[] {
  return REVIEWER_LIVE_RECORDS;
}

/**
 * O5.5B29: an authorized live Lead-ADJUDICATION probe (`app/adjudication-probe.ts`): exactly one real Lead adjudication turn
 * over the Fusion-authored finding set, outside any route. Recorded only from an independently validated evidence file.
 * Labels and counts only: the per-finding verdict and required action (enum labels), never a rationale or summary.
 */
export interface AdjudicationLiveRecord {
  readonly milestone: string;
  readonly authorization: string;
  readonly provider: ProviderId;
  readonly transport: string;
  readonly runtimeVersion: string;
  readonly model: string;
  readonly canonicalModel: string;
  readonly effort: string;
  readonly maxTurns: number;
  readonly outcome: "PASS" | "FAIL";
  readonly modelTurns: number;
  /** The production adjudication contract's label, and each verdict as enum labels on Fusion's finding ids. */
  readonly contract: string;
  readonly verdicts: readonly Readonly<{ findingId: string; severity: string; verdict: string; requiredAction: string; verdictSource: string }>[];
  /** The deterministic review policy's decision (cycle 1, a corrective attempt available) and the findings it sends back. */
  readonly decision: Readonly<{ kind: string; findings: readonly string[] }>;
  readonly replyEnvelope: Readonly<{ policy: EnvelopePolicy; classification: StructuredOutputClass; accepted: boolean }>;
  readonly terminal: Pick<TurnTerminalDiagnostic, "classification" | "resultSubtype" | "terminalReason" | "isError" | "internalTurnCount" |
    "resultTextByteLength" | "structuredParsingReached" | "schemaValidationReached" | "processExitCode">;
  /** Fusion's confined verification of the Fusion-authored candidate the findings are about. */
  readonly candidateVerification: Readonly<{ passed: boolean; commandsRun: number; acceptance: string }>;
  /** The digest of the provider-neutral contract prompt (recomputed offline in the validation), the finding set's identity. */
  readonly contractPromptSha256: string;
  readonly findingsSha256: string;
  readonly ranAt: string;
  readonly evidenceSha256: string;
  readonly document: string;
}
const ADJUDICATION_LIVE_RECORDS: readonly AdjudicationLiveRecord[] = Object.freeze([
  // O5.5B29: Claude Code 2.1.280 haiku/low (`--max-turns 6`) as the route Lead, one adjudication of the three Fusion-authored
  // findings: RESULT_OK in one internal turn, one json fence accepted under rawOrSingleJsonFence, contract accepted (3
  // verdicts), decision correction (r1-F1 only: r1-F2 is LOW, r1-F3 REJECTED); integrity and cleanup complete; 43 checks.
  Object.freeze({ milestone: "O5.5B29", authorization: "O5.5B29-ADJUDICATION", provider: "claude" as const, transport: "claude-one-shot",
    runtimeVersion: "2.1.280", model: "haiku", canonicalModel: "claude-haiku-4-5-20251001", effort: "low", maxTurns: 6, outcome: "PASS" as const,
    modelTurns: 1, contract: "accepted:3 verdict(s)",
    verdicts: Object.freeze([
      Object.freeze({ findingId: "r1-F1", severity: "MEDIUM", verdict: "CONFIRMED", requiredAction: "fix", verdictSource: "lead" }),
      Object.freeze({ findingId: "r1-F2", severity: "LOW", verdict: "CONFIRMED", requiredAction: "fix", verdictSource: "lead" }),
      Object.freeze({ findingId: "r1-F3", severity: "HIGH", verdict: "REJECTED", requiredAction: "none", verdictSource: "lead" })]),
    decision: Object.freeze({ kind: "correction", findings: Object.freeze(["r1-F1"]) }),
    replyEnvelope: Object.freeze({ policy: "rawOrSingleJsonFence" as const, classification: "SINGLE_FENCED_VALID_JSON" as const, accepted: true }),
    terminal: Object.freeze({ classification: "RESULT_OK" as const, resultSubtype: "success", terminalReason: "completed", isError: false,
      internalTurnCount: 1, resultTextByteLength: 1279, structuredParsingReached: true, schemaValidationReached: true, processExitCode: 0 }),
    candidateVerification: Object.freeze({ passed: true, commandsRun: 2, acceptance: "granted" }),
    contractPromptSha256: "07446ac799b55ff3266696abea22fac5de5451f42bd30fa313121035d0eae031",
    findingsSha256: "905bd34b72eda2c6a371ab249eeafd44dd7b7109c50144141d1027978062eec0",
    ranAt: "2026-09-25T21:52:13.843Z", evidenceSha256: "aa1a22d948bbadeb9278bc15de8cb5d801640b6b90bef9f94b21698d708fdc11",
    document: "docs/o5-5b29-adjudication-live.md" }),
]);
/** Every recorded live Lead-adjudication probe, oldest first (history). */
export function adjudicationLiveRecords(): readonly AdjudicationLiveRecord[] {
  return ADJUDICATION_LIVE_RECORDS;
}

/**
 * O5.5B31: an authorized live REVIEW-CORRECTION probe (`app/correction-probe.ts`): the review-driven correction branch
 * entered at the post-adjudication boundary — one real corrective Change Author turn, Fusion's host application and
 * confined verification, one real fresh re-review. Recorded only from an independently validated evidence file; labels,
 * counts and digests only (never a ChangeSet's content, a diff or a finding's text).
 * `correction`: the corrective turn succeeded, its reply passed the envelope and the ChangeSet contract, and Fusion applied
 * and verified it. `rereview`: the re-review ran only after that verification and the production review contract accepted
 * it. `completeBranch`: PASS only when the re-review was clean; PARTIAL when its findings need the cycle-2 adjudication.
 */
export interface CorrectionLiveRecord {
  readonly milestone: string;
  readonly authorization: string;
  readonly outcome: string;
  readonly modelTurns: number;
  readonly correction: "PASS" | "FAIL";
  readonly rereview: "PASS" | "FAIL" | "NOT_RUN";
  readonly completeBranch: "PASS" | "PARTIAL" | "FAIL";
  /** The Fusion-owned boundary: the cycle-1 decision the branch entered after, and the findings told to the re-review. */
  readonly boundary: Readonly<{ decision: string; corrections: readonly string[]; priorFindings: readonly string[] }>;
  readonly author: Readonly<{ provider: ProviderId; transport: string; runtimeVersion: string; model: string; canonicalModel: string; effort: string;
    maxTurns: number; replyEnvelope: Readonly<{ policy: EnvelopePolicy; classification: StructuredOutputClass; accepted: boolean }>;
    terminal: Pick<TurnTerminalDiagnostic, "classification" | "internalTurnCount" | "resultTextByteLength" | "processExitCode">;
    changeSet: Readonly<{ outcome: string; operations: number; paths: readonly string[] }> }>;
  /** Fusion's host application into the fresh private candidate: each path's content digest after application. */
  readonly application: readonly Readonly<{ path: string; afterSha256: string; bytes: number }>[];
  readonly verification: Readonly<{ passed: boolean; commandsRun: number; acceptance: string }>;
  readonly reviewer: Readonly<{ provider: ProviderId; transport: string; runtimeVersion: string; executableSha256: string; model: string; effort: string;
    maxModelSteps: number; malformedOutputRetries: number; cycle: number; contract: string;
    findings: Readonly<{ count: number; bySeverity: Readonly<Record<string, number>>; byConfidence: Readonly<Record<string, number>> }>;
    replyEnvelope: Readonly<{ policy: EnvelopePolicy; classification: StructuredOutputClass; accepted: boolean }>;
    /** The bounded policy's next step: `adjudicationRequired` (cycle 2) for findings, `clean` otherwise. */
    next: string }>;
  readonly ranAt: string;
  readonly evidenceSha256: string;
  readonly document: string;
}
const CORRECTION_LIVE_RECORDS: readonly CorrectionLiveRecord[] = Object.freeze([
  // O5.5B31: Claude Code 2.1.280 haiku/low (`--max-turns 6`) corrected r1-F1: RESULT_OK in 4 internal turns, one json fence
  // accepted, ChangeSet validated (2 operations), host-applied and verified (docker-linux, osSandbox); then the validated
  // Muse 1.4 Reviewer re-reviewed cycle 2: RAW_VALID_JSON, contract accepted with 1 finding (MEDIUM, HIGH confidence),
  // whose cycle-2 adjudication the probe never runs (REREVIEW_FINDINGS). Integrity and cleanup complete; 49 checks passed.
  Object.freeze({ milestone: "O5.5B31", authorization: "O5.5B31-CORRECTION", outcome: "REREVIEW_FINDINGS", modelTurns: 2,
    correction: "PASS" as const, rereview: "PASS" as const, completeBranch: "PARTIAL" as const,
    boundary: Object.freeze({ decision: "correction", corrections: Object.freeze(["r1-F1"]), priorFindings: Object.freeze(["r1-F1"]) }),
    author: Object.freeze({ provider: "claude" as const, transport: "claude-one-shot", runtimeVersion: "2.1.280", model: "haiku",
      canonicalModel: "claude-haiku-4-5-20251001", effort: "low", maxTurns: 6,
      replyEnvelope: Object.freeze({ policy: "rawOrSingleJsonFence" as const, classification: "SINGLE_FENCED_VALID_JSON" as const, accepted: true }),
      terminal: Object.freeze({ classification: "RESULT_OK" as const, internalTurnCount: 4, resultTextByteLength: 2554, processExitCode: 0 }),
      changeSet: Object.freeze({ outcome: "validated", operations: 2, paths: Object.freeze(["src/quote.ts", "test/quote.test.ts"]) }) }),
    application: Object.freeze([
      Object.freeze({ path: "src/quote.ts", afterSha256: "591668f78f11eb78f36859bea3e33451ed0986df24c1f6ded447487ef3e0900b", bytes: 1014 }),
      Object.freeze({ path: "test/quote.test.ts", afterSha256: "2e0181c997309dfebe3c194bc9c07d44eabb1ec60d8f4e96fece5bbb55571b97", bytes: 1039 })]),
    verification: Object.freeze({ passed: true, commandsRun: 2, acceptance: "granted" }),
    reviewer: Object.freeze({ provider: "muse" as const, transport: "muse-exec", runtimeVersion: "1.4.0-R4161.1",
      executableSha256: "b33b493069a2593e97cc63f9a4063feb64269bf7f07a233f5db2db681ad5d950", model: "muse-spark-1.3", effort: "low", maxModelSteps: 4,
      malformedOutputRetries: 0, cycle: 2, contract: "accepted:1 finding(s)",
      findings: Object.freeze({ count: 1, bySeverity: Object.freeze({ MEDIUM: 1 }), byConfidence: Object.freeze({ HIGH: 1 }) }),
      replyEnvelope: Object.freeze({ policy: "rawOnly" as const, classification: "RAW_VALID_JSON" as const, accepted: true }), next: "adjudicationRequired" }),
    ranAt: "2026-09-25T22:51:06.626Z", evidenceSha256: "73edc215966f2c086c32063dfb4fe62baf217dc3cc105d03e9b2d5a92cc547d9",
    document: "docs/o5-5b31-review-correction-live.md" }),
]);
/** Every recorded live review-correction probe, oldest first (history). */
export function correctionLiveRecords(): readonly CorrectionLiveRecord[] {
  return CORRECTION_LIVE_RECORDS;
}
