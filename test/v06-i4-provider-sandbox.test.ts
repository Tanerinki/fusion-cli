import assert from "node:assert/strict";
import { test } from "node:test";
import { FusionFailure } from "../src/core/errors.js";
import { decideProviderPosture, providerCapabilityManifest, providerEndpointAllowlist, providerEnvironment } from "../src/app/provider-sandbox.js";
import { validateCapabilityManifest } from "../src/core/isolation/capability-manifest.js";
import type { BackendProbe } from "../src/core/isolation/posture.js";

const base = () => providerCapabilityManifest({
  executionId: "x-1", runId: "r-1", candidateId: "c1", backend: "appcontainer", sandboxIdentity: "fusion.exec.c1",
  viewPath: "C:\\fusion\\view", scratchPath: "C:\\fusion\\scratch",
  deniedPaths: ["C:\\repo\\primary", "C:\\fusion\\sibling", "C:\\repo\\.fusion", "C:\\Users\\me\\.ssh"],
  allowedEnvNames: ["SystemRoot", "PATH", "TEMP"],
});
const probe = (over: Partial<BackendProbe> = {}): BackendProbe => ({ backend: "appcontainer", available: true,
  dimensions: { filesystem: "enforced", network: "enforced", processTree: "enforced" }, notes: ["canaryPassed"], ...over });

test("v0.6 I4: the provider manifest grants only the view (read) and scratch (write), denies the rest, DENY_ALL network", () => {
  const m = base();
  assert.deepEqual(m.filesystem.readPaths, ["C:\\fusion\\view"]);
  assert.deepEqual(m.filesystem.writePaths, ["C:\\fusion\\scratch"]);
  assert.equal(m.workingDirectory, "C:\\fusion\\scratch");
  assert.equal(m.network.mode, "DENY_ALL");
  assert.ok(m.filesystem.deniedPaths.includes("C:\\repo\\primary"));
  assert.equal(m.manifestHash, validateCapabilityManifest(JSON.parse(JSON.stringify(m))).manifestHash);
});

test("v0.6 I4: least authority — no allowed env names yield an empty child environment; credential-shaped host vars are dropped", () => {
  const m = base();
  const { env, report } = providerEnvironment({ SystemRoot: "C:\\Windows", PATH: "p", TEMP: "t", ANTHROPIC_API_KEY: "secret", SSH_AUTH_SOCK: "s" }, m);
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "SystemRoot", "TEMP"]);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.ok(report.droppedSensitiveNames.includes("ANTHROPIC_API_KEY"));
});

test("v0.6 I4: fail-closed — a HARD request the backend cannot satisfy is refused, never silently unsandboxed", () => {
  assert.equal(decideProviderPosture("hard", probe()).satisfied, true);
  const noNetwork = decideProviderPosture("hard", probe({ dimensions: { filesystem: "enforced", network: "notProvisioned", processTree: "enforced" } }));
  assert.equal(noNetwork.satisfied, false);
  assert.equal(noNetwork.failure, "NETWORK_DENIED");
  const unavailable = decideProviderPosture("hard", probe({ available: false, notes: ["backendMissing"] }));
  assert.equal(unavailable.satisfied, false);
  assert.equal(unavailable.established, "UNAVAILABLE");
});

test("v0.6 I4: an ALLOWLIST for a provider endpoint is a single narrow destination (only usable once WFP-provisioned)", () => {
  const p = providerEndpointAllowlist("api.provider.example", 443);
  assert.equal(p.mode, "ALLOWLIST");
  assert.deepEqual(p.allowed, [{ host: "api.provider.example", port: 443 }]);
  assert.equal(p.loopback, "deny");
});

test("v0.6 I4: the working directory is bound to scratch, and a malformed execution id is refused at manifest build", () => {
  const m = providerCapabilityManifest({ executionId: "x-1", runId: "r-1", backend: "appcontainer", sandboxIdentity: "id", viewPath: "C:\\v", scratchPath: "C:\\s", allowedEnvNames: [] });
  assert.equal(m.workingDirectory, "C:\\s");
  assert.throws(() => providerCapabilityManifest({ executionId: "bad id", runId: "r-1", backend: "appcontainer", sandboxIdentity: "id", viewPath: "C:\\v", scratchPath: "C:\\s", allowedEnvNames: [] }),
    (e: unknown) => e instanceof FusionFailure);
});
