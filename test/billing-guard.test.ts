import assert from "node:assert/strict";
import test from "node:test";
import { BillingGuard, assertRuntimeEvidence } from "../src/core/policy/billing-guard.js";
import type { RuntimeAssertionExpected, RuntimeAssertionObserved } from "../src/core/policy/billing-guard.js";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import { claudeEnvironmentRules, claudeSettingsBlockers, museEnvironmentRules } from "../src/runtime/provider-environment-rules.js";

const claude = new BillingGuard(claudeEnvironmentRules());
const muse = new BillingGuard(museEnvironmentRules());

test("billing overrides block under Windows case-insensitive key comparison", () => {
  const blocked = [
    [claude, "anthropic_api_key"],
    [claude, "Anthropic_Auth_Token"],
    [claude, "ANTHROPIC_BASE_URL"],
    [claude, "CLAUDE_CODE_USE_BEDROCK"],
    [claude, "claude_code_use_vertex"],
    [claude, "CLAUDE_CODE_USE_FOUNDRY"],
    [muse, "meta_api_key"],
    [muse, "MODEL_API_KEY"],
    [muse, "MUSE_CUSTOM_HEADERS"],
    [muse, "TBH_AUTH_BASE_URL"],
    [muse, "tbh_mint_base_url"],
    [muse, "TBH_OTHER_BASE_URL"],
    [muse, "MUSE_AUTH_PATH"],
  ] as const;
  for (const [guard, key] of blocked) {
    const secret = "secret-value-must-not-appear-123";
    const result = guard.buildChildEnvironment({ [key]: secret });
    assert.equal(result.ok, false, key);
    assert.equal(result.decisions[0]?.action, "BLOCK", key);
    assert.doesNotMatch(JSON.stringify(result), /secret-value-must-not-appear/);
  }
});

test("duplicate case spellings fail closed, including ordinary environment names", () => {
  const result = claude.buildChildEnvironment({ Path: "first", PATH: "second" });
  assert.equal(result.ok, false);
  assert.ok(result.decisions.some((decision) => decision.reason === "DUPLICATE_CASE_INSENSITIVE_KEY"));
});

test("known session and model overrides are stripped while ordinary environment is preserved", () => {
  const input = Object.freeze({
    PATH: "C:\\bin", SystemRoot: "C:\\Windows", NODE_EXTRA_CA_CERTS: "C:\\cert.pem",
    ANTHROPIC_MODEL: "inherited-model", CLAUDE_CODE_SESSION_ID: "session-secret",
    CLAUDE_CODE_EFFORT_LEVEL: "max", SSLKEYLOGFILE: "sensitive-log-path",
    META_API_KEY: "other-provider-secret", GITHUB_TOKEN: "unrelated-secret",
  });
  const original = { ...input };
  const result = claude.buildChildEnvironment(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const env = result.child.forSpawn();
  assert.equal(env.PATH, "C:\\bin");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.NODE_EXTRA_CA_CERTS, "C:\\cert.pem");
  for (const key of ["ANTHROPIC_MODEL", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_EFFORT_LEVEL",
    "SSLKEYLOGFILE", "META_API_KEY", "GITHUB_TOKEN"]) {
    assert.equal(env[key], undefined, key);
  }
  assert.deepEqual(input, original);
  assert.doesNotMatch(JSON.stringify(result), /session-secret|other-provider-secret|unrelated-secret/);
});

test("Muse rules strip known inherited options and reject unknown provider variables", () => {
  const safe = muse.buildChildEnvironment({ PATH: "C:\\bin", MUSE_MODEL: "inherited",
    MUSE_EXPERIMENTAL_FLAG: "1", TBH_MANAGED_HOOKS_PATH: "hidden", CLAUDE_CODE_OAUTH_TOKEN: "other-secret" });
  assert.equal(safe.ok, true);
  if (safe.ok) {
    assert.equal(safe.child.forSpawn().PATH, "C:\\bin");
    assert.equal(safe.child.forSpawn().MUSE_MODEL, undefined);
    assert.equal(safe.child.forSpawn().CLAUDE_CODE_OAUTH_TOKEN, undefined);
  }
  assert.equal(muse.buildChildEnvironment({ MUSE_FUTURE_ROUTER: "x" }).ok, false);
  assert.equal(claude.buildChildEnvironment({ ANTHROPIC_FUTURE_ROUTER: "x" }).ok, false);
});

test("Claude OAuth token is an explicit subscription-token lane, never an API bearer", () => {
  const token = "oauth-secret-value-12345";
  assert.equal(claude.buildChildEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: token }).ok, false);
  const stripped = new BillingGuard(claudeEnvironmentRules("strip"))
    .buildChildEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: token });
  assert.equal(stripped.ok, true);
  if (stripped.ok) {
    assert.equal(stripped.child.authLaneIntent, "subscription");
    assert.equal(stripped.child.forSpawn().CLAUDE_CODE_OAUTH_TOKEN, undefined);
  }
  const explicit = new BillingGuard(claudeEnvironmentRules("forwardExplicitSubscriptionToken"))
    .buildChildEnvironment({ claude_code_oauth_token: token });
  assert.equal(explicit.ok, true);
  if (explicit.ok) {
    assert.equal(explicit.child.authLaneIntent, "subscriptionToken");
    assert.equal(explicit.child.forSpawn().claude_code_oauth_token, token);
    assert.doesNotMatch(JSON.stringify(explicit), /oauth-secret-value/);
  }
});

test("provider settings API-key helper and environment overrides block before spawn", () => {
  const settings = { apiKeyHelper: "secret command must not be logged", env: {
    ANTHROPIC_BASE_URL: "https://secret.invalid", OTHER_API_KEY: "other-secret",
  } };
  const blockers = claudeSettingsBlockers(settings);
  assert.ok(blockers.some((blocker) => blocker.reason === "API_KEY_HELPER"));
  assert.ok(blockers.some((blocker) => blocker.reason === "PROVIDER_ENV_OVERRIDE"));
  const result = claude.buildChildEnvironment({ PATH: "C:\\bin" }, blockers);
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /secret command|secret.invalid|other-secret/);
  assert.ok(claudeSettingsBlockers(null).some((blocker) => blocker.reason === "SETTINGS_UNREADABLE"));
});

test("diagnostic redaction masks credentials, account emails and organization IDs", () => {
  const redactor = new DiagnosticRedactor(["known-secret-456"]);
  const redacted = redactor.redact({
    apiKey: "known-secret-456",
    refreshToken: "unlisted-secret-value",
    account: { userEmail: "person@example.org", organizationId: "org_abc123" },
    message: "credential known-secret-456 for person@example.org in org_abc123; Authorization: Bearer abc.def-ghi",
  });
  const text = JSON.stringify(redacted);
  assert.doesNotMatch(text, /known-secret-456|unlisted-secret-value|person@example.org|org_abc123|abc.def-ghi/);
  assert.match(text, /\[REDACTED\]/);
  const fromEnvironment = DiagnosticRedactor.fromEnvironment({ GITHUB_TOKEN: "abc", PATH: "C:\\bin" });
  assert.equal(fromEnvironment.redactText("token abc"), "token [REDACTED]");
  assert.doesNotMatch(JSON.stringify(fromEnvironment), /abc/);
});

const expected: RuntimeAssertionExpected = {
  provider: "configured-provider", model: "configured-model", authLane: "subscription",
  posture: "readOnly", permissionProfileId: "review-posture-v1",
  requiredCapabilities: { structuredOutput: true, modelIdentityReadback: true, filesystem: { read: true, write: false } },
};
const observed: RuntimeAssertionObserved = {
  auth: { state: "authenticated", lane: "subscription", observedAt: "now", evidence: ["account-read"] },
  effectiveProvider: "configured-provider", effectiveModel: "configured-model",
  permission: { posture: "readOnly", profileId: "review-posture-v1", source: "runtimeReadback", mechanicallyEnforced: true },
  capabilities: {
    provider: "configured-provider", transport: "transport", observedAt: "now", runtimeVersion: "1",
    persistentSessions: false, structuredOutput: true, filesystem: { read: true, write: false },
    shell: { available: false, sandboxed: false }, approvalCallback: false,
    protocolCancellation: false, usageReporting: false, modelIdentityReadback: true,
    subscriptionLaneReadback: true,
  },
};

test("post-spawn assertion accepts matching subscription evidence", () => {
  assert.deepEqual(assertRuntimeEvidence(expected, observed), { ok: true });
});

test("post-spawn assertion fails closed on ambiguous or API auth", () => {
  for (const auth of [
    { state: "ambiguous", lane: "unknown", observedAt: "now", evidence: [] } as const,
    { state: "authenticated", lane: "api", observedAt: "now", evidence: [] } as const,
  ]) {
    const result = assertRuntimeEvidence(expected, { ...observed, auth });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "AuthMismatch");
  }
});

test("post-spawn assertion rejects provider, model, permission and capability mismatches", () => {
  const variants: RuntimeAssertionObserved[] = [
    { ...observed, effectiveProvider: "wrong-provider" },
    { ...observed, effectiveModel: "wrong-model" },
    { ...observed, permission: { ...observed.permission, mechanicallyEnforced: false } },
    { ...observed, capabilities: { ...observed.capabilities, structuredOutput: "unknown" } },
  ];
  for (const variant of variants) assert.equal(assertRuntimeEvidence(expected, variant).ok, false);
});

test("subscription-token intent requires matching authenticated lane", () => {
  const tokenExpected = { ...expected, authLane: "subscriptionToken" } as const;
  assert.equal(assertRuntimeEvidence(tokenExpected, observed).ok, false);
  assert.deepEqual(assertRuntimeEvidence(tokenExpected, {
    ...observed, auth: { state: "authenticated", lane: "subscriptionToken", observedAt: "now", evidence: ["token-lane"] },
  }), { ok: true });
});
