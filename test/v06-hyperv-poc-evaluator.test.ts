import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
// The evaluator lives in the (production-separate) PoC harness; imported here only to unit-test its pure verdict logic.
const mod = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc", "evaluator.mjs");
const { evaluate, classify, isPocResource, selectForCleanup, pocPrefix, REQUIRED_ALLOW, REQUIRED_DENY, REQUIRED_PASS } = await import(pathToFileURL(mod).href);
const verifyMod = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc", "verify.mjs");
const { verifyDocument } = await import(pathToFileURL(verifyMod).href);

/** A results object where every requirement is satisfied (the only shape that may be PASS). */
function allGood(): Record<string, string> {
  const r: Record<string, string> = {};
  for (const k of REQUIRED_ALLOW) r[k] = "ALLOWED";
  for (const k of REQUIRED_DENY) r[k] = "DENIED";
  for (const k of REQUIRED_PASS) r[k] = "PASS";
  return r;
}

test("v0.6 Hyper-V PoC evaluator: classify treats blocked/refused/no-route as DENIED, connected as ALLOWED, timeout as UNKNOWN", () => {
  assert.equal(classify("blocked"), "DENIED");
  assert.equal(classify("refused"), "DENIED");
  assert.equal(classify("no-route"), "DENIED");
  assert.equal(classify("connected"), "ALLOWED");
  assert.equal(classify("timeout"), "UNKNOWN", "a timeout is never counted as a proven deny");
  assert.equal(classify("anything-else"), "UNKNOWN");
});

test("v0.6 Hyper-V PoC evaluator: a fully-satisfied result is PASS", () => {
  assert.equal(evaluate(allGood()).verdict, "PASS");
});

test("v0.6 Hyper-V PoC evaluator: any missing/UNKNOWN required field forces INCOMPLETE (never PASS)", () => {
  const r = allGood(); delete r.directInternet;
  assert.equal(evaluate(r).verdict, "INCOMPLETE", "a missing boundary is never promoted to PASS");
  const r2 = allGood(); r2.hostLoopbackIpv4 = "UNKNOWN";
  assert.equal(evaluate(r2).verdict, "INCOMPLETE");
});

test("v0.6 Hyper-V PoC evaluator: a violated negative boundary forces FAIL (the harness's escape detector)", () => {
  const r = allGood(); r.directInternet = "ALLOWED";
  assert.equal(evaluate(r).verdict, "FAIL", "a reachable Internet boundary is an escape → FAIL");
  const r2 = allGood(); r2.brokerWrongPort = "ALLOWED";
  assert.equal(evaluate(r2).verdict, "FAIL", "wrong-port reachable → destination-port enforcement broken → FAIL");
  const r3 = allGood(); r3.primaryAccess = "ALLOWED";
  assert.equal(evaluate(r3).verdict, "FAIL", "primary checkout reachable → FS boundary broken → FAIL");
  const r4 = allGood(); r4.processTreeContainment = "FAIL";
  assert.equal(evaluate(r4).verdict, "FAIL");
});

test("v0.6 Hyper-V PoC evaluator: a missing positive control is not PASS", () => {
  const r = allGood(); r.brokerEndpoint = "UNKNOWN";
  assert.equal(evaluate(r).verdict, "INCOMPLETE");
  const r2 = allGood(); r2.brokerEndpoint = "DENIED";
  assert.equal(evaluate(r2).verdict, "FAIL", "if the broker is not reachable the PoC cannot be PASS");
});

test("v0.6 Hyper-V PoC harness: cleanup selection matches ONLY this run's PoC resources", () => {
  const runId = "abc123";
  assert.equal(pocPrefix(runId), "FusionV06Poc-abc123");
  assert.equal(isPocResource("FusionV06Poc-abc123-net", runId), true);
  assert.equal(isPocResource("FusionV06Poc-abc123", runId), true);
  assert.equal(isPocResource("FusionV06Poc-other-net", runId), false, "another run's resources are never touched");
  assert.equal(isPocResource("nat", runId), false, "unrelated HNS networks are never touched");
  assert.equal(isPocResource("Default Switch", runId), false, "the host's switch is never touched");
  assert.deepEqual(selectForCleanup(["FusionV06Poc-abc123-net", "nat", "Default Switch", "FusionV06Poc-xyz-net"], runId),
    ["FusionV06Poc-abc123-net"], "cleanup removes only this run's PoC resources");
  assert.throws(() => pocPrefix("bad id!"), /runId/u, "a malformed run id is refused");
});

// ---------------------------------------------------------------- verify.mjs maps raw canary results to a computed verdict

const goodDoc = {
  network: { brokerEndpoint: "connected", brokerWrongPort: "refused", hostLoopbackIpv4: "blocked", lanAccess: "no-route",
    directInternet: "blocked", directProviderBypass: "blocked" },
  filesystem: { viewRead: "ok", viewWrite: "blocked", scratchWrite: "ok", primaryAccess: "blocked", siblingAccess: "blocked",
    controlPlaneAccess: "blocked", hostProfileAccess: "blocked" },
  lifecycle: { processTreeContainment: "PASS", workerCleanup: "PASS", noStaleNetworkPolicy: "PASS", noStaleMounts: "PASS", noStaleProcess: "PASS" },
};

test("v0.6 Hyper-V PoC verify: a clean raw result maps to PASS", () => {
  assert.equal(verifyDocument(goodDoc).verdict, "PASS");
});

test("v0.6 Hyper-V PoC verify: a reachable unrelated boundary maps to FAIL; a timeout maps to INCOMPLETE (never a silent deny)", () => {
  const escape = structuredClone(goodDoc); escape.network.directInternet = "connected";
  assert.equal(verifyDocument(escape).verdict, "FAIL", "Internet reachable → escape → FAIL");
  const timeout = structuredClone(goodDoc); timeout.network.hostLoopbackIpv4 = "timeout";
  assert.equal(verifyDocument(timeout).verdict, "INCOMPLETE", "a timeout is not a proven deny → INCOMPLETE, never PASS");
});
