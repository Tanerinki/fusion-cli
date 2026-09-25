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
   * and every review/adjudication turn stays raw-only. Implementation data only: it proves nothing about a real provider.
   */
  readonly leadPlanEnvelope: EnvelopePolicy;
  /**
   * Authorized live change-proposal probes of this transport, each bound to the exact runtime version, model and effort it
   * ran with. RECORDED evidence (validated evidence file, documented in the milestone doc), never re-observed at runtime;
   * another installed version, model or effort is not covered by it. Records are history: a later probe is appended, an
   * earlier one never rewritten.
   */
  readonly changeProposalLiveEvidence: readonly LiveProbeRecord[];
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
    changeProposalLiveEvidence: Object.freeze([
      // O5.5B9: one real proposal turn (haiku, effort low); the result text began with a Markdown fence and was refused.
      // That record stays a failure: the refused text was never persisted, so no later parser can re-judge it.
      Object.freeze({ milestone: "O5.5B9", runtimeVersion: "2.1.280", model: "haiku", effort: "low", outcome: "MALFORMED_PROPOSAL",
        probedAt: "2026-09-24T13:36:05.870Z", document: "docs/o5-5b9-real-provider-probe.md" }),
      // O5.5B11: one real proposal turn, same binding, after the O5.5B10 envelope: one json fence around a valid ChangeSet,
      // validated, host-applied into a private candidate, verified 3/3 in the accepted confined backend.
      Object.freeze({ milestone: "O5.5B11", runtimeVersion: "2.1.280", model: "haiku", effort: "low", outcome: "PASS",
        probedAt: "2026-09-24T19:13:22.255Z", document: "docs/o5-5b11-claude-live-reprobe.md" }),
    ]) })]),
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
      changeProposalEnvelope: "rawOnly", leadPlanEnvelope: "rawOnly",
      // O5.5B9: one real proposal turn (effort minimal): validated, host-applied, verified 3/3 in the accepted confined backend.
      changeProposalLiveEvidence: Object.freeze([Object.freeze({ milestone: "O5.5B9", runtimeVersion: "1.3.0-R3401.1", model: "muse-spark-1.3",
        effort: "minimal", outcome: "PASS", probedAt: "2026-09-24T13:37:06.691Z", document: "docs/o5-5b9-real-provider-probe.md" })]) }),
    // The MSP host's read-only posture is not tied to a single validated release; we make no version claim.
    Object.freeze({ transport: "muse-msp", structuredTurns: false, compatibility: Object.freeze({ kind: "unconstrained" }),
      changeAuthor: false, changeProposalEnvelope: "rawOnly", leadPlanEnvelope: "rawOnly", changeProposalLiveEvidence: Object.freeze([]) }),
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
