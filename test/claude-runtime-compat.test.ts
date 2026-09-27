import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { CapabilityRequirement, DelegationPacket } from "../src/core/domain.js";
import type { LaunchRecord } from "../src/platform/process/supervisor.js";
import { ClaudeOneShotTransport } from "../src/providers/claude/one-shot-transport.js";
import { claudeCapability } from "../src/providers/claude/posture.js";
import { CANARY_FILES, claudeRuntimeSupport, recordedAttestation } from "../src/providers/claude/runtime-attestation.js";
import { CLAUDE_VALIDATED_EXTENSION_VERSION, type ClaudeLaunchConfig } from "../src/providers/claude/types.js";
import { fusionTemporaryBase } from "../src/platform/fs/temporary.js";

/**
 * v0.2.2 — Claude runtime compatibility is capability-based: a later patch of the validated release line is accepted when
 * THIS process proved its read-only posture mechanically (init-only canary startups, no model call) and every turn proves
 * the rest again; anything unproven, and every other release line, fails closed with a plain-language refusal. Offline:
 * the real transport against the deterministic fake binary, which can report another runtime version and simulate each
 * broken control in Fusion's canary workspace.
 */
const fixture = resolve(process.cwd(), "test/fixtures/claude-fake.mjs");
const fixtureBinary = { executable: process.execPath, argvPrefix: [fixture] } as const;
const packet: DelegationPacket = { task: { goal: "line 1\n& | $() ü ☃", constraints: [], acceptanceCriteria: [] },
  scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] }, architecture: { decisions: [], invariants: [] },
  verification: { requiredTests: [] }, openQuestions: [] };
/** Exactly what a read-only Lead or analysis turn demands of Claude (`ClaudeAdapter.requirements`). */
const LEAD: CapabilityRequirement = { structuredOutput: true, webToolsDisabled: true, modelIdentityReadback: true, subscriptionLaneReadback: true,
  approvalEscalationDisabled: true, personalContextDisabled: true, extensionsQuarantined: true, filesystem: { read: true, write: false },
  shell: { available: false } };

interface Run { launches: LaunchRecord[]; transport: ClaudeOneShotTransport }
function transport(env: Readonly<Record<string, string>>, launches: LaunchRecord[] = [], over: Partial<ClaudeLaunchConfig> = {}): ClaudeOneShotTransport {
  return new ClaudeOneShotTransport({ executablePath: "unused", workspace: process.cwd(), model: { id: "alias", effort: "low", maxTurns: 3 },
    expectedCanonicalModel: "claude-canonical-fixture", posture: "readOnly", timeoutMs: 10_000,
    sourceEnvironment: { FUSION_FAKE_SCENARIO: "ok", SystemRoot: process.env.SystemRoot ?? "", USERPROFILE: resolve(process.cwd(), "test/fixtures/empty-claude-home"),
      ...env }, launchObserver: launch => { launches.push(launch); }, ...over }, undefined, fixtureBinary);
}
async function turn(env: Readonly<Record<string, string>>, over: Partial<ClaudeLaunchConfig> = {}): Promise<Run & { result: Awaited<ReturnType<ClaudeOneShotTransport["run"]>> }> {
  const launches: LaunchRecord[] = [];
  const t = transport(env, launches, over);
  return { launches, transport: t, result: await t.run({ packet, requiredCapabilities: LEAD }) };
}
const canaryLaunches = (launches: readonly LaunchRecord[]) => launches.filter(l => /fusion-claude-attest-/u.test(l.cwd));
const turnLaunches = (launches: readonly LaunchRecord[]) => launches.filter(l => l.purpose === "providerTurn");
const failed = (result: Awaited<ReturnType<ClaudeOneShotTransport["run"]>>) => result.status === "failed" ? result.error : undefined;
async function noCanaryLeft(): Promise<void> {
  assert.deepEqual((await readdir(fusionTemporaryBase())).filter(name => name.startsWith("fusion-claude-attest-")), [], "every canary workspace is removed");
}

// ---------------------------------------------------------------- the policy

test("runtime support: the recorded release, later patches of its line (attested), and nothing else", () => {
  assert.equal(CLAUDE_VALIDATED_EXTENSION_VERSION, "2.1.280");
  const cases: Array<[string, string]> = [["2.1.280", "validated"], ["2.1.281", "attestable"], ["2.1.283", "attestable"], ["2.1.9999", "attestable"],
    ["2.1.279", "unsupported"], ["2.1.0", "unsupported"], ["2.2.0", "unsupported"], ["2.0.999", "unsupported"], ["3.1.283", "unsupported"],
    ["2.1.283-beta", "unsupported"], ["v2.1.283", "unsupported"], ["", "unsupported"], ["unknown", "unsupported"]];
  for (const [version, kind] of cases) assert.equal(claudeRuntimeSupport(version).kind, kind, version);
  // Source-code knowledge alone never grants a posture: an unattested patch stays unknown, an attestation binds one version.
  const posture = (version: string, attested?: ReturnType<typeof recordedAttestation>) => {
    const caps = claudeCapability(version, "runtimeReadback", "unknown", attested);
    return [caps.webToolsDisabled, caps.personalContextDisabled, caps.extensionsQuarantined, caps.approvalEscalationDisabled, caps.filesystem.write,
      caps.shell.available, caps.modelIdentityReadback, caps.subscriptionLaneReadback];
  };
  assert.deepEqual(posture("2.1.280"), [true, true, true, true, false, false, true, true]);
  assert.ok(posture("2.1.283").every(value => value === "unknown"), "an unattested patch proves nothing");
  assert.ok(posture("2.1.283", { ...recordedAttestation("2.1.284"), method: "runtimeCanary" }).every(value => value === "unknown"),
    "an attestation of another version proves nothing");
  assert.deepEqual(posture("2.1.283", { ...recordedAttestation("2.1.283"), method: "runtimeCanary" }), [true, true, true, true, false, false, true, true]);
  // The canary is harmless: its hooks only create marker files, its MCP command does not exist.
  assert.ok(Object.values(CANARY_FILES).join("\n").includes("fusion-canary-mcp-server-that-does-not-exist"));
  assert.doesNotMatch(Object.values(CANARY_FILES).join("\n"), /rm |del |curl|https?:|powershell/iu);
});

// ---------------------------------------------------------------- accepted runtimes

test("the recorded release stays accepted exactly as before: no canary, recorded validation", async () => {
  const { result, launches, transport: t } = await turn({});
  assert.equal(result.status, "completed", JSON.stringify(failed(result)));
  assert.equal(t.runtimeEvidence?.runtimeVersion, "2.1.280");
  assert.equal(t.runtimeEvidence?.extensionIsolation.attestation, "recordedValidation");
  assert.deepEqual(t.runtimeEvidence?.extensionIsolation.evidence.slice(0, 2), ["claude-2.1.280", "recorded-live-validation"]);
  assert.equal(canaryLaunches(launches).length, 0, "no extra process for the recorded release");
  assert.deepEqual(launches.map(l => l.purpose), ["providerAuthReadback", "providerInventory", "providerInitProbe", "providerInitProbe", "providerTurn"]);
});

test("a later patch with identical proven capabilities is accepted: the canary runs once, init-only, then every turn re-proves the posture",
  async () => {
    const launches: LaunchRecord[] = [];
    const t = transport({ FUSION_FAKE_VERSION: "2.1.283" }, launches);
    const first = await t.run({ packet, requiredCapabilities: LEAD });
    assert.equal(first.status, "completed", JSON.stringify(failed(first)));
    assert.equal(t.runtimeEvidence?.runtimeVersion, "2.1.283");
    assert.equal(t.runtimeEvidence?.extensionIsolation.attestation, "runtimeCanary");
    assert.deepEqual(t.runtimeEvidence?.extensionIsolation.evidence.slice(0, 2), ["claude-2.1.283", "runtime-canary-attestation"]);
    const caps = t.capabilities();
    assert.deepEqual([caps.webToolsDisabled, caps.personalContextDisabled, caps.extensionsQuarantined, caps.filesystem.write, caps.shell.available],
      [true, true, true, false, false]);
    // The canary: inventory, discovery and quarantine verification in a Fusion-owned workspace — never a model turn there.
    const canary = canaryLaunches(launches);
    assert.deepEqual(canary.map(l => l.purpose), ["providerInventory", "providerInitProbe", "providerInitProbe"]);
    assert.ok(canary.every(l => l.cwd !== process.cwd()));
    assert.equal(turnLaunches(launches).length, 1);
    assert.ok(turnLaunches(launches).every(l => !/fusion-claude-attest-/u.test(l.cwd)));
    // Attested once per runtime: the next turn re-proves the per-turn posture, not the canary.
    const second = await t.run({ packet, requiredCapabilities: LEAD });
    assert.equal(second.status, "completed");
    assert.equal(canaryLaunches(launches).length, 3);
    await noCanaryLeft();
  });

test("routing's launch-time facts and `fusion doctor --probe` use the same attestation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-install-"));
  try {
    const install = async (version: string) => {
      const pkg = join(dir, version);
      await mkdir(join(pkg, "bin"), { recursive: true });
      await writeFile(join(pkg, "bin", "claude.exe"), "");
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version }));
      return join(pkg, "bin", "claude.exe");
    };
    const exe = await install("2.1.283");
    const good = transport({ FUSION_FAKE_VERSION: "2.1.283" }, [], { executablePath: exe });
    const facts = await good.launchCapabilities();
    assert.deepEqual([facts.runtimeVersion, facts.webToolsDisabled, facts.extensionsQuarantined, facts.personalContextDisabled], ["2.1.283", true, true, true]);
    const attestation = await good.attestRuntime();
    assert.deepEqual([attestation.version, attestation.method], ["2.1.283", "runtimeCanary"]);
    assert.ok(attestation.checks.includes("project-settings-hook-not-run") && attestation.checks.includes("zero-plugins-after-quarantine"));
    // A runtime whose canary fails keeps an unknown posture: routing never accepts unknown.
    const broken = await transport({ FUSION_FAKE_VERSION: "2.1.283", FUSION_FAKE_CANARY: "skill-leak" }, [], { executablePath: exe }).launchCapabilities();
    assert.deepEqual([broken.webToolsDisabled, broken.extensionsQuarantined, broken.personalContextDisabled], ["unknown", "unknown", "unknown"]);
    // The recorded release needs no canary for its launch facts; doctor may still run it, and it passes.
    const recorded = transport({}, [], { executablePath: await install("2.1.280") });
    assert.equal((await recorded.launchCapabilities()).extensionsQuarantined, true);
    assert.equal((await recorded.attestRuntime()).version, "2.1.280");
    await assert.rejects(transport({ FUSION_FAKE_SCENARIO: "version-upgrade" }).attestRuntime(),
      (error: unknown) => error instanceof Error && /Fusion has not verified the safety posture of Claude Code 2\.2\.0/u.test(error.message) &&
        /fusion doctor --probe/u.test(error.message));
    await noCanaryLeft();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- refused runtimes

for (const canary of ["hook-runs", "hook-event", "mcp-leak", "skill-leak", "agent-leak", "command-leak", "permission-leak", "version-drift"]) {
  test(`a later patch missing one proven control is refused before any model turn: canary ${canary}`, async () => {
    const { result, launches } = await turn({ FUSION_FAKE_VERSION: "2.1.283", FUSION_FAKE_CANARY: canary });
    const error = failed(result);
    assert.equal(error?.kind, "CapabilityUnavailable", JSON.stringify(result));
    assert.match(error!.safeMessage, /^Fusion has not verified the safety posture of Claude Code 2\.1\.283 \(its canary check failed: .+\), so it did not send anything to the model\. Run `fusion doctor --probe` to check this runtime now\.$/u);
    assert.equal(turnLaunches(launches).length, 0, "nothing reached the model");
    await noCanaryLeft();
  });
}

test("every other release line is refused in plain language before any model turn; the recorded release is not a bypass", async () => {
  for (const env of [{ FUSION_FAKE_SCENARIO: "version-upgrade" }, { FUSION_FAKE_VERSION: "2.1.279" }, { FUSION_FAKE_VERSION: "3.1.283" }]) {
    const { result, launches } = await turn(env);
    const error = failed(result);
    assert.equal(error?.kind, "CapabilityUnavailable", JSON.stringify(env));
    assert.match(error!.safeMessage, /Fusion only checks Claude Code 2\.1\.x releases from 2\.1\.280 on; supporting another release line needs a Fusion update/u);
    assert.match(error!.safeMessage, /Run `fusion doctor --probe`/u);
    assert.deepEqual([turnLaunches(launches).length, canaryLaunches(launches).length], [0, 0]);
  }
  // On the recorded release, every per-turn check still applies.
  for (const [scenario, kind] of [["shell-tool", "SecurityViolation"], ["plugin", "SecurityViolation"], ["init-api-key", "AuthMismatch"]] as const)
    assert.equal(failed((await turn({ FUSION_FAKE_SCENARIO: scenario })).result)?.kind, kind, scenario);
});

test("an attested patch still proves every per-turn fact: tools, plugins, MCP, hooks, model identity, subscription lane", async () => {
  for (const [scenario, kind] of [["shell-tool", "SecurityViolation"], ["write-tool", "SecurityViolation"], ["mcp", "SecurityViolation"],
    ["plugin", "SecurityViolation"], ["plugin-tool", "SecurityViolation"], ["hook-active", "SecurityViolation"], ["hooks-field", "SecurityViolation"],
    ["permission", "SecurityViolation"], ["model-mismatch", "ProviderIdentityMismatch"], ["init-api-key", "AuthMismatch"],
    ["auth-api-key", "AuthMismatch"], ["auth-third-party", "AuthMismatch"], ["overage-active", "SecurityViolation"]] as const) {
    const { result } = await turn({ FUSION_FAKE_VERSION: "2.1.283", FUSION_FAKE_SCENARIO: scenario });
    assert.equal(failed(result)?.kind, kind, scenario);
  }
  // An API key in the environment never even reaches a Claude process (billing guard, before any spawn).
  const keyed = await turn({ FUSION_FAKE_VERSION: "2.1.283", ANTHROPIC_API_KEY: "sk-ant-not-a-real-key-000000000000" });
  assert.equal(result(keyed), "failed");
  assert.equal(keyed.launches.length, 0);
});
const result = (run: Awaited<ReturnType<typeof turn>>) => run.result.status;

test("plugin isolation must actually be proven on an attested patch: a plugin that stays loaded refuses the runtime", async () => {
  for (const scenario of ["builtin-required-stays", "builtin-race"]) {
    const { result: outcome, launches } = await turn({ FUSION_FAKE_VERSION: "2.1.283", FUSION_FAKE_SCENARIO: scenario });
    const error = failed(outcome);
    assert.ok(error !== undefined && ["CapabilityUnavailable", "SecurityViolation"].includes(error.kind), scenario);
    assert.match(error!.safeMessage, /plugin/iu);
    assert.equal(turnLaunches(launches).length, 0, scenario);
  }
  await noCanaryLeft();
});

test("spoofed or incomplete runtime evidence is refused: another version at the turn, a malformed version, missing init fields", async () => {
  // The turn reports a version other than the one the preflight and the canary proved.
  const drift = await turn({ FUSION_FAKE_VERSION: "2.1.283", FUSION_FAKE_TURN_VERSION: "2.1.284" });
  assert.equal(failed(drift.result)?.kind, "CapabilityUnavailable");
  assert.match(failed(drift.result)!.safeMessage, /reported another version than the one Fusion verified before it/u);
  // A version string that is not a release number is never classified.
  assert.equal(failed((await turn({ FUSION_FAKE_VERSION: "2.1.283 (patched)" })).result)?.kind, "SecurityViolation");
  for (const [scenario, kind] of [["no-init", "ProtocolError"], ["duplicate-frame-key", "ProtocolError"], ["init-no-key-source", "AuthMismatch"],
    ["malformed", "ProtocolError"]] as const)
    assert.equal(failed((await turn({ FUSION_FAKE_VERSION: "2.1.283", FUSION_FAKE_SCENARIO: scenario })).result)?.kind, kind, scenario);
});
