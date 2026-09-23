import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_ROLES } from "../src/core/domain.js";
import type { AuthStatus, CapabilitySnapshot, TurnResult, VerificationResult } from "../src/core/domain.js";
import { meetsCapabilities } from "../src/core/capabilities.js";

test("core roles are provider-neutral and capability eligibility fails closed", () => {
  assert.deepEqual(AGENT_ROLES, ["Lead", "Worker", "Explorer", "Reviewer", "Auditor"]);
  const snapshot: CapabilitySnapshot = {
    provider: "replaceable-provider", transport: "oneshot", observedAt: "2026-09-23T00:00:00Z",
    runtimeVersion: "1", persistentSessions: false, structuredOutput: true,
    filesystem: { read: true, write: false }, shell: { available: false, sandboxed: false },
    approvalCallback: false, protocolCancellation: false, usageReporting: false,
    modelIdentityReadback: true, subscriptionLaneReadback: false,
  };
  assert.equal(meetsCapabilities(snapshot, { structuredOutput: true, filesystem: { read: true, write: false } }), true);
  assert.equal(meetsCapabilities(snapshot, { subscriptionLaneReadback: true }), false);
  assert.equal(meetsCapabilities(snapshot, { filesystem: { write: true } }), false);
  assert.equal(meetsCapabilities({ ...snapshot, subscriptionLaneReadback: "unknown" },
    { subscriptionLaneReadback: true }), false);
  assert.equal(meetsCapabilities({ ...snapshot, filesystem: { read: "unknown", write: false } },
    { filesystem: { read: true } }), false);
  assert.equal(meetsCapabilities(snapshot, { unknownFeature: true } as unknown as Parameters<typeof meetsCapabilities>[1]), false);
});

// Compile-time checks: these assignments must remain rejected by the domain unions.
// @ts-expect-error completed turns cannot carry errors
const invalidTurn: TurnResult = { status: "completed", effectiveProvider: "p", effectiveModel: "m", artifactRefs: [], output: {} as never, error: { kind: "ProcessFailure", safeMessage: "x", retryable: false } };
// @ts-expect-error failed turns require an error
const missingTurnError: TurnResult = { status: "failed", effectiveProvider: "p", effectiveModel: "m", artifactRefs: [] };
// @ts-expect-error an authenticated status cannot have an unknown lane
const invalidAuth: AuthStatus = { state: "authenticated", lane: "unknown", observedAt: "now", evidence: [] };
// @ts-expect-error successful verification requires exit code zero
const invalidVerification: VerificationResult = { passed: true, exitCode: 1 };
void [invalidTurn, missingTurnError, invalidAuth, invalidVerification];
