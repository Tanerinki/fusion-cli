// Fusion v0.6 Hyper-V PoC — endpoint discovery CLI (glue over the unit-tested endpoint.mjs). Given the worker's
// `docker inspect` JSON, the PoC network name, the HNS network id, and the `Get-HnsEndpoint` JSON, prints exactly one of:
//   ENDPOINT_ID=<guid>            the single worker endpoint (safe to apply the ACL)
//   ENDPOINT_STATUS=NONE|AMBIGUOUS|MALFORMED  (the orchestrator then applies NOTHING and records INCOMPLETE)
// Exit 0 only on a unique FOUND; non-zero otherwise, so the elevated script fails closed.
import { readFileSync } from "node:fs";
import { findWorkerEndpoint, workerSelectorFromInspect } from "./endpoint.mjs";

const [inspectPath, networkName, hnsNetworkId, endpointsPath] = process.argv.slice(2);
if (!inspectPath || !networkName || !hnsNetworkId || !endpointsPath) {
  console.error("usage: node discover-endpoint.mjs <inspect.json> <networkName> <hnsNetworkId> <endpoints.json>");
  process.exit(64);
}
const parse = p => JSON.parse(readFileSync(p, "utf8"));
let inspectJson, endpointsJson;
try { inspectJson = parse(inspectPath); endpointsJson = parse(endpointsPath); }
catch (e) { console.log("ENDPOINT_STATUS=MALFORMED"); console.error(String(e)); process.exit(2); }

const sel = workerSelectorFromInspect(inspectJson, networkName, hnsNetworkId);
if (!sel.ok) { console.log("ENDPOINT_STATUS=MALFORMED"); console.error(sel.reason); process.exit(2); }
const r = findWorkerEndpoint(endpointsJson, sel);
if (r.status === "FOUND") { console.log(`ENDPOINT_ID=${r.endpointId}`); process.exit(0); }
console.log(`ENDPOINT_STATUS=${r.status}`);
if (r.candidates) console.error(`candidates: ${r.candidates.join(", ")}`);
process.exit(2);
