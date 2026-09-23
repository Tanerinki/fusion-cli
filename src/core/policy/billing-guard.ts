import type { AuthLane, AuthStatus, CapabilityRequirement, CapabilitySnapshot, FusionError, ProviderId, WorkspacePosture } from "../domain.js";
import { meetsCapabilities } from "../capabilities.js";

export type EnvironmentAction = "ALLOW" | "STRIP" | "BLOCK";
export interface EnvironmentClassification {
  readonly action: EnvironmentAction;
  readonly reason: string;
  readonly remediation: string;
}
export interface EnvironmentDecision extends EnvironmentClassification {
  /** Uppercase key only. Environment values are never diagnostic fields. */
  readonly key: string;
}

export interface EnvironmentRuleSet {
  readonly provider: ProviderId;
  classify(uppercaseKey: string): EnvironmentClassification | undefined;
  /** Explicitly opted-in token variables, if any. Never inferred from a token value. */
  readonly subscriptionTokenKeys?: readonly string[];
}

/** Provider adapters can report unsafe settings/auth-store state without exposing values. */
export interface PreSpawnBlocker {
  readonly source: "settings" | "authStore";
  readonly reason: string;
  readonly remediation: string;
}

const GENERIC_STRIP: EnvironmentClassification = {
  action: "STRIP", reason: "UNRELATED_CREDENTIAL", remediation: "The credential is omitted from this child process.",
};
const ORDINARY_ALLOW: EnvironmentClassification = {
  action: "ALLOW", reason: "ORDINARY_ENVIRONMENT", remediation: "No action needed.",
};
const SSL_KEYLOG_STRIP: EnvironmentClassification = {
  action: "STRIP", reason: "TLS_KEY_LOGGING", remediation: "TLS key logging is omitted from provider children.",
};

/** Credential-like variables from other tools are stripped instead of leaked to provider children. */
function isGenericCredentialKey(key: string): boolean {
  return /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL|PRIVATE_KEY|AUTHORIZATION|COOKIE)(?:$|_)/.test(key);
}

export class SafeChildEnvironment {
  readonly decisions: readonly EnvironmentDecision[];
  readonly authLaneIntent: "subscription" | "subscriptionToken";
  readonly provider: ProviderId;
  readonly #values: NodeJS.ProcessEnv;

  constructor(provider: ProviderId, values: NodeJS.ProcessEnv, decisions: readonly EnvironmentDecision[],
    authLaneIntent: "subscription" | "subscriptionToken") {
    this.provider = provider;
    this.#values = { ...values };
    this.decisions = [...decisions];
    this.authLaneIntent = authLaneIntent;
  }

  /** Only the process layer should call this. The returned values must never be logged. */
  forSpawn(): NodeJS.ProcessEnv { return { ...this.#values }; }

  toJSON(): Readonly<{ provider: ProviderId; authLaneIntent: AuthLane; decisions: readonly EnvironmentDecision[] }> {
    return { provider: this.provider, authLaneIntent: this.authLaneIntent, decisions: this.decisions };
  }
}

export type EnvironmentBuildResult =
  | Readonly<{ ok: true; child: SafeChildEnvironment; decisions: readonly EnvironmentDecision[] }>
  | Readonly<{ ok: false; error: FusionError; decisions: readonly EnvironmentDecision[];
    blockers: readonly PreSpawnBlocker[] }>;

/** No provider names or values enter this core policy engine. */
export class BillingGuard {
  constructor(private readonly rules: EnvironmentRuleSet) {}

  buildChildEnvironment(source: NodeJS.ProcessEnv, blockers: readonly PreSpawnBlocker[] = []): EnvironmentBuildResult {
    const decisions: EnvironmentDecision[] = [];
    const values: NodeJS.ProcessEnv = {};
    const seen = new Set<string>();
    const tokenKeys = new Set(this.rules.subscriptionTokenKeys?.map((key) => key.toUpperCase()) ?? []);
    let authLaneIntent: "subscription" | "subscriptionToken" = "subscription";

    for (const [originalKey, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const key = originalKey.toUpperCase();
      if (seen.has(key)) {
        decisions.push({ key, action: "BLOCK", reason: "DUPLICATE_CASE_INSENSITIVE_KEY",
          remediation: "Remove duplicate environment spellings before running Fusion." });
        continue;
      }
      seen.add(key);
      if (originalKey.includes("\0") || typeof value !== "string" || value.includes("\0")) {
        decisions.push({ key, action: "BLOCK", reason: "INVALID_ENVIRONMENT_ENTRY",
          remediation: "Remove the invalid environment entry before running Fusion." });
        continue;
      }
      const classification = this.rules.classify(key) ??
        (key === "SSLKEYLOGFILE" ? SSL_KEYLOG_STRIP : isGenericCredentialKey(key) ? GENERIC_STRIP : ORDINARY_ALLOW);
      decisions.push({ key, ...classification });
      if (classification.action === "ALLOW") {
        values[originalKey] = value;
        if (tokenKeys.has(key)) authLaneIntent = "subscriptionToken";
      }
    }

    if (decisions.some((decision) => decision.action === "BLOCK") || blockers.length > 0) {
      return { ok: false, decisions, blockers: [...blockers], error: {
        kind: "BillingBlocked", safeMessage: "Environment contains a blocked billing or provider override.", retryable: false,
      } };
    }
    return { ok: true, child: new SafeChildEnvironment(this.rules.provider, values, decisions, authLaneIntent), decisions };
  }
}

export interface PermissionEvidence {
  readonly posture: WorkspacePosture | "unknown";
  readonly profileId: string;
  readonly source: "runtimeReadback" | "hostEnforcement" | "unknown";
  readonly mechanicallyEnforced: boolean;
}
export interface RuntimeAssertionExpected {
  readonly provider: ProviderId;
  readonly model: string;
  readonly authLane: "subscription" | "subscriptionToken";
  readonly posture: WorkspacePosture;
  readonly permissionProfileId: string;
  readonly requiredCapabilities: CapabilityRequirement;
}
export interface RuntimeAssertionObserved {
  readonly auth: AuthStatus;
  readonly effectiveProvider: ProviderId | null;
  readonly effectiveModel: string | null;
  readonly permission: PermissionEvidence;
  readonly capabilities: CapabilitySnapshot;
}
export type RuntimeAssertionResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: FusionError }>;

function failure(kind: FusionError["kind"], safeMessage: string): RuntimeAssertionResult {
  return { ok: false, error: { kind, safeMessage, retryable: false } };
}

/** Adapters supply observed facts; this gate never accepts requested flags as evidence. */
export function assertRuntimeEvidence(expected: RuntimeAssertionExpected, observed: RuntimeAssertionObserved): RuntimeAssertionResult {
  if (observed.auth.state !== "authenticated" || observed.auth.lane !== expected.authLane) {
    return failure("AuthMismatch", "Effective subscription authentication could not be confirmed.");
  }
  if (observed.effectiveProvider !== expected.provider || observed.capabilities.provider !== expected.provider) {
    return failure("ProviderIdentityMismatch", "Effective provider differs from the configured binding.");
  }
  if (observed.effectiveModel !== expected.model) {
    return failure("ProviderIdentityMismatch", "Effective model differs from the configured binding.");
  }
  if (observed.permission.posture !== expected.posture ||
      observed.permission.profileId !== expected.permissionProfileId ||
      observed.permission.source === "unknown" || !observed.permission.mechanicallyEnforced) {
    return failure("SecurityViolation", "Effective permission posture could not be confirmed.");
  }
  if (!meetsCapabilities(observed.capabilities, expected.requiredCapabilities)) {
    return failure("CapabilityUnavailable", "Required runtime capability is unavailable or unobserved.");
  }
  return { ok: true };
}
