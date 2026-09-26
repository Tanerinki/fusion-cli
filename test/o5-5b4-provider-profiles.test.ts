import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidatedRuntimeVersion, profileForAdapterKind, providerProfile, providerProfiles,
  transportProfile } from "../src/runtime/provider-profiles.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { CLAUDE_VALIDATED_EXTENSION_VERSION } from "../src/providers/claude/types.js";
import { VERIFIED_EXEC_WEB_DISABLE_VERSION } from "../src/providers/muse/types.js";

test("O5.5B4 known providers resolve; unknown providers return undefined, never a fabricated default", () => {
  assert.equal(providerProfile("claude")?.displayName, "Claude Code (subscription)");
  assert.equal(providerProfile("muse")?.id, "muse");
  for (const unknown of ["", "openai", "gpt", "Claude", "CLAUDE", "muse ", "unknown-provider"])
    assert.equal(providerProfile(unknown), undefined, unknown);
  assert.deepEqual(providerProfiles().map(p => p.id), ["claude", "muse"]);
});

test("O5.5B4 capability, transport and auth-lane lookups are correct", () => {
  const claude = providerProfile("claude")!;
  assert.deepEqual([...claude.authLanes], ["subscription", "subscriptionToken"]);
  assert.equal(claude.executableBasename, "claude.exe");
  assert.equal(transportProfile("claude", "claude-one-shot")?.structuredTurns, true);
  assert.equal(transportProfile("claude", "no-such")?.structuredTurns, undefined);
  const muse = providerProfile("muse")!;
  assert.deepEqual([...muse.authLanes], ["subscription"]);
  assert.equal(muse.executableBasename, undefined);
  assert.equal(transportProfile("muse", "muse-exec")?.structuredTurns, true);
  assert.equal(transportProfile("muse", "muse-msp")?.structuredTurns, false);
  assert.equal(profileForAdapterKind("claude-one-shot")?.id, "claude");
  assert.equal(profileForAdapterKind("muse-msp")?.id, "muse");
  assert.equal(profileForAdapterKind("nonexistent"), undefined);
});

test("O5.5B4 compatibility is honest: validated versions match, unknowns are unconstrained not guessed", () => {
  assert.equal(isValidatedRuntimeVersion("claude", "claude-one-shot", CLAUDE_VALIDATED_EXTENSION_VERSION), true);
  assert.equal(isValidatedRuntimeVersion("claude", "claude-one-shot", "9.9.9"), false);
  assert.equal(isValidatedRuntimeVersion("muse", "muse-exec", VERIFIED_EXEC_WEB_DISABLE_VERSION), true);
  assert.equal(isValidatedRuntimeVersion("muse", "muse-exec", "0.0.0"), false);
  // MSP makes no version claim: unconstrained, so no version is treated as validated.
  assert.equal(transportProfile("muse", "muse-msp")?.compatibility.kind, "unconstrained");
  assert.equal(isValidatedRuntimeVersion("muse", "muse-msp", VERIFIED_EXEC_WEB_DISABLE_VERSION), false);
  assert.equal(isValidatedRuntimeVersion("unknown", "x", "1"), false);
});

test("O5.5B4 profiles are deeply frozen and immutable", () => {
  const claude = providerProfile("claude")!;
  assert.ok(Object.isFrozen(claude) && Object.isFrozen(claude.transports) && Object.isFrozen(claude.authLanes));
  assert.ok(claude.transports.every(Object.isFrozen));
  assert.throws(() => { (claude as { id: string }).id = "x"; }, TypeError);
  assert.throws(() => { (claude.authLanes as string[]).push("api"); }, TypeError);
});

test("O5.5B4 profile data is the single source of truth: it agrees with the registry and adapter constants", () => {
  // Every adapter kind a profile claims is actually registered by the default provider registry.
  const registered = new Set(defaultRegistry().factories.keys());
  for (const profile of providerProfiles())
    for (const kind of profile.adapterKinds)
      assert.ok(registered.has(kind), `adapter kind ${kind} of ${profile.id} must be registered`);
  // The validated versions in the profile match the authoritative adapter constants, so drift is caught here.
  const claudeVersions = transportProfile("claude", "claude-one-shot")!.compatibility;
  assert.equal(claudeVersions.kind === "validatedVersions" && claudeVersions.versions.includes(CLAUDE_VALIDATED_EXTENSION_VERSION), true);
  const museVersions = transportProfile("muse", "muse-exec")!.compatibility;
  assert.equal(museVersions.kind === "validatedVersions" && museVersions.versions.includes(VERIFIED_EXEC_WEB_DISABLE_VERSION), true);
});
