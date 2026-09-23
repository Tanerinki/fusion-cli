import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStatus, DelegationPacket } from "../src/core/domain.js";
import { MuseExecTransport } from "../src/providers/muse/exec-transport.js";
import { MuseMspTransport, type ApprovalOutcome } from "../src/providers/muse/msp-transport.js";
import { MuseRpcHost } from "../src/providers/muse/protocol/rpc-host.js";
import { RESULT_PACKET_SCHEMA } from "../src/providers/muse/structured-output.js";
import { capability, type MuseLaunchConfig } from "../src/providers/muse/types.js";

const fixture = resolve(process.cwd(), "test/fixtures/muse-fake.mjs");
const fixtureBinary = { executable: process.execPath, argvPrefix: [fixture] } as const;
const packet: DelegationPacket = { task: { goal: "fixture", constraints: [], acceptanceCriteria: [] },
  scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] },
  architecture: { decisions: [], invariants: [] }, verification: { requiredTests: [] }, openQuestions: [] };
const auth: AuthStatus = { state: "authenticated", lane: "subscription", observedAt: new Date().toISOString(), evidence: ["fixture"] };
function config(scenario: string, forMsp = false): MuseLaunchConfig {
  return { binaryDirectory: "unused", versionFile: "unused", workspace: process.cwd(), provider: "meta",
    model: { id: "muse-spark-1.3", effort: "low", maxTurns: 4 }, posture: "readOnly",
    sourceEnvironment: { FUSION_FAKE_SCENARIO: scenario, SystemRoot: process.env.SystemRoot },
    timeoutMs: 2_000, ...(forMsp ? {} : { maxModelSteps: 4 }) };
}
function exec(scenario: string): MuseExecTransport { return new MuseExecTransport(config(scenario), async () => auth, undefined, fixtureBinary); }
/**
 * Per-request budget for the fake host. It includes spawning a Node fixture process, which can take seconds on a
 * loaded Windows machine, so only the test that exercises the timeout itself uses a short budget.
 */
const MSP_FIXTURE_REQUEST_BUDGET_MS = 10_000;
function msp(scenario: string, policy?: () => ApprovalOutcome, requestTimeoutMs = MSP_FIXTURE_REQUEST_BUDGET_MS): MuseMspTransport {
  return new MuseMspTransport(config(scenario, true), policy, undefined, requestTimeoutMs, fixtureBinary);
}

for (const [scenario, status, kind] of [
  ["ok", "completed", ""], ["model-mismatch", "failed", "ProviderIdentityMismatch"],
  ["provider-mismatch", "failed", "ProviderIdentityMismatch"], ["failed", "failed", "ProcessFailure"],
  ["cancelled", "cancelled", "Cancelled"], ["malformed-jsonl", "failed", "ProtocolError"],
  ["missing-terminal", "failed", "ProtocolError"], ["malformed-packet", "failed", "MalformedOutput"],
  ["schema-failure", "failed", "MalformedOutput"], ["nonzero", "failed", "ProcessFailure"],
  ["missing-identity", "failed", "ProviderIdentityMismatch"],
] as const) {
  test(`Muse Exec ${scenario}`, async () => {
    const result = await exec(scenario).run({ packet, requiredCapabilities: { filesystem: { read: true } },
      outputSchema: RESULT_PACKET_SCHEMA });
    assert.equal(result.status, status);
    if (result.status === "completed") { assert.equal(result.output.changes.summary, "fixture"); assert.equal(result.effectiveModel, "muse-spark-1.3"); }
    else assert.equal(result.error.kind, kind);
  });
}
test("Muse Exec separates stderr and blocks unsafe environment before spawn", async () => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "fusion-muse-evidence-test-"));
  try {
    const result = await exec("ok").run({ packet, requiredCapabilities: {}, outputSchema: RESULT_PACKET_SCHEMA, evidenceDirectory });
    assert.equal(result.status, "completed");
    assert.match(await readFile(result.artifactRefs[1]!, "utf8"), /diagnostic/);
    assert.doesNotMatch(await readFile(result.artifactRefs[0]!, "utf8"), /fixture diagnostic/);
  } finally { await rm(evidenceDirectory, { recursive: true, force: true }); }
  const blocked = { ...config("ok"), sourceEnvironment: { META_API_KEY: "secret", FUSION_FAKE_SCENARIO: "ok" } };
  const bad = await new MuseExecTransport(blocked, async () => auth, undefined, fixtureBinary).run({ packet, requiredCapabilities: {} });
  assert.equal(bad.status, "failed"); if (bad.status === "failed") assert.equal(bad.error.kind, "BillingBlocked");
  assert.deepEqual(bad.artifactRefs, []);
});
test("Muse Exec cleans default attempts and retains both retry attempts when caller owns evidence", async () => {
  const before = new Set((await readdir(tmpdir())).filter(x => x.startsWith("fusion-muse-exec-")));
  const result = await exec("ok").run({ packet, requiredCapabilities: {} });
  assert.equal(result.status, "completed"); assert.deepEqual(result.artifactRefs, []);
  const defaultRetry = await exec("malformed-packet").run({ packet, requiredCapabilities: {}, malformedOutputRetries: 1 });
  assert.equal(defaultRetry.status, "failed"); assert.deepEqual(defaultRetry.artifactRefs, []);
  assert.deepEqual((await readdir(tmpdir())).filter(x => x.startsWith("fusion-muse-exec-") && !before.has(x)), []);
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "fusion-muse-evidence-test-"));
  try {
    const retried = await exec("malformed-packet").run({ packet, requiredCapabilities: {}, malformedOutputRetries: 1, evidenceDirectory });
    assert.equal(retried.status, "failed"); assert.equal(retried.artifactRefs.length, 4);
    assert.equal(new Set(retried.artifactRefs.map(x => resolve(x, ".."))).size, 2);
    assert.deepEqual((await readdir(evidenceDirectory)).filter(x => x.startsWith("attempt-")).length, 2);
  } finally { await rm(evidenceDirectory, { recursive: true, force: true }); }
  const after = (await readdir(tmpdir())).filter(x => x.startsWith("fusion-muse-exec-") && !before.has(x));
  assert.deepEqual(after, []);
});
test("Muse Exec web-disable eligibility is bound to verified binary version", () => {
  const known = capability(config("ok"), "muse-exec", "1.3.0-R3401.1");
  const upgraded = capability(config("ok"), "muse-exec", "1.3.0-R3402.0");
  assert.equal(known.webToolsDisabled, true);
  assert.deepEqual(known.webToolsDisabledEvidence, { source: "launchFlag", versionVerified: true });
  assert.equal(upgraded.webToolsDisabled, "unknown");
  assert.deepEqual(upgraded.webToolsDisabledEvidence, { source: "launchFlag", versionVerified: false });
});
test("Muse Exec rejects writer posture", async () => {
  const result = await new MuseExecTransport({ ...config("ok"), posture: "writer" }, async () => auth, undefined, fixtureBinary).run({ packet, requiredCapabilities: {} });
  assert.equal(result.status, "failed"); if (result.status === "failed") assert.equal(result.error.kind, "CapabilityUnavailable");
});
test("Muse Exec pre-aborted signal prevents launch", async () => {
  const controller = new AbortController(); controller.abort();
  const result = await exec("ok").run({ packet, requiredCapabilities: {}, signal: controller.signal });
  assert.equal(result.status, "cancelled"); assert.deepEqual(result.artifactRefs, []);
});

test("Muse MSP initializes, probes, reads account and effective session, completes turn", async () => {
  const transport = msp("ok");
  try {
    const caps = await transport.capabilities(); assert.equal(caps.persistentSessions, true);
    assert.equal(caps.schemaFingerprint, `sha256:${"a".repeat(64)}`);
    assert.equal((await transport.authStatus()).lane, "subscription");
    const id = await transport.createSession({ persistentSessions: true, subscriptionLaneReadback: true });
    const result = await transport.runTurn(id, packet);
    assert.equal(result.status, "completed");
    if (result.status === "completed") assert.equal(result.output.changes.summary, "fixture");
    assert.equal(await transport.usage(id), null);
  } finally { await transport.close(); }
});
test("Muse MSP keeps subscription quota telemetry separate from cost", async () => {
  const transport = msp("usage-present");
  try { const id = await transport.createSession({}); const usage = await transport.usage(id);
    assert.equal(usage?.subscription?.window.usedPercent, 17);
    assert.equal(usage?.estimatedListCostUsd, undefined);
  } finally { await transport.close(); }
});
test("Muse MSP full reviewer web restriction remains unknown and ineligible", async () => {
  const transport = msp("ok");
  try { assert.equal((await transport.capabilities()).webToolsDisabled, "unknown");
    await assert.rejects(() => transport.createSession({ webToolsDisabled: true }), /required capability/i);
  } finally { await transport.close(); }
});
test("Muse MSP missing method is unavailable, but account read remains usable", async () => {
  const transport = msp("missing-method");
  try {
    assert.equal((await transport.capabilities()).persistentSessions, false);
    assert.equal((await transport.authStatus()).lane, "subscription");
    await assert.rejects(() => transport.createSession({}), /required method set/i);
  } finally { await transport.close(); }
});
test("Muse MSP rejects wrong auth lane", async () => {
  const transport = msp("wrong-auth");
  try { await assert.rejects(() => transport.createSession({}), /account login/i); }
  finally { await transport.close(); }
});
for (const scenario of ["model-mismatch", "provider-mismatch"] as const) {
  test(`Muse MSP rejects effective ${scenario}`, async () => {
    const transport = msp(scenario);
    try { await assert.rejects(() => transport.createSession({}), /Effective (model|provider)/i); }
    finally { await transport.close(); }
  });
}
for (const [scenario, status, kind] of [["turn-failed","failed","ProcessFailure"], ["turn-cancelled","cancelled","Cancelled"]] as const) {
  test(`Muse MSP ${scenario}`, async () => {
    const transport = msp(scenario);
    try { const id = await transport.createSession({}); const result = await transport.runTurn(id, packet);
      assert.equal(result.status, status); assert.equal(result.error.kind, kind);
    } finally { await transport.close(); }
  });
}
for (const outcome of ["Deny", "Abort"] as const) {
  test(`Muse MSP approval/request and approval/requested deduplicate ${outcome}`, async () => {
    const transport = msp("approval-hang", () => outcome);
    try { const id = await transport.createSession({}); const result = await transport.runTurn(id, packet);
      // M7: a policy veto is a security outcome, never reported as a user cancellation.
      assert.equal(result.status, "failed");
      if (result.status === "failed") { assert.equal(result.error.kind, "SecurityViolation"); assert.equal(result.error.retryable, false); }
    } finally { await transport.close(); }
  });
}
test("Muse MSP approval/requested server request gets receipt and one negative decision", async () => {
  const transport = msp("approval-requested-id", () => "Deny");
  try { const id = await transport.createSession({}); const result = await transport.runTurn(id, packet);
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.kind, "SecurityViolation");
    assert.equal((await transport.authStatus()).lane, "subscription");
  } finally { await transport.close(); }
});
test("Muse MSP ignores approvals after a committed terminal", async () => {
  const transport = msp("approval-after-terminal");
  try { const id = await transport.createSession({});
    assert.equal((await transport.runTurn(id, packet)).status, "completed");
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal((await transport.authStatus()).lane, "subscription");
  } finally { await transport.close(); }
});
test("Muse RPC late, duplicate and impossible response diagnostics are bounded", async () => {
  const host = new MuseRpcHost(undefined, 500);
  host.start({ executable: process.execPath, argvPrefix: [fixture], env: config("ok").sourceEnvironment! },
    ["serve", "--disable-write", "--disable-shell"], process.cwd());
  try {
    await assert.rejects(() => host.request("fusion/delay", undefined, 25), /timed out/i);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(await host.request("fusion/echo", { value: "next" }), { echo: "next" });
    assert.deepEqual(await host.request("fusion/duplicate"), { first: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(host.diagnostics.lateResponses, 2);
    assert.equal(host.diagnostics.pendingRequests, 0);
    await assert.rejects(() => host.request("fusion/impossible"), /malformed JSON-RPC/i);
    assert.equal(host.diagnostics.impossibleResponses, 3);
    assert.equal(host.diagnostics.pendingRequests, 0);
  } finally { await host.forceStop(); }
});
for (const scenario of ["approval-malformed", "approval-stale"] as const) {
  test(`Muse MSP fails closed on ${scenario}`, async () => {
    const transport = msp(scenario);
    try { const id = await transport.createSession({}); const result = await transport.runTurn(id, packet);
      assert.notEqual(result.status, "completed");
    } finally { await transport.close(); }
  });
}
test("Muse MSP cancel accepted yields cancelled terminal", async () => {
  const transport = msp("cancel-accepted");
  try { const id = await transport.createSession({}); const resultPromise = transport.runTurn(id, packet);
    await new Promise(resolve => setTimeout(resolve, 50)); await transport.cancel(id);
    assert.equal((await resultPromise).status, "cancelled");
  } finally { await transport.close(); }
});
test("Muse MSP pre-aborted turn is not submitted", async () => {
  const transport = msp("ok");
  try { const id = await transport.createSession({}); const controller = new AbortController(); controller.abort();
    assert.equal((await transport.runTurn(id, packet, controller.signal)).status, "cancelled");
  } finally { await transport.close(); }
});
test("Muse MSP cancel timeout forces host cleanup", async () => {
  const transport = msp("cancel-timeout");
  try { const id = await transport.createSession({}); const resultPromise = transport.runTurn(id, packet);
    await new Promise(resolve => setTimeout(resolve, 50)); await transport.cancel(id);
    assert.notEqual((await resultPromise).status, "completed");
  } finally { await transport.close(); }
});
for (const scenario of ["host-dies", "malformed-rpc"] as const) {
  test(`Muse MSP ${scenario} rejects pending work`, async () => {
    const transport = msp(scenario);
    try { const id = await transport.createSession({}); const result = await transport.runTurn(id, packet);
      assert.notEqual(result.status, "completed");
    } finally { await transport.close(); }
  });
}
test("Muse MSP request timeout is bounded", async () => {
  // The fixture never answers session/read; every earlier request must still complete within the budget.
  const transport = msp("request-timeout", undefined, 2_000);
  const started = Date.now();
  try { await assert.rejects(() => transport.createSession({}), /session\/read timed out/i); }
  finally { await transport.close(); }
  assert.ok(Date.now() - started < MSP_FIXTURE_REQUEST_BUDGET_MS, "the hung request is bounded by its own budget");
});
test("Muse MSP rejects incompatible writer posture before host launch", async () => {
  const transport = new MuseMspTransport({ ...config("ok", true), posture: "writer" }, undefined, undefined, 250, fixtureBinary);
  await assert.rejects(() => transport.capabilities(), /writer isolation/i);
});
test("Muse MSP rejects an unenforceable model-step limit before launch", async () => {
  const transport = new MuseMspTransport({ ...config("ok", true), maxModelSteps: 4 }, undefined, undefined, 250, fixtureBinary);
  await assert.rejects(() => transport.createSession({}), /model-step limit/i);
});
