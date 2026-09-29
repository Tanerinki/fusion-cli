import assert from "node:assert/strict";
import { test } from "node:test";
import { FusionFailure } from "../src/core/errors.js";
import {
  CAPABILITY_MANIFEST_VERSION, capabilityManifest, capabilityManifestHash, validateCapabilityManifest,
  validateCapabilityRequest, type CapabilityManifestInput, type ResourceLimits,
} from "../src/core/isolation/capability-manifest.js";
import {
  DENY_ALL_NETWORK, networkPolicy, validateNetworkPolicy,
} from "../src/core/isolation/network-policy.js";
import {
  decidePosture, postureOfProbe, validateBackendProbe, type BackendProbe,
} from "../src/core/isolation/posture.js";
import {
  dominantTerminalCause, isAutoResumable, isTransactionTransitionAllowed, transactionStateFromHistory,
  WROTE_ONCE_CLAIMED, type TransactionState,
} from "../src/core/durability/states.js";

const fails = (fn: () => unknown): void => assert.throws(fn, (e: unknown) => e instanceof FusionFailure);

const LIMITS: ResourceLimits = Object.freeze({ timeoutMs: 60_000, maxProcesses: 8, maxOutputBytes: 1024 * 1024, maxMemoryBytes: null, maxCpuMs: null });
const baseInput = (over: Partial<CapabilityManifestInput> = {}): CapabilityManifestInput => ({
  executionId: "x-abc123", runId: "r-run01", backend: "appcontainer", sandboxIdentity: "fusion.exec.abc",
  readPaths: ["C:\\view\\repo"], writePaths: ["C:\\work\\home"], limits: LIMITS,
  workingDirectory: "C:\\work\\home", policyVersion: "0.6.0", ...over,
});

// ---------------------------------------------------------------- network policy

test("v0.6 network: DENY_ALL is the default and carries no destinations", () => {
  assert.equal(DENY_ALL_NETWORK.mode, "DENY_ALL");
  assert.equal(DENY_ALL_NETWORK.loopback, "deny");
  assert.equal(DENY_ALL_NETWORK.allowed.length, 0);
  fails(() => networkPolicy({ mode: "DENY_ALL", allowed: [{ host: "api.anthropic.com", port: 443 }] }));
});

test("v0.6 network: ALLOWLIST needs a destination, sorts and de-duplicates, refuses a wildcard host", () => {
  fails(() => networkPolicy({ mode: "ALLOWLIST", allowed: [] }));
  const p = networkPolicy({ mode: "ALLOWLIST", allowed: [
    { host: "b.example", port: 443 }, { host: "a.example", port: null }, { host: "b.example", port: 443 }] });
  assert.deepEqual(p.allowed.map(d => d.host), ["a.example", "b.example"]);
  fails(() => networkPolicy({ mode: "ALLOWLIST", allowed: [{ host: "*", port: null }] }));
  fails(() => networkPolicy({ mode: "ALLOWLIST", allowed: [{ host: "https://x.example/y", port: null }] }));
  fails(() => networkPolicy({ mode: "ALLOWLIST", allowed: [{ host: "x.example", port: 70000 }] }));
});

test("v0.6 network: an allowlist policy round-trips through validation", () => {
  const p = networkPolicy({ mode: "ALLOWLIST", loopback: "deny", allowed: [{ host: "api.anthropic.com", port: 443 }] });
  assert.deepEqual(validateNetworkPolicy(JSON.parse(JSON.stringify(p))), p);
  fails(() => validateNetworkPolicy({ mode: "ALLOWLIST", loopback: "deny" }));
});

// ---------------------------------------------------------------- capability manifest

test("v0.6 manifest: is hashed, deep-frozen and round-trips; the hash binds every field", () => {
  const m = capabilityManifest(baseInput());
  assert.equal(m.version, CAPABILITY_MANIFEST_VERSION);
  assert.equal(m.manifestHash, capabilityManifestHash(m));
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.filesystem) && Object.isFrozen(m.filesystem.readPaths));
  const parsed = JSON.parse(JSON.stringify(m));
  assert.deepEqual(validateCapabilityManifest(parsed), m);
});

test("v0.6 manifest: a tampered field is rejected because the stored hash no longer binds it", () => {
  const m = capabilityManifest(baseInput());
  const tampered = { ...JSON.parse(JSON.stringify(m)), workingDirectory: "C:\\work\\elsewhere" };
  // working dir no longer under a write path -> InvalidInput before the hash check even runs
  fails(() => validateCapabilityManifest(tampered));
  // a field the builder accepts but that changes the hash: flip the network, keep the old hash
  const m2 = JSON.parse(JSON.stringify(m));
  m2.network = networkPolicy({ mode: "ALLOWLIST", allowed: [{ host: "evil.example", port: 443 }] });
  assert.throws(() => validateCapabilityManifest(m2), (e: unknown) => e instanceof FusionFailure && e.error.kind === "SecurityViolation");
});

test("v0.6 manifest: least authority — DENY_ALL network and no paths by default", () => {
  const m = capabilityManifest({ executionId: "x-1", runId: "r-1", backend: "appcontainer", sandboxIdentity: "id.1",
    writePaths: ["C:\\w"], limits: LIMITS, workingDirectory: "C:\\w", policyVersion: "0.6.0" });
  assert.equal(m.network.mode, "DENY_ALL");
  assert.equal(m.filesystem.readPaths.length, 0);
  assert.equal(m.filesystem.deniedPaths.length, 0);
});

test("v0.6 manifest: the working directory must be within a writable path", () => {
  fails(() => capabilityManifest(baseInput({ workingDirectory: "C:\\somewhere\\else" })));
  // a subdirectory of a write path is accepted
  const m = capabilityManifest(baseInput({ writePaths: ["C:\\work"], workingDirectory: "C:\\work\\sub" }));
  assert.equal(m.workingDirectory, "C:\\work\\sub");
});

test("v0.6 manifest: relative paths and bad ids are refused", () => {
  fails(() => capabilityManifest(baseInput({ writePaths: ["relative\\path"] })));
  fails(() => capabilityManifest(baseInput({ executionId: "has space" })));
  fails(() => capabilityManifest(baseInput({ policyVersion: "0.6" })));
  fails(() => capabilityManifest(baseInput({ candidateRevision: "not-a-sha" })));
});

test("v0.6 manifest: a candidate revision must be a full digest and is bound", () => {
  const rev = "a".repeat(64);
  const m = capabilityManifest(baseInput({ candidateId: "c1", candidateRevision: rev }));
  assert.equal(m.candidateRevision, rev);
  // changing the revision changes the hash
  const other = capabilityManifest(baseInput({ candidateId: "c1", candidateRevision: "b".repeat(64) }));
  assert.notEqual(m.manifestHash, other.manifestHash);
});

test("v0.6 capability request: bounded, cannot carry a path grant", () => {
  const r = validateCapabilityRequest({ kind: "network", reason: "the provider CLI must reach its API" });
  assert.equal(r.kind, "network");
  fails(() => validateCapabilityRequest({ kind: "network", reason: "x", extra: 1 }));
  fails(() => validateCapabilityRequest({ kind: "grantEverything", reason: "x" }));
});

// ---------------------------------------------------------------- posture

const probe = (over: Partial<BackendProbe> = {}): BackendProbe => ({
  backend: "appcontainer", available: true,
  dimensions: { filesystem: "enforced", network: "enforced", processTree: "enforced" }, notes: ["canaryPassed"], ...over,
});

test("v0.6 posture: HARD only when all three dimensions are OS-enforced", () => {
  assert.equal(postureOfProbe(probe()), "HARD");
  assert.equal(postureOfProbe(probe({ dimensions: { filesystem: "enforced", network: "notProvisioned", processTree: "enforced" } })), "CONFINED");
  assert.equal(postureOfProbe(probe({ dimensions: { filesystem: "unknown", network: "enforced", processTree: "enforced" } })), "UNAVAILABLE");
  assert.equal(postureOfProbe(probe({ available: false })), "UNAVAILABLE");
});

test("v0.6 posture: a HARD request fails closed when the backend cannot satisfy it", () => {
  assert.equal(decidePosture("hard", probe()).satisfied, true);
  const confined = decidePosture("hard", probe({ dimensions: { filesystem: "enforced", network: "notProvisioned", processTree: "enforced" } }));
  assert.equal(confined.satisfied, false);
  assert.equal(confined.failure, "NETWORK_DENIED");
  const none = decidePosture("hard", probe({ available: false, notes: ["adminRequired"] }));
  assert.equal(none.satisfied, false);
  assert.equal(none.failure, "SANDBOX_SETUP_REQUIRED");
});

test("v0.6 posture: confined accepts HARD or CONFINED; bestEffort always proceeds but never claims HARD", () => {
  assert.equal(decidePosture("confined", probe()).satisfied, true);
  assert.equal(decidePosture("confined", probe({ dimensions: { filesystem: "enforced", network: "notProvisioned", processTree: "enforced" } })).satisfied, true);
  assert.equal(decidePosture("confined", probe({ available: false })).satisfied, false);
  const best = decidePosture("bestEffort", probe({ available: false }));
  assert.equal(best.satisfied, true);
  assert.notEqual(best.established, "HARD");
});

test("v0.6 posture: an untrusted probe is validated before it decides posture", () => {
  fails(() => validateBackendProbe({ backend: "appcontainer", available: true, dimensions: { filesystem: "enforced" }, notes: [] }));
  fails(() => validateBackendProbe({ backend: "wut", available: true, dimensions: { filesystem: "enforced", network: "enforced", processTree: "enforced" }, notes: [] }));
  const ok = validateBackendProbe(JSON.parse(JSON.stringify(probe())));
  assert.equal(ok.backend, "appcontainer");
});

// ---------------------------------------------------------------- durable / recovery states

test("v0.6 recovery: only SAFE_TO_REPLAY and SAFE_TO_RESUME may resume without a human; UNKNOWN never", () => {
  assert.equal(isAutoResumable("SAFE_TO_REPLAY"), true);
  assert.equal(isAutoResumable("SAFE_TO_RESUME"), true);
  assert.equal(isAutoResumable("REQUIRES_REVALIDATION"), false);
  assert.equal(isAutoResumable("REQUIRES_HUMAN"), false);
  assert.equal(isAutoResumable("BLOCKED"), false);
  assert.equal(isAutoResumable("UNKNOWN"), false);
});

test("v0.6 transaction: the state machine allows only the documented order", () => {
  const good: TransactionState[] = ["PREPARED", "CLAIMED", "APPLYING", "VERIFYING", "COMMITTED"];
  assert.equal(transactionStateFromHistory(good), "COMMITTED");
  assert.ok(isTransactionTransitionAllowed("APPLYING", "ROLLBACK_REQUIRED"));
  assert.ok(!isTransactionTransitionAllowed("PREPARED", "APPLYING"));
  fails(() => transactionStateFromHistory(["PREPARED", "APPLYING"]));
  fails(() => transactionStateFromHistory(["PREPARED", "CLAIMED", "COMMITTED"]));
});

test("v0.6 transaction: nothing before CLAIMED has written; from CLAIMED on the approval is spent", () => {
  assert.equal(WROTE_ONCE_CLAIMED("PREPARED"), false);
  assert.equal(WROTE_ONCE_CLAIMED("FAILED"), false);
  assert.equal(WROTE_ONCE_CLAIMED("CLAIMED"), true);
  assert.equal(WROTE_ONCE_CLAIMED("APPLYING"), true);
  assert.equal(WROTE_ONCE_CLAIMED("RECOVERY_REQUIRED"), true);
});

test("v0.6 terminal cause: a security violation dominates cancellation noise", () => {
  assert.equal(dominantTerminalCause(["CANCELLED", "SECURITY_VIOLATION", "TIMEOUT"]), "SECURITY_VIOLATION");
  assert.equal(dominantTerminalCause(["CANCELLED", "TIMEOUT"]), "TIMEOUT");
  assert.equal(dominantTerminalCause(["SANDBOX_DENIED", "PROVIDER_FAILED"]), "SANDBOX_DENIED");
  assert.equal(dominantTerminalCause([]), undefined);
});
