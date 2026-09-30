// Fusion v0.6 Hyper-V PoC — verify (computed verdict). Reads result-<runId>.json, maps raw canary outcomes to the flat
// ALLOWED/DENIED/PASS fields via classify(), computes the verdict with evaluate() (never manual), and prints a bounded
// human report. UNTESTED-on-hardware for the inputs; the mapping + verdict logic are unit-tested in CI.
import { readFileSync } from "node:fs";
import { classify, evaluate } from "./evaluator.mjs";

/** Maps a raw PoC result document into the flat field map evaluate() consumes. Sockets use classify(); fs/lifecycle are labels. */
export function flatten(doc) {
  const net = doc?.network ?? {}, fs = doc?.fs ?? doc?.filesystem ?? {}, lc = doc?.lifecycle ?? {};
  const socket = k => classify(net[k]);
  const fsAllow = v => (v === "ok" || v === "ALLOWED" ? "ALLOWED" : v === "blocked" || v === "DENIED" ? "DENIED" : "UNKNOWN");
  const pass = v => (v === "PASS" ? "PASS" : v === "FAIL" ? "FAIL" : "UNKNOWN");
  return {
    brokerEndpoint: socket("brokerEndpoint"), brokerWrongPort: socket("brokerWrongPort"),
    hostLoopbackIpv4: socket("hostLoopbackIpv4"), lanAccess: socket("lanAccess"),
    directInternet: socket("directInternet"), directProviderBypass: socket("directProviderBypass"),
    viewRead: fsAllow(fs.viewRead), viewWrite: fsAllow(fs.viewWrite), scratchWrite: fsAllow(fs.scratchWrite),
    primaryAccess: fsAllow(fs.primaryAccess), siblingAccess: fsAllow(fs.siblingAccess),
    controlPlaneAccess: fsAllow(fs.controlPlaneAccess), hostProfileAccess: fsAllow(fs.hostProfileAccess),
    processTreeContainment: pass(lc.processTreeContainment), workerCleanup: pass(lc.workerCleanup),
    noStaleNetworkPolicy: pass(lc.noStaleNetworkPolicy), noStaleMounts: pass(lc.noStaleMounts), noStaleProcess: pass(lc.noStaleProcess),
  };
}

export function verifyDocument(doc) {
  const flat = flatten(doc);
  const { verdict, reasons } = evaluate(flat);
  return { verdict, reasons, flat };
}

// CLI: node verify.mjs <result.json>
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("verify.mjs")) {
  const path = process.argv[2];
  if (!path) { console.error("usage: node verify.mjs <result.json>"); process.exit(64); }
  const { verdict, reasons } = verifyDocument(JSON.parse(readFileSync(path, "utf8")));
  console.log(`HYPERV_POC=${verdict}`);
  for (const r of reasons) console.log(`  - ${r}`);
  process.exit(verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2);
}
