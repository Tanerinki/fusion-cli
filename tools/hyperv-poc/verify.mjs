// Fusion v0.6 Hyper-V PoC — verify (computed verdict). Reads result-<runId>.json, maps raw canary outcomes to the flat
// ALLOWED/DENIED/PASS fields via classify(), computes the verdict with evaluate() (never manual), and prints a bounded
// human report. UNTESTED-on-hardware for the inputs; the mapping + verdict logic are unit-tested in CI.
import { readFileSync } from "node:fs";
import { classify, evaluate, evaluateNetwork, networkVerdict } from "./evaluator.mjs";

/** Maps a raw PoC result document into the flat field map evaluate() consumes. Sockets use classify(); fs/lifecycle are labels. */
export function flatten(doc) {
  const net = doc?.network ?? {}, broker = doc?.broker ?? {}, fs = doc?.fs ?? doc?.filesystem ?? {}, lc = doc?.lifecycle ?? {};
  const ctrl = doc?.hostControls ?? {};
  // A network canary may be a bare outcome string (simple tests) OR {worker, hostControl}. When a host control is
  // available (either embedded or in the parallel hostControls map), use networkVerdict so a silent drop is only a
  // proven DENY when the host positive control reached the target; otherwise classify() alone (timeout → UNKNOWN).
  const socket = k => {
    const v = net[k];
    if (v !== null && typeof v === "object") return networkVerdict(v.worker, v.hostControl);
    if (ctrl[k] !== undefined) return networkVerdict(v, ctrl[k]);
    return classify(v);
  };
  const brk = k => classify(broker[k]);
  const fsAllow = v => (v === "ok" || v === "ALLOWED" ? "ALLOWED" : v === "blocked" || v === "DENIED" ? "DENIED" : v === "NOT_RUN" ? "NOT_RUN" : "UNKNOWN");
  const pass = v => (v === "PASS" ? "PASS" : v === "FAIL" ? "FAIL" : "UNKNOWN");
  return {
    // network canaries A..H + DNS (all measured from inside the worker with raw sockets)
    brokerEndpoint: socket("brokerEndpoint"), brokerWrongPort: socket("brokerWrongPort"),
    hostLoopbackIpv4: socket("hostLoopbackIpv4"), hostOtherPort: socket("hostOtherPort"), hostOtherAddress: socket("hostOtherAddress"),
    lanAccess: socket("lanAccess"), directInternet: socket("directInternet"), directProviderBypass: socket("directProviderBypass"),
    rawSocketBypass: socket("rawSocketBypass"), dnsGateway: socket("dnsGateway"),
    // broker-side canaries I,J (measured on the host)
    brokerProviderRoute: brk("brokerProviderRoute"), unauthorizedDestinationThroughBroker: brk("unauthorizedDestinationThroughBroker"),
    // filesystem
    viewRead: fsAllow(fs.viewRead), viewWrite: fsAllow(fs.viewWrite), scratchWrite: fsAllow(fs.scratchWrite),
    primaryAccess: fsAllow(fs.primaryAccess), siblingAccess: fsAllow(fs.siblingAccess),
    controlPlaneAccess: fsAllow(fs.controlPlaneAccess), hostProfileAccess: fsAllow(fs.hostProfileAccess),
    // lifecycle / isolation
    processTreeContainment: pass(lc.processTreeContainment), forcedKillCleanup: pass(lc.forcedKillCleanup), workerCleanup: pass(lc.workerCleanup),
    noStaleNetworkPolicy: pass(lc.noStaleNetworkPolicy), noStaleMounts: pass(lc.noStaleMounts), noStaleProcess: pass(lc.noStaleProcess),
    noBroadHostMount: pass(lc.noBroadHostMount), noDockerPipe: pass(lc.noDockerPipe), hostWorkspaceUncontaminated: pass(lc.hostWorkspaceUncontaminated),
  };
}

export function verifyDocument(doc) {
  const flat = flatten(doc);
  const { verdict, reasons } = evaluate(flat);
  const net = evaluateNetwork(flat);
  return { verdict, reasons, flat, network: net };
}

// CLI: node verify.mjs <result.json>
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("verify.mjs")) {
  const path = process.argv[2];
  if (!path) { console.error("usage: node verify.mjs <result.json>"); process.exit(64); }
  const { verdict, reasons, network } = verifyDocument(JSON.parse(readFileSync(path, "utf8")));
  // The focused network-boundary verdict drives BROKER_ONLY_NETWORK_BOUNDARY; the full verdict also needs FS proof.
  console.log(`BROKER_ONLY_NETWORK_BOUNDARY=${network.verdict === "PASS" ? "PROVEN" : "NOT_PROVEN"} (network verdict: ${network.verdict})`);
  for (const r of network.reasons) console.log(`  [net] ${r}`);
  console.log(`HYPERV_POC=${verdict} (full HARD: network + filesystem + lifecycle)`);
  for (const r of reasons) console.log(`  - ${r}`);
  process.exit(verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2);
}
