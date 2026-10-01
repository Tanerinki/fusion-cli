// Fusion v0.6 Hyper-V PoC - pipe PoC verify (computed verdicts; never manual). Reads result-<RunId>.json (BOM-tolerant),
// runs the pure evaluator over its evidence, prints the five dimension verdicts + BROKER_ONLY_NETWORK_BOUNDARY +
// HYPERV_PIPE_POC. Exit: 0=PASS(network boundary proven + process tree pass), 1=any dimension FAIL, 2=INCOMPLETE.
import { readJsonFile } from "./json-io.mjs";
import { evaluatePipePoc } from "./pipe-evaluator.mjs";

const path = process.argv[2];
if (!path) { console.error("usage: node pipe-verify.mjs <result.json>"); process.exit(64); }
let doc;
try { doc = readJsonFile(path); } catch (e) { console.log("PIPE_POC=EXECUTION_ERROR (result unreadable)"); console.error(String(e)); process.exit(3); }

const ev = doc.evidence ?? doc;
const r = evaluatePipePoc(ev);
console.log(`PIPE_TRANSPORT=${r.PIPE_TRANSPORT}`);
console.log(`NETWORK_NONE_BOUNDARY=${r.NETWORK_NONE_BOUNDARY}`);
console.log(`FILESYSTEM_BOUNDARY=${r.FILESYSTEM_BOUNDARY}`);
console.log(`PROCESS_TREE_BOUNDARY=${r.PROCESS_TREE_BOUNDARY}`);
console.log(`CLEANUP_BOUNDARY=${r.CLEANUP_BOUNDARY}`);
console.log(`BROKER_ONLY_NETWORK_BOUNDARY=${r.BROKER_ONLY_NETWORK_BOUNDARY}`);
console.log(`HYPERV_PIPE_POC=${r.HYPERV_PIPE_POC} (full HARD also needs filesystem + process + env)`);
for (const [dim, reasons] of Object.entries(r.reasons)) for (const x of reasons) console.log(`  [${dim}] ${x}`);

const anyFail = [r.PIPE_TRANSPORT, r.NETWORK_NONE_BOUNDARY, r.PROCESS_TREE_BOUNDARY].includes("FAIL");
if (anyFail) process.exit(1);
// The network boundary this PoC proves: pipe transport + network-none both PASS, and the process tree is contained.
if (r.BROKER_ONLY_NETWORK_BOUNDARY === "PROVEN" && r.PROCESS_TREE_BOUNDARY === "PASS") process.exit(0);
process.exit(2);
