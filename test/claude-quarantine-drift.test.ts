import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { DelegationPacket } from "../src/core/domain.js";
import { ClaudeOneShotTransport } from "../src/providers/claude/one-shot-transport.js";
import { CLAUDE_QUARANTINE_MAX_VERIFICATIONS } from "../src/providers/claude/plugin-quarantine.js";
import { describeLoadedPlugins, type ClaudeLaunchConfig } from "../src/providers/claude/types.js";

// Regression for the post-M7 live-gate drift: Claude can materialize plugins between consecutive startups
// (cached remote flags, claude.ai plugin sync), so a disable set computed from earlier startups can miss one.
const fixtureBinary = { executable: process.execPath, argvPrefix: [resolve(process.cwd(), "test/fixtures/claude-fake.mjs")] } as const;
const packet: DelegationPacket = { task: { goal: "line 1\n& | $() ü ☃", constraints: [], acceptanceCriteria: [] },
  scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] },
  architecture: { decisions: [], invariants: [] }, verification: { requiredTests: [] }, openQuestions: [] };

async function drift(scenario: string) {
  const stateDir = await mkdtemp(join(tmpdir(), "fusion-claude-drift-"));
  const config: ClaudeLaunchConfig = { executablePath: "unused", workspace: process.cwd(),
    model: { id: "alias", effort: "low", maxTurns: 3 }, expectedCanonicalModel: "claude-canonical-fixture",
    posture: "readOnly", timeoutMs: 5_000, sourceEnvironment: { FUSION_FAKE_SCENARIO: scenario,
      FUSION_FAKE_STATE_DIR: stateDir, SystemRoot: process.env.SystemRoot,
      USERPROFILE: resolve(process.cwd(), "test/fixtures/empty-claude-home") } };
  const transport = new ClaudeOneShotTransport(config, undefined, fixtureBinary);
  try {
    const result = await transport.run({ packet, requiredCapabilities: {} });
    const startups = Number(await readFile(join(stateDir, "startups"), "utf8").catch(() => "0"));
    return { result, evidence: transport.runtimeEvidence, startups };
  } finally { await rm(stateDir, { recursive: true, force: true }); }
}

test("a built-in that appears after discovery is found on the reviewer-shaped startup and quarantined", async () => {
  const { result, evidence, startups } = await drift("builtin-materializes");
  assert.equal(result.status, "completed", result.status === "failed" ? result.error.safeMessage : undefined);
  assert.equal(evidence?.pluginIsolation?.runtimeLoadedPlugins, 0, "the reviewer's own init still proves no loaded plugin");
  assert.equal(evidence?.extensionInventory.plugins, 0);
  assert.equal(evidence?.pluginIsolation?.builtinCount, 2);
  assert.equal(evidence?.pluginIsolation?.verificationRounds, 2, "drift stays observable in the evidence");
  assert.equal(startups, 4, "discovery, two verification startups, then the reviewer");
});

test("an account-synced plugin that appears after the inventory read is identified by a refreshed inventory", async () => {
  const { result, evidence } = await drift("synced-materializes");
  assert.equal(result.status, "completed", result.status === "failed" ? result.error.safeMessage : undefined);
  assert.equal(evidence?.pluginIsolation?.runtimeLoadedPlugins, 0);
  assert.equal(evidence?.pluginIsolation?.installedCount, 1);
  assert.equal(evidence?.pluginIsolation?.verificationRounds, 2);
});

test("a plugin that appears without inventory provenance fails closed and is never accepted", async () => {
  const { result, evidence } = await drift("unknown-materializes");
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.kind, "SecurityViolation");
    assert.match(result.error.safeMessage, /absent from its installed inventory \(marketplace=1\)/u);
    assert.doesNotMatch(result.error.safeMessage, /ghost|unlisted|private-path/u);
  }
  assert.equal(evidence, undefined, "no runtime evidence is recorded for a refused launch");
});

test("a plugin set that keeps changing fails closed after bounded verification", async () => {
  const { result, startups } = await drift("never-converges");
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.kind, "SecurityViolation");
    assert.match(result.error.safeMessage, /did not converge/u);
  }
  assert.equal(startups, 1 + CLAUDE_QUARANTINE_MAX_VERIFICATIONS, "discovery plus the bounded verification startups; no reviewer turn");
});

test("a disabled plugin that stays loaded is refused before the reviewer turn", async () => {
  const { result, startups } = await drift("builtin-race");
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.kind, "SecurityViolation");
    assert.match(result.error.safeMessage, /stayed loaded/u);
  }
  assert.equal(startups, 2, "discovery and one verification startup; the reviewer never starts");
});

test("the final posture assertion reports plugin provenance classes without names or paths", async () => {
  const { result } = await drift("plugin");
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.kind, "SecurityViolation");
    assert.match(result.error.safeMessage, /loaded-plugins:1\[other=1\]/u);
    assert.doesNotMatch(result.error.safeMessage, /side-effect|fixture/u);
  }
  assert.equal(describeLoadedPlugins([{ name: "a", path: "builtin", source: "a@builtin" },
    { name: "b", path: "p", source: "b@market" }, { name: "c" }]), "builtin=1,marketplace=1,other=1");
  assert.equal(describeLoadedPlugins([]), "none");
});
