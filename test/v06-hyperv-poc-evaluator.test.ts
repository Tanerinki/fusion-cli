import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
// The evaluator lives in the (production-separate) PoC harness; imported here only to unit-test its pure verdict logic.
const mod = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc", "evaluator.mjs");
const { evaluate, evaluateNetwork, classify, networkVerdict, isPocResource, selectForCleanup, pocPrefix,
  REQUIRED_ALLOW, REQUIRED_DENY, REQUIRED_PASS, REQUIRED_NETWORK_ALLOW, REQUIRED_NETWORK_DENY, REQUIRED_NETWORK_PASS } = await import(pathToFileURL(mod).href);
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

/** A network-only result where every focused network requirement is satisfied (the only shape that may be network-PASS). */
function netGood(): Record<string, string> {
  const r: Record<string, string> = {};
  for (const k of REQUIRED_NETWORK_ALLOW) r[k] = "ALLOWED";
  for (const k of REQUIRED_NETWORK_DENY) r[k] = "DENIED";
  for (const k of REQUIRED_NETWORK_PASS) r[k] = "PASS";
  return r;
}

test("v0.6 Hyper-V PoC evaluator: the focused network verdict proves the broker-only boundary without the FS grants", () => {
  assert.equal(evaluateNetwork(netGood()).verdict, "PASS");
  // The FS view/scratch grants are NOT part of the network verdict.
  assert.ok(!REQUIRED_NETWORK_ALLOW.includes("viewRead") && !REQUIRED_NETWORK_DENY.includes("primaryAccess"));
  // But the FULL HARD verdict still needs them, so netGood alone is INCOMPLETE for evaluate().
  assert.equal(evaluate(netGood()).verdict, "INCOMPLETE", "the full PoC is not PASS until filesystem confinement is also proven");
});

test("v0.6 Hyper-V PoC evaluator: a single reachable forbidden target FAILs the network verdict", () => {
  const escape = netGood(); escape.directProviderBypass = "ALLOWED";
  assert.equal(evaluateNetwork(escape).verdict, "FAIL");
  const incomplete = netGood(); incomplete.lanAccess = "UNKNOWN";
  assert.equal(evaluateNetwork(incomplete).verdict, "INCOMPLETE");
});

test("v0.6 Hyper-V PoC evaluator: networkVerdict needs a host positive control to turn a worker timeout into a proven DENY", () => {
  // Worker reached it → ALLOWED (an escape for a deny-target).
  assert.equal(networkVerdict("connected", "connected"), "ALLOWED");
  // Worker actively refused → DENIED without any control.
  assert.equal(networkVerdict("refused", "timeout"), "DENIED");
  // Worker timed out BUT the host reached the same target → isolation proven → DENIED.
  assert.equal(networkVerdict("timeout", "connected"), "DENIED");
  // Worker timed out AND the host also couldn't reach it → cannot prove anything → UNKNOWN (INCOMPLETE, never PASS).
  assert.equal(networkVerdict("timeout", "timeout"), "UNKNOWN");
  assert.equal(networkVerdict("timeout", "not_run"), "UNKNOWN");
});

test("v0.6 Hyper-V PoC verify: a {worker,hostControl} canary pair is a proven DENY only with the host control", () => {
  const paired = {
    network: {
      brokerEndpoint: { worker: "connected", hostControl: "connected" },
      brokerWrongPort: { worker: "timeout", hostControl: "connected" },
      hostLoopbackIpv4: { worker: "refused", hostControl: "refused" },
      hostOtherPort: { worker: "timeout", hostControl: "connected" },
      hostOtherAddress: { worker: "timeout", hostControl: "connected" },
      lanAccess: { worker: "timeout", hostControl: "connected" },
      directInternet: { worker: "timeout", hostControl: "connected" },
      directProviderBypass: { worker: "timeout", hostControl: "connected" },
      rawSocketBypass: { worker: "timeout", hostControl: "connected" },
      dnsGateway: { worker: "timeout", hostControl: "answered" },
    },
    broker: { brokerProviderRoute: "connected", unauthorizedDestinationThroughBroker: "refused" },
    filesystem: { viewRead: "ok", viewWrite: "blocked", scratchWrite: "ok", primaryAccess: "blocked", siblingAccess: "blocked", controlPlaneAccess: "blocked", hostProfileAccess: "blocked" },
    lifecycle: { processTreeContainment: "PASS", forcedKillCleanup: "PASS", workerCleanup: "PASS", noStaleNetworkPolicy: "PASS", noStaleMounts: "PASS", noStaleProcess: "PASS", noBroadHostMount: "PASS", noDockerPipe: "PASS", hostWorkspaceUncontaminated: "PASS" },
  };
  assert.equal(verifyDocument(paired).verdict, "PASS", "every deny proven by a host control; broker route ok");
  // Drop the host control on one blocked target → that target is no longer a proven deny → INCOMPLETE.
  const noControl = structuredClone(paired); noControl.network.lanAccess = { worker: "timeout", hostControl: "timeout" };
  assert.equal(verifyDocument(noControl).verdict, "INCOMPLETE", "a worker timeout with no host positive control is never a proven deny");
  // Worker actually reached a forbidden target → FAIL regardless of control.
  const escape = structuredClone(paired); escape.network.directProviderBypass = { worker: "connected", hostControl: "connected" };
  assert.equal(verifyDocument(escape).verdict, "FAIL", "the worker reaching the provider directly is an escape → FAIL");
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
  network: { brokerEndpoint: "connected", brokerWrongPort: "refused", hostLoopbackIpv4: "blocked", hostOtherPort: "blocked",
    hostOtherAddress: "no-route", lanAccess: "no-route", directInternet: "blocked", directProviderBypass: "blocked",
    rawSocketBypass: "blocked", dnsGateway: "blocked" },
  broker: { brokerProviderRoute: "connected", unauthorizedDestinationThroughBroker: "refused" },
  filesystem: { viewRead: "ok", viewWrite: "blocked", scratchWrite: "ok", primaryAccess: "blocked", siblingAccess: "blocked",
    controlPlaneAccess: "blocked", hostProfileAccess: "blocked" },
  lifecycle: { processTreeContainment: "PASS", forcedKillCleanup: "PASS", workerCleanup: "PASS", noStaleNetworkPolicy: "PASS",
    noStaleMounts: "PASS", noStaleProcess: "PASS", noBroadHostMount: "PASS", noDockerPipe: "PASS", hostWorkspaceUncontaminated: "PASS" },
};

test("v0.6 Hyper-V PoC verify: a clean raw result maps to PASS", () => {
  assert.equal(verifyDocument(goodDoc).verdict, "PASS");
});

test("v0.6 Hyper-V PoC verify: a reachable unrelated boundary maps to FAIL; a timeout/NOT_RUN maps to INCOMPLETE (never a silent deny)", () => {
  const escape = structuredClone(goodDoc); escape.network.directInternet = "connected";
  assert.equal(verifyDocument(escape).verdict, "FAIL", "Internet reachable → escape → FAIL");
  const rawEscape = structuredClone(goodDoc); rawEscape.network.rawSocketBypass = "connected";
  assert.equal(verifyDocument(rawEscape).verdict, "FAIL", "a raw-socket bypass reaching its target → FAIL");
  const dnsEscape = structuredClone(goodDoc); dnsEscape.network.dnsGateway = "answered";
  assert.equal(verifyDocument(dnsEscape).verdict, "FAIL", "gateway DNS answering → DNS path open → FAIL");
  const timeout = structuredClone(goodDoc); timeout.network.hostLoopbackIpv4 = "timeout";
  assert.equal(verifyDocument(timeout).verdict, "INCOMPLETE", "a timeout is not a proven deny → INCOMPLETE, never PASS");
  const notRun = structuredClone(goodDoc); notRun.network.directProviderBypass = "not_run";
  assert.equal(verifyDocument(notRun).verdict, "INCOMPLETE", "a canary that did not run is never PASS");
  const brokerDown = structuredClone(goodDoc); brokerDown.broker.brokerProviderRoute = "refused";
  assert.equal(verifyDocument(brokerDown).verdict, "FAIL", "if the broker cannot reach the synthetic provider the route is not proven");
});
