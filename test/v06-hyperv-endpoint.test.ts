import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const mod = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc", "endpoint.mjs");
const { findWorkerEndpoint, workerSelectorFromInspect, asEndpointArray } = await import(pathToFileURL(mod).href);

const NET = "C9A91D84-0403-43AE-A0F1-081D3DEF81E5";
const endpoints = [
  { Id: "EP-OTHER-1", VirtualNetwork: "11111111-1111-1111-1111-111111111111", IPAddress: "172.31.96.9" },
  { Id: "EP-WORKER", VirtualNetwork: NET, IPAddress: "10.250.37.22" },
  { Id: "EP-OTHER-2", VirtualNetwork: NET, IPAddress: "10.250.37.5" },
];

test("v0.6 Hyper-V endpoint: the worker endpoint is found by (networkId, ip) — exactly one match", () => {
  const r = findWorkerEndpoint(endpoints, { networkId: NET, ipAddress: "10.250.37.22" });
  assert.equal(r.status, "FOUND");
  assert.equal(r.endpointId, "EP-WORKER");
});

test("v0.6 Hyper-V endpoint: a GUID in braces / different case still matches the network id", () => {
  const r = findWorkerEndpoint(endpoints, { networkId: `{${NET.toLowerCase()}}`, ipAddress: "10.250.37.22" });
  assert.equal(r.status, "FOUND");
  assert.equal(r.endpointId, "EP-WORKER");
});

test("v0.6 Hyper-V endpoint: no match → NONE, never a guess", () => {
  assert.equal(findWorkerEndpoint(endpoints, { networkId: NET, ipAddress: "10.250.37.99" }).status, "NONE");
  assert.equal(findWorkerEndpoint([], { networkId: NET, ipAddress: "10.250.37.22" }).status, "NONE");
});

test("v0.6 Hyper-V endpoint: two endpoints with the same (net, ip) → AMBIGUOUS, never pick one", () => {
  const dup = [...endpoints, { Id: "EP-DUP", VirtualNetwork: NET, IPAddress: "10.250.37.22" }];
  const r = findWorkerEndpoint(dup, { networkId: NET, ipAddress: "10.250.37.22" });
  assert.equal(r.status, "AMBIGUOUS");
  assert.deepEqual([...r.candidates].sort(), ["EP-DUP", "EP-WORKER"]);
});

test("v0.6 Hyper-V endpoint: malformed listing / selector → MALFORMED (the elevated script applies nothing)", () => {
  assert.equal(findWorkerEndpoint([{ VirtualNetwork: NET, IPAddress: "10.250.37.22" }], { networkId: NET, ipAddress: "10.250.37.22" }).status, "MALFORMED");
  assert.equal(findWorkerEndpoint(["nope"], { networkId: NET, ipAddress: "10.250.37.22" }).status, "MALFORMED");
  assert.equal(findWorkerEndpoint(endpoints, { ipAddress: "10.250.37.22" }).status, "MALFORMED");
  assert.equal(findWorkerEndpoint(endpoints, { networkId: NET }).status, "MALFORMED");
});

test("v0.6 Hyper-V endpoint: asEndpointArray coerces a single object or null safely", () => {
  assert.equal(asEndpointArray(null).length, 0);
  assert.equal(asEndpointArray({ Id: "x" }).length, 1);
  assert.equal(asEndpointArray([{ Id: "x" }, { Id: "y" }]).length, 2);
});

test("v0.6 Hyper-V endpoint: the selector is extracted from docker inspect for the PoC network only", () => {
  const inspect = [{ NetworkSettings: { Networks: {
    "fusion-hv-poc-net": { IPAddress: "10.250.37.22", NetworkID: "docker-ep-id" },
    bridge: { IPAddress: "172.0.0.2" },
  } } }];
  const sel = workerSelectorFromInspect(inspect, "fusion-hv-poc-net", NET);
  assert.equal(sel.ok, true);
  assert.equal(sel.ipAddress, "10.250.37.22");
  assert.equal(sel.networkId, NET, "prefers the explicit HNS id over Docker's endpoint id");
  // Then discovery joins them:
  assert.equal(findWorkerEndpoint(endpoints, sel).endpointId, "EP-WORKER");
});

test("v0.6 Hyper-V endpoint: a worker not attached to the PoC network, or with no IP, is refused", () => {
  const notAttached = [{ NetworkSettings: { Networks: { bridge: { IPAddress: "172.0.0.2" } } } }];
  assert.equal(workerSelectorFromInspect(notAttached, "fusion-hv-poc-net", NET).ok, false);
  const noIp = [{ NetworkSettings: { Networks: { "fusion-hv-poc-net": { IPAddress: "" } } } }];
  assert.equal(workerSelectorFromInspect(noIp, "fusion-hv-poc-net", NET).ok, false);
});
