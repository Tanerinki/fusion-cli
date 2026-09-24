import type { AuthLane, ProviderId } from "../core/domain.js";
import type { EnvironmentRuleSet } from "../core/policy/billing-guard.js";
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
  /** Factory for the environment rule set the BillingGuard applies to this provider's child processes. */
  readonly environmentRules: () => EnvironmentRuleSet;
}

const CLAUDE_PROFILE: ProviderProfile = Object.freeze({
  id: "claude",
  displayName: "Claude Code (subscription)",
  adapterKinds: Object.freeze(["claude-one-shot"]),
  transports: Object.freeze([Object.freeze({ transport: "claude-one-shot", structuredTurns: true,
    compatibility: Object.freeze({ kind: "validatedVersions", versions: Object.freeze(["2.1.280"]) }) })]),
  authLanes: Object.freeze<AuthLane[]>(["subscription", "subscriptionToken"]),
  executableBasename: "claude.exe",
  stateDirectoryStrategy: "providerManaged",
  environmentRules: () => claudeEnvironmentRules(),
});

const MUSE_PROFILE: ProviderProfile = Object.freeze({
  id: "muse",
  displayName: "Muse Code (account login)",
  adapterKinds: Object.freeze(["muse-exec", "muse-msp"]),
  transports: Object.freeze([
    Object.freeze({ transport: "muse-exec", structuredTurns: true,
      compatibility: Object.freeze({ kind: "validatedVersions", versions: Object.freeze(["1.3.0-R3401.1"]) }) }),
    // The MSP host's read-only posture is not tied to a single validated release; we make no version claim.
    Object.freeze({ transport: "muse-msp", structuredTurns: false, compatibility: Object.freeze({ kind: "unconstrained" }) }),
  ]),
  authLanes: Object.freeze<AuthLane[]>(["subscription"]),
  stateDirectoryStrategy: "providerManaged",
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
/** Whether a specific installed runtime version is one Fusion has validated for a transport. */
export function isValidatedRuntimeVersion(id: ProviderId, transport: string, version: string): boolean {
  const compatibility = transportProfile(id, transport)?.compatibility;
  return compatibility?.kind === "validatedVersions" && compatibility.versions.includes(version);
}
