import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DelegationPacket, RoleBinding } from "../src/core/domain.js";
import { ClaudeOneShotTransport } from "../src/providers/claude/one-shot-transport.js";
import { ClaudeAdapter } from "../src/providers/claude/claude-adapter.js";
import { parsePluginInventory, withTemporaryPluginSettings } from "../src/providers/claude/plugin-quarantine.js";
import type { ClaudeLaunchConfig } from "../src/providers/claude/types.js";

const fixture = resolve(process.cwd(), "test/fixtures/claude-fake.mjs");
const fixtureBinary = { executable: process.execPath, argvPrefix: [fixture] } as const;
const packet: DelegationPacket = { task: { goal: "line 1\n& | $() ü ☃", constraints: [], acceptanceCriteria: [] },
  scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] },
  architecture: { decisions: [], invariants: [] }, verification: { requiredTests: [] }, openQuestions: [] };
function config(scenario: string): ClaudeLaunchConfig {
  return { executablePath: "unused", workspace: process.cwd(), model: { id: "alias", effort: "low", maxTurns: 3 },
    // A generous default: a spawned fake must not time out merely because the parallel suite is busy. Scenarios that test
    // deadlines set their own budget.
    expectedCanonicalModel: "claude-canonical-fixture", posture: "readOnly", timeoutMs: 5_000,
    sourceEnvironment: { FUSION_FAKE_SCENARIO: scenario, SystemRoot: process.env.SystemRoot,
      USERPROFILE: resolve(process.cwd(), "test/fixtures/empty-claude-home"),
      CLAUDE_CODE_EFFORT_LEVEL: "inherited" } };
}
function transport(scenario: string, override?: Partial<ClaudeLaunchConfig>): ClaudeOneShotTransport {
  return new ClaudeOneShotTransport({ ...config(scenario), ...override }, undefined, fixtureBinary);
}
const run = (scenario: string, override?: Partial<ClaudeLaunchConfig>, signal?: AbortSignal) =>
  transport(scenario, override).run({ packet, requiredCapabilities: { structuredOutput: true, webToolsDisabled: true,
    filesystem: { read: true, write: false }, shell: { available: false }, modelIdentityReadback: true,
    subscriptionLaneReadback: true }, ...(signal ? { signal } : {}) });

test("Claude one-shot checks argv, safe env, stdin and canonical model independently of alias", async () => {
  const t = transport("ok");
  const result = await t.run({ packet, requiredCapabilities: { webToolsDisabled: true, structuredOutput: true } });
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.effectiveModel, "claude-canonical-fixture");
    assert.equal(result.output.changes.summary, "fixture");
    assert.equal(result.usage?.inputTokens, 12);
    assert.equal(result.usage?.outputTokens, 7);
    assert.equal(result.usage?.estimatedListCostUsd, 0.0123);
  }
  assert.equal(t.runtimeEvidence?.requestedModel, "alias");
  assert.equal(t.runtimeEvidence?.effectiveModel, "claude-canonical-fixture");
  assert.deepEqual(t.runtimeEvidence?.tools, ["Glob", "Grep", "Read"]);
  assert.deepEqual(t.runtimeEvidence?.mcpServers, []);
  assert.deepEqual(t.runtimeEvidence?.extensionInventory,
    { agents: 0, skills: 0, slashCommands: 0, plugins: 0 });
  assert.equal(t.runtimeEvidence?.extensionIsolation.state, "disabled");
  assert.equal(t.runtimeEvidence?.extensionIsolation.managedHooks, "unverified");
  assert.equal(t.runtimeEvidence?.extensionIsolation.versionVerified, true);
  assert.equal(t.capabilities().persistentSessions, false);
  assert.equal(t.capabilities().webToolsDisabled, true);
  assert.deepEqual(t.capabilities().webToolsDisabledEvidence, { source: "runtimeReadback", versionVerified: false });
  assert.doesNotMatch(JSON.stringify(t.runtimeEvidence), /private@example\.com|private-org/);
});
for (const [scenario, kind] of [
  ["permission", "SecurityViolation"], ["shell-tool", "SecurityViolation"], ["write-tool", "SecurityViolation"],
  ["mcp", "SecurityViolation"], ["plugin", "SecurityViolation"], ["task-tool", "SecurityViolation"],
  ["skill-tool", "SecurityViolation"], ["plugin-tool", "SecurityViolation"],
  ["hook-active", "SecurityViolation"], ["hooks-field", "SecurityViolation"],
  ["slash-command-active", "SecurityViolation"],
  ["init-api-key", "AuthMismatch"],
  ["model-mismatch", "ProviderIdentityMismatch"], ["success-error", "ProcessFailure"],
  ["nonzero", "ProcessFailure"], ["malformed", "ProtocolError"], ["missing-result", "ProtocolError"],
  ["no-init", "ProtocolError"], ["process-failure", "ProcessFailure"],
  ["assistant-model-mismatch", "ProtocolError"], ["bad-packet", "MalformedOutput"],
  ["extra-packet", "MalformedOutput"],
] as const) {
  test(`Claude one-shot fails closed on ${scenario}`, async () => {
    const result = await run(scenario);
    assert.equal(result.status, "failed"); if (result.status === "failed") assert.equal(result.error.kind, kind);
  });
}
test("Claude auth probe rejects missing, logged-out, ambiguous and API-key evidence", async () => {
  for (const scenario of ["auth-no-key-source", "auth-no-login-evidence", "auth-logged-out",
    "auth-ambiguous", "auth-api-key"]) {
    const result = await run(scenario);
    assert.equal(result.status, "failed"); if (result.status === "failed") assert.equal(result.error.kind, "AuthMismatch");
  }
});
test("Claude explicit subscription token is separate from API bearer", async () => {
  const env = { ...config("token").sourceEnvironment, CLAUDE_CODE_OAUTH_TOKEN: "private-token" };
  const blocked = await run("token", { sourceEnvironment: env, oauthTokenPolicy: "block" });
  assert.equal(blocked.status, "failed"); if (blocked.status === "failed") assert.equal(blocked.error.kind, "BillingBlocked");
  const byDefault = await run("token", { sourceEnvironment: env });
  assert.equal(byDefault.status, "completed", "the subscription OAuth token is a recognized lane by default");
  const allowed = await run("token", { sourceEnvironment: env, oauthTokenPolicy: "forwardExplicitSubscriptionToken" });
  assert.equal(allowed.status, "completed");
  const observedShape = await run("token-no-key-source", { sourceEnvironment: {
    ...env, FUSION_FAKE_SCENARIO: "token-no-key-source" }, oauthTokenPolicy: "forwardExplicitSubscriptionToken" });
  assert.equal(observedShape.status, "completed");
  const unforwarded = await run("token-no-key-source");
  assert.equal(unforwarded.status, "failed");
  if (unforwarded.status === "failed") assert.equal(unforwarded.error.kind, "AuthMismatch");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "private-token");
  const bearer = await run("ok", { sourceEnvironment: { ...env, ANTHROPIC_AUTH_TOKEN: "secret" },
    oauthTokenPolicy: "forwardExplicitSubscriptionToken" });
  assert.equal(bearer.status, "failed"); if (bearer.status === "failed") assert.equal(bearer.error.kind, "BillingBlocked");
});
test("Claude BillingGuard blocks before any executable is launched", async () => {
  const t = new ClaudeOneShotTransport({ ...config("ok"),
    sourceEnvironment: { ...config("ok").sourceEnvironment, ANTHROPIC_API_KEY: "secret" },
    executablePath: "C:\\nonexistent\\claude.exe" });
  const result = await t.run({ packet, requiredCapabilities: {} });
  assert.equal(result.status, "failed"); if (result.status === "failed") assert.equal(result.error.kind, "BillingBlocked");
});
test("Claude settings blocker is applied before process launch", async () => {
  const t = new ClaudeOneShotTransport({ ...config("ok"), settings: { apiKeyHelper: "private" },
    executablePath: "C:\\nonexistent\\claude.exe" });
  const result = await t.run({ packet, requiredCapabilities: {} });
  assert.equal(result.status, "failed"); if (result.status === "failed") assert.equal(result.error.kind, "BillingBlocked");
});
test("Claude reads user and workspace settings blockers without exposing values", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "fusion-claude-settings-test-"));
  try {
    const local = join(workspace, ".claude"); await mkdir(local);
    await writeFile(join(local, "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "secret" } }), "utf8");
    const result = await run("ok", { workspace, sourceEnvironment: {
      ...config("ok").sourceEnvironment, USERPROFILE: join(workspace, "empty-home") } });
    assert.equal(result.status, "failed"); if (result.status === "failed") assert.equal(result.error.kind, "BillingBlocked");
    await rm(join(local, "settings.local.json"));
    const homeSettings = join(workspace, "empty-home", ".claude");
    await mkdir(homeSettings, { recursive: true });
    await writeFile(join(homeSettings, "settings.json"), JSON.stringify({ apiKeyHelper: "private" }), "utf8");
    const userBlocked = await run("ok", { workspace, sourceEnvironment: {
      ...config("ok").sourceEnvironment, USERPROFILE: join(workspace, "empty-home") } });
    assert.equal(userBlocked.status, "failed");
    if (userBlocked.status === "failed") assert.equal(userBlocked.error.kind, "BillingBlocked");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
test("Claude child environment construction leaves the source unchanged", async () => {
  const source = Object.freeze({ ...config("ok").sourceEnvironment, OTHER_API_KEY: "private" });
  const before = { ...source };
  const result = await run("ok", { sourceEnvironment: source });
  assert.equal(result.status, "completed"); assert.deepEqual(source, before);
});
test("Claude inventory counts are diagnostic on the validated version", async () => {
  const t = transport("inventory");
  const result = await t.run({ packet, requiredCapabilities: { webToolsDisabled: true } });
  assert.equal(result.status, "completed");
  assert.deepEqual(t.runtimeEvidence?.extensionInventory,
    { agents: 1, skills: 1, slashCommands: 1, plugins: 0 });
  assert.deepEqual(t.runtimeEvidence?.tools, ["Glob", "Grep", "Read"]);
});

test("Claude plugin inventory parser accepts empty and scoped installed entries", () => {
  assert.deepEqual(parsePluginInventory("[]"), { ids: [], counts: { installed: 0, builtin: 0 } });
  const inventory = parsePluginInventory(JSON.stringify([
    { id: "private-one@market", enabled: true, scope: "user" },
    { id: "private-two@synced", enabled: true, scope: "synced" },
    { id: "private-three@skills-dir", enabled: true, scope: "project" },
    { id: "private-four@market", enabled: false, scope: "local" }]));
  assert.equal(inventory.ids.length, 4);
  assert.equal(inventory.counts.installed, 4);
  assert.throws(() => parsePluginInventory("{broken"), /inventory JSON was malformed/);
  assert.throws(() => parsePluginInventory(JSON.stringify([{ enabled: true }])), /row was unsupported/);
  assert.throws(() => parsePluginInventory(JSON.stringify([{ id: "private-required@synced", requiredByOrg: true }])),
    /required Claude plugin/);
});

test("Claude temporary plugin settings disable each ID and are removed after success and failure", async () => {
  let successPath = "";
  const source = Object.freeze(["private-alpha@market", "private-beta@synced"]);
  await withTemporaryPluginSettings(source, async path => {
    successPath = path;
    const raw = await readFile(path);
    assert.equal(raw.subarray(0, 3).toString("hex") === "efbbbf", false);
    assert.deepEqual(JSON.parse(raw.toString("utf8")), { enabledPlugins: {
      "private-alpha@market": false, "private-beta@synced": false } });
  });
  await assert.rejects(stat(successPath), { code: "ENOENT" });
  assert.deepEqual(source, ["private-alpha@market", "private-beta@synced"]);
  let failurePath = "";
  await assert.rejects(withTemporaryPluginSettings(source, async path => {
    failurePath = path; throw new Error("fixture failure");
  }), /fixture failure/);
  await assert.rejects(stat(failurePath), { code: "ENOENT" });
});

test("Claude quarantines discovered built-ins and every installed plugin in child-only settings", async () => {
  for (const scenario of ["builtin-quarantine", "plugin-list-multiple"]) {
    const t = transport(scenario);
    const result = await t.run({ packet, requiredCapabilities: {} });
    assert.equal(result.status, "completed");
    assert.equal(t.runtimeEvidence?.pluginIsolation?.preflight, "explicitTemporaryDisable");
    assert.equal(t.runtimeEvidence?.pluginIsolation?.runtimeLoadedPlugins, 0);
    assert.equal(t.runtimeEvidence?.pluginIsolation?.builtinCount, scenario === "builtin-quarantine" ? 1 : 0);
    assert.equal(t.runtimeEvidence?.pluginIsolation?.installedCount, scenario === "plugin-list-multiple" ? 3 : 0);
  }
});

for (const [scenario, kind] of [
  ["plugin-list-malformed", "ProtocolError"], ["plugin-list-failure", "CapabilityUnavailable"],
  ["plugin-list-required", "CapabilityUnavailable"], ["builtin-race", "SecurityViolation"],
  ["builtin-required-stays", "SecurityViolation"], ["probe-hook", "SecurityViolation"],
  ["probe-plugin-install", "SecurityViolation"],
] as const) {
  test(`Claude plugin quarantine fails closed on ${scenario} without leaking metadata`, async () => {
    const result = await run(scenario);
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.kind, kind);
      assert.doesNotMatch(result.error.safeMessage, /private-|@synced|private-path/);
    }
  });
}

test("Claude unknown version leaves flag-derived extension isolation unvalidated", async () => {
  const t = transport("version-upgrade");
  const result = await t.run({ packet, requiredCapabilities: { webToolsDisabled: true } });
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.error.kind, "CapabilityUnavailable");
  assert.equal(t.runtimeEvidence, undefined);
  const withInventory = await run("inventory-unknown-version");
  assert.equal(withInventory.status, "failed");
  if (withInventory.status === "failed") assert.equal(withInventory.error.kind, "CapabilityUnavailable");
});
test("Claude accepts a bounded system preamble only when init and all runtime gates follow", async () => {
  const result = await run("preinit-system");
  assert.equal(result.status, "completed");
});
test("Claude missing usage stays unknown and list price is not billed cost", async () => {
  const t = transport("usage-absent");
  const result = await t.run({ packet, requiredCapabilities: {} });
  assert.equal(result.status, "completed"); assert.equal(result.usage, undefined);
  assert.equal(t.capabilities().usageReporting, "unknown");
  const required = await t.run({ packet, requiredCapabilities: { usageReporting: true } });
  assert.equal(required.status, "failed"); if (required.status === "failed") assert.equal(required.error.kind, "CapabilityUnavailable");
});
test("Claude handles informational rate-limit telemetry but rejects active overage", async () => {
  assert.equal((await run("rate-limit-info")).status, "completed");
  const overage = await run("overage-active");
  assert.equal(overage.status, "failed");
  if (overage.status === "failed") assert.equal(overage.error.kind, "SecurityViolation");
});
test("Claude consumes schema-backed structured output from the terminal event", async () => {
  assert.equal((await run("structured-output")).status, "completed");
});
test("Claude timeout, cancellation and rate limit are distinct", async () => {
  const timeout = await run("timeout", { timeoutMs: 100 });
  assert.equal(timeout.status, "failed"); if (timeout.status === "failed") assert.equal(timeout.error.kind, "Timeout");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const cancelled = await run("cancel", { timeoutMs: 2_000 }, controller.signal);
  assert.equal(cancelled.status, "cancelled");
  const limited = await run("rate-limit", { timeoutMs: 2_000 });
  assert.equal(limited.status, "failed");
  if (limited.status === "failed") { assert.equal(limited.error.kind, "ProcessFailure"); assert.equal(limited.error.retryable, true); }
});
test("ClaudeAdapter implements local one-shot sessions without persistent capability", async () => {
  const binding: RoleBinding = { role: "Reviewer", provider: "claude", model: config("ok").model,
    transport: "claude-one-shot", requires: { webToolsDisabled: true } };
  const adapter = new ClaudeAdapter(binding, config("ok"), fixtureBinary);
  assert.equal((await adapter.capabilities()).persistentSessions, false);
  const session = await adapter.createSession({ runId: "run", role: "Reviewer", workspaceLeaseId: "lease",
    posture: "readOnly", model: binding.model });
  try { assert.equal((await adapter.resumeSession(session)).id, session.id);
    const result = await adapter.runTurn(session, packet);
    assert.equal(result.status, "completed"); assert.equal((await adapter.usage(session))?.estimatedListCostUsd, 0.0123);
  } finally { await adapter.close(session); }
});
