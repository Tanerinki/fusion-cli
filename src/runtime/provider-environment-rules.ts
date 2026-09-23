import type { EnvironmentClassification, EnvironmentRuleSet, PreSpawnBlocker } from "../core/policy/billing-guard.js";

const block = (reason: string, remediation: string): EnvironmentClassification =>
  ({ action: "BLOCK", reason, remediation });
const strip = (reason: string): EnvironmentClassification =>
  ({ action: "STRIP", reason, remediation: "Fusion sets this behavior explicitly for the child process." });
const allow = (reason: string): EnvironmentClassification =>
  ({ action: "ALLOW", reason, remediation: "No action needed." });

const CLAUDE_BLOCK = new Map<string, EnvironmentClassification>([
  ["ANTHROPIC_API_KEY", block("API_KEY_OVERRIDE", "Unset the API key to use subscription authentication.")],
  ["ANTHROPIC_AUTH_TOKEN", block("GATEWAY_TOKEN_OVERRIDE", "Unset the gateway token to use subscription authentication.")],
  ["ANTHROPIC_BASE_URL", block("BASE_URL_OVERRIDE", "Unset the endpoint override before running Fusion.")],
  ["CLAUDE_CODE_USE_BEDROCK", block("THIRD_PARTY_ROUTE", "Disable the alternate provider route.")],
  ["CLAUDE_CODE_USE_VERTEX", block("THIRD_PARTY_ROUTE", "Disable the alternate provider route.")],
  ["CLAUDE_CODE_USE_FOUNDRY", block("THIRD_PARTY_ROUTE", "Disable the alternate provider route.")],
]);
const CLAUDE_STRIP = new Set([
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_PID", "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_EFFORT", "ANTHROPIC_MODEL",
]);

/**
 * What Fusion does with `CLAUDE_CODE_OAUTH_TOKEN`, the long-lived subscription OAuth credential `claude setup-token`
 * produces for headless use:
 * - `subscriptionOAuth` (default): a recognized subscription credential class, forwarded to the child; the candidate
 *   lane is `subscriptionToken`.
 * - `strip`: omitted, so the child uses the interactive subscription login (lane `subscription`).
 * - `block`: its presence refuses the run.
 * - `forwardExplicitSubscriptionToken`: the earlier name of `subscriptionOAuth`, kept for existing configurations.
 */
export type ClaudeOauthTokenPolicy = "subscriptionOAuth" | "strip" | "block" | "forwardExplicitSubscriptionToken";
export const DEFAULT_CLAUDE_OAUTH_TOKEN_POLICY: ClaudeOauthTokenPolicy = "subscriptionOAuth";

/**
 * Provider-specific rules are data supplied to the generic BillingGuard.
 *
 * Claude credential classes recognized before spawn (stage 1):
 * - subscription login (no credential variable): lane `subscription`;
 * - subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`, value never inspected): lane `subscriptionToken`.
 * Every API-billed or alternate-provider source (API key, gateway token, base URL, Bedrock/Vertex/Foundry routes, any
 * unrecognized provider variable, settings API-key helpers or env overrides) blocks the whole environment. A token
 * therefore never coexists with one of them in a child: Fusion refuses rather than choose between conflicting lanes.
 * The class is only a candidate. The adapter must read back an OAuth-token subscription login, and a session with no
 * API-key source, before any turn is trusted (stage 2).
 */
export function claudeEnvironmentRules(oauthToken: ClaudeOauthTokenPolicy = DEFAULT_CLAUDE_OAUTH_TOKEN_POLICY): EnvironmentRuleSet {
  const forward = oauthToken === "subscriptionOAuth" || oauthToken === "forwardExplicitSubscriptionToken";
  return {
    provider: "claude",
    subscriptionTokenKeys: forward ? ["CLAUDE_CODE_OAUTH_TOKEN"] : [],
    classify(key) {
      if (key === "CLAUDE_CODE_OAUTH_TOKEN") {
        if (oauthToken === "strip") return strip("SUBSCRIPTION_TOKEN_STRIPPED");
        if (forward) return allow("SUBSCRIPTION_OAUTH_TOKEN");
        return block("SUBSCRIPTION_TOKEN_BLOCKED_BY_POLICY", "Unset the token, or choose the subscriptionOAuth or strip policy.");
      }
      const blocked = CLAUDE_BLOCK.get(key);
      if (blocked !== undefined) return blocked;
      if (CLAUDE_STRIP.has(key)) return strip("INHERITED_SESSION_OR_MODEL_OVERRIDE");
      if (/^(?:META_|MUSE_|TBH_)/.test(key) || key === "MODEL_API_KEY") return strip("OTHER_PROVIDER_CREDENTIAL_OR_STATE");
      if (/^(?:ANTHROPIC_|CLAUDE_CODE_|CLAUDE_)/.test(key)) {
        return block("UNRECOGNIZED_PROVIDER_VARIABLE", "Remove this provider variable or add a reviewed policy rule.");
      }
      return undefined;
    },
  };
}

/** Inspect keys and structure only; never include settings values in diagnostics. */
export function claudeSettingsBlockers(settings: unknown): readonly PreSpawnBlocker[] {
  const blockers: PreSpawnBlocker[] = [];
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    return [{ source: "settings", reason: "SETTINGS_UNREADABLE",
      remediation: "Use a valid settings object before launching this provider." }];
  }
  // A settings file is never a recognized credential source, whatever the environment policy is.
  const rules = claudeEnvironmentRules("block");
  const seen = new Set<object>();
  const visit = (value: object, depth: number, parentKey: string): void => {
    if (seen.has(value)) return;
    seen.add(value);
    if (depth > 12) {
      blockers.push({ source: "settings", reason: "SETTINGS_TOO_DEEP",
        remediation: "Inspect the provider settings before running Fusion." });
      return;
    }
    for (const [rawKey, entry] of Object.entries(value)) {
      const key = rawKey.toUpperCase();
      if (key === "APIKEYHELPER") {
        blockers.push({ source: "settings", reason: "API_KEY_HELPER",
          remediation: "Remove the API-key helper for subscription-backed runs." });
        continue;
      }
      if (parentKey === "ENV" && (rules.classify(key)?.action === "BLOCK" ||
          /(?:^|_)(?:API_KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL)(?:$|_)/.test(key))) {
        blockers.push({ source: "settings", reason: "PROVIDER_ENV_OVERRIDE",
          remediation: "Remove the provider override from settings before running Fusion." });
        continue;
      }
      if (entry !== null && typeof entry === "object") visit(entry, depth + 1, key);
    }
  };
  visit(settings, 0, "");
  return blockers;
}

const MUSE_BLOCK = new Map<string, EnvironmentClassification>([
  ["META_API_KEY", block("API_KEY_OVERRIDE", "Unset the API key to use account login.")],
  ["MODEL_API_KEY", block("API_KEY_OVERRIDE", "Unset the API key to use account login.")],
  ["MUSE_CUSTOM_HEADERS", block("CUSTOM_REQUEST_HEADERS", "Unset custom request headers before running Fusion.")],
  ["MUSE_AUTH_PATH", block("AUTH_STORE_OVERRIDE", "Use the normal account login location.")],
  ["XDG_CONFIG_HOME", block("AUTH_STORE_OVERRIDE", "Use the normal account login location.")],
]);
const MUSE_STRIP = new Set([
  "MUSE_MODEL", "MUSE_PROVIDER", "MUSE_REASONING_EFFORT", "MUSE_SESSION_ID",
  "MUSE_ENABLE_WEB_TOOLS", "MUSE_ENABLE_SESSION_MCP", "MUSE_WEB_SEARCH_MODE",
  "MUSE_HUMAN_CONFIRMATION", "MUSE_NO_AUTO_UPDATE", "MUSE_SYNC_UPDATE",
  "MUSE_CHANNEL", "MUSE_LAUNCHER_INSTALL", "MUSE_INTERNAL_UPDATE", "MUSE_RELEASE_INFO",
  "MUSE_LOGIN", "TBH_MANAGED_HOOKS_PATH", "TBH_DISABLE_TELEMETRY",
]);

export function museEnvironmentRules(): EnvironmentRuleSet {
  return {
    provider: "muse",
    classify(key) {
      const blocked = MUSE_BLOCK.get(key);
      if (blocked !== undefined) return blocked;
      if (key === "TBH_AUTH_BASE_URL" || key === "TBH_MINT_BASE_URL" ||
          /^(?:TBH_|MUSE_).+_BASE_URL$/.test(key)) {
        return block("BASE_URL_OVERRIDE", "Unset the endpoint override before running Fusion.");
      }
      if (MUSE_STRIP.has(key) || key.startsWith("MUSE_EXPERIMENTAL_")) {
        return strip("INHERITED_SESSION_OR_MODEL_OVERRIDE");
      }
      if (/^(?:ANTHROPIC_|CLAUDE_CODE_|CLAUDE_)/.test(key) || key === "CLAUDECODE") {
        return strip("OTHER_PROVIDER_CREDENTIAL_OR_STATE");
      }
      if (/^(?:META_|MUSE_|TBH_)/.test(key)) {
        return block("UNRECOGNIZED_PROVIDER_VARIABLE", "Remove this provider variable or add a reviewed policy rule.");
      }
      return undefined;
    },
  };
}
