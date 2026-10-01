import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const mod = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc", "cleanup-check.mjs");
const { compareCleanup, isRunImage } = await import(pathToFileURL(mod).href);

const RUN = "t1", PREFIX = "FusionV06Poc-t1", EP = "A1B2C3D4-0000-0000-0000-000000000001";
const cleanPost: {
  dockerNetworks: string[]; containers: string[]; images: string[]; hnsEndpointIds: string[]; alivePids: number[]; pocAddresses: string[];
} = {
  dockerNetworks: ["nat", "none", "Default Switch"], containers: ["editorial-postgres"],
  images: ["mcr.microsoft.com/windows/nanoserver:ltsc2025"], hnsEndpointIds: ["99999999-0000-0000-0000-000000000999"],
  alivePids: [], pocAddresses: [],
};
const base = () => ({ prefix: PREFIX, runId: RUN, endpointId: EP, listenerPids: [111, 222], prestate: { dockerNetworks: ["nat", "none", "Default Switch"] }, poststate: structuredClone(cleanPost) });

test("v0.6 Hyper-V cleanup: a fully-reverted host passes every owned-object check", () => {
  const r = compareCleanup(base());
  assert.equal(r.ok, true, r.reasons.join("; "));
});

test("v0.6 Hyper-V cleanup: a surviving PoC network / container / image / listener / endpoint each FAILs its check", () => {
  const net = base(); net.poststate.dockerNetworks.push(`${PREFIX}-net`);
  assert.equal(compareCleanup(net).checks.noPocNetwork, false);
  const con = base(); con.poststate.containers.push(PREFIX);
  assert.equal(compareCleanup(con).checks.noPocContainer, false);
  const img = base(); img.poststate.images.push(`fusion-hv-poc-img:${RUN}`);
  assert.equal(compareCleanup(img).checks.noPocImage, false);
  const pid = base(); pid.poststate.alivePids.push(222);
  assert.equal(compareCleanup(pid).checks.listenersGone, false);
  const ep = base(); ep.poststate.hnsEndpointIds.push(EP.toLowerCase());
  assert.equal(compareCleanup(ep).checks.workerEndpointGone, false, "the EXACT recorded endpoint id must be gone, not just a name prefix");
});

test("v0.6 Hyper-V cleanup: a changed NON-PoC network set is reported (untouched-state check), but unrelated state is not asserted", () => {
  const changed = base(); changed.poststate.dockerNetworks = ["nat", "none"]; // 'Default Switch' vanished — not ours to lose
  assert.equal(compareCleanup(changed).checks.nonPocNetworksUnchanged, false);
  // A leftover PoC address fails its own check.
  const addr = base(); addr.poststate.pocAddresses = ["10.250.37.1"];
  assert.equal(compareCleanup(addr).checks.pocAddressGone, false);
});

test("v0.6 Hyper-V cleanup: isRunImage matches only the exact per-run tag", () => {
  assert.equal(isRunImage("fusion-hv-poc-img:t1", "t1"), true);
  assert.equal(isRunImage("fusion-hv-poc-img:other", "t1"), false);
  assert.equal(isRunImage("nanoserver:ltsc2025", "t1"), false);
});
