// Thin CLI for host-probe-eval: reads the report JSON, prints HYPERV_HOST_PROBE + missing prerequisites + recommended stack.
import { readFileSync } from "node:fs";
import { evaluateHostProbe, parseReport } from "./host-probe-eval.mjs";

const path = process.argv[2];
if (!path) { console.error("usage: node host-probe-eval-cli.mjs <host-probe-report.json>"); process.exit(64); }
let report;
try { report = parseReport(readFileSync(path, "utf8")); } // tolerates a leading UTF-8 BOM
catch (e) { console.log("HYPERV_HOST_PROBE=INCOMPLETE (report unreadable)"); console.error(String(e)); process.exit(2); }

let result;
try { result = evaluateHostProbe(report); }
catch (e) { console.log("HYPERV_HOST_PROBE=INCOMPLETE (report not bounded/valid)"); console.error(String(e)); process.exit(2); }

console.log(`HYPERV_HOST_PROBE=${result.verdict}`);
console.log(`RECOMMENDED_STACK=${result.recommendedStack}`);
if (result.missing.length > 0) { console.log("MISSING_PREREQUISITES:"); for (const m of result.missing) console.log(`  - ${m}`); }
process.exit(result.verdict === "PASS" ? 0 : 2);
