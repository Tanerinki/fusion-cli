import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import type { DelegationPacket } from "../../src/core/domain.js";
import { ClaudeOneShotTransport } from "../../src/providers/claude/one-shot-transport.js";
import type { ClaudeLaunchConfig } from "../../src/providers/claude/types.js";

if (process.env.FUSION_LIVE_TESTS !== "1" || process.env.FUSION_LIVE_PROVIDER !== "claude")
  throw new Error("Live Claude suite requires FUSION_LIVE_TESTS=1 and FUSION_LIVE_PROVIDER=claude.");
const requestedModel = process.env.FUSION_CLAUDE_MODEL;
const canonicalModel = process.env.FUSION_CLAUDE_CANONICAL_MODEL;
if (!requestedModel || !canonicalModel) throw new Error("Set FUSION_CLAUDE_MODEL and FUSION_CLAUDE_CANONICAL_MODEL explicitly.");
const executablePath = process.env.FUSION_CLAUDE_EXE ?? join(process.env.APPDATA ?? "", "npm", "node_modules",
  "@anthropic-ai", "claude-code", "bin", "claude.exe");
const config: ClaudeLaunchConfig = { executablePath, workspace: process.cwd(),
  model: { id: requestedModel, effort: "low", maxTurns: 1 }, expectedCanonicalModel: canonicalModel,
  posture: "readOnly", timeoutMs: 90_000,
  oauthTokenPolicy: process.env.FUSION_CLAUDE_OAUTH_POLICY === "forwardExplicitSubscriptionToken" ?
    "forwardExplicitSubscriptionToken" : "block" };
const packet: DelegationPacket = { task: { goal: "Return a brief ResultPacket saying the read-only check completed. Do not use tools.",
  constraints: ["Read-only; no writes, shell, web, or external connectors."], acceptanceCriteria: ["Return a valid ResultPacket."] },
  scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] },
  architecture: { decisions: [], invariants: [] }, verification: { requiredTests: [] }, openQuestions: [] };

test("live Claude subscription, canonical model and restricted read-only init", async t => {
  const transport = new ClaudeOneShotTransport(config);
  const auth = await transport.authStatus();
  assert.equal(auth.state, "authenticated");
  assert.equal(auth.lane, "subscriptionToken");
  const result = await transport.run({ packet, requiredCapabilities: { structuredOutput: true, webToolsDisabled: true,
    modelIdentityReadback: true, subscriptionLaneReadback: true, filesystem: { read: true, write: false },
    shell: { available: false } } });
  if (result.status === "failed" && result.error.safeMessage.includes("rate limit")) {
    assert.equal(result.error.kind, "ProcessFailure");
    assert.equal(result.error.retryable, true);
    throw new Error("Claude rate limit was classified; the live posture turn remains unverified.");
  }
  assert.equal(result.status, "completed", result.status === "failed" ? result.error.safeMessage : undefined);
  assert.equal(result.effectiveModel, canonicalModel);
  assert.equal(transport.runtimeEvidence?.requestedModel, requestedModel);
  assert.equal(transport.runtimeEvidence?.apiKeySource, "none");
  assert.equal(transport.runtimeEvidence?.permissionMode, "dontAsk");
  assert.deepEqual(transport.runtimeEvidence?.tools, ["Glob", "Grep", "Read"]);
  assert.deepEqual(transport.runtimeEvidence?.mcpServers, []);
  assert.equal(transport.runtimeEvidence?.extensionInventory.plugins, 0);
  assert.equal(transport.runtimeEvidence?.pluginIsolation?.preflight, "explicitTemporaryDisable");
  assert.equal(transport.runtimeEvidence?.pluginIsolation?.runtimeLoadedPlugins, 0);
  const isolation = transport.runtimeEvidence?.pluginIsolation;
  assert.ok(Number.isSafeInteger(isolation?.verificationRounds) && (isolation?.verificationRounds ?? 0) >= 1);
  // Counts only: plugin names, paths and account data never appear in live output.
  t.diagnostic(`plugin quarantine: builtin=${isolation?.builtinCount} installed=${isolation?.installedCount} ` +
    `verificationRounds=${isolation?.verificationRounds} reviewerLoadedPlugins=${transport.runtimeEvidence?.extensionInventory.plugins}`);
  assert.equal(transport.runtimeEvidence?.extensionIsolation.managedHooks, "unverified");
  assert.ok(transport.runtimeEvidence?.extensionIsolation.evidence.includes("hook-events-monitored"));
  assert.ok(transport.runtimeEvidence?.extensionIsolation.evidence.includes("disable-slash-commands-flag"));
});
