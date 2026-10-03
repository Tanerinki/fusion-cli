// Fusion v0.6 Hyper-V PoC - FILESYSTEM verdict driver (pure composition over fs-evaluator). Reads the result document
// written by fs-poc.ps1 and prints the three independent verdicts + a reserved exit code (0=PASS 1=FAIL 2=INCOMPLETE
// 3=EXECUTION_ERROR). UNKNOWN/ERROR/NOT_RUN never becomes PASS.
//   usage: node fs-verify.mjs <result-json-path>
import { readFileSync } from "node:fs";
import { filesystemBoundaryVerdict, primaryWorkspaceProtectionVerdict, verificationIsolationVerdict, validateResultEntries } from "./fs-evaluator.mjs";

const p = process.argv[2];
if (!p) { console.error("usage: node fs-verify.mjs <result-json-path>"); process.exit(3); }
let doc;
try { doc = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")); } catch (e) { console.error("EXECUTION_ERROR reading result: " + (e && e.message)); process.exit(3); }

const probe = doc.probe ?? null;
const fsb = probe ? filesystemBoundaryVerdict(probe) : { verdict: "INCOMPLETE", reasons: ["no guest FS probe"] };
const pwp = primaryWorkspaceProtectionVerdict(doc.primaryFingerprintBefore, doc.primaryFingerprintAfter);
const vi = verificationIsolationVerdict(doc.verificationModel);
// PowerShell's ConvertTo-Json unwraps a single-element array to a scalar; coerce back to an array so a one-file result
// manifest is still validated (never silently treated as empty).
const resultEntries = Array.isArray(doc.resultEntries) ? doc.resultEntries : (doc.resultEntries == null || doc.resultEntries === "" ? [] : [doc.resultEntries]);
const rt = validateResultEntries(resultEntries, { maxPathLen: 240 });

console.log("FILESYSTEM_BOUNDARY=" + fsb.verdict);
for (const r of fsb.reasons) console.log("  [fs] " + r);
console.log("PRIMARY_WORKSPACE_PROTECTION=" + pwp.verdict + " (mutated=" + pwp.mutated + ")");
for (const r of pwp.reasons ?? []) console.log("  [primary] " + r);
console.log("VERIFICATION_ISOLATION=" + vi.verdict);
for (const r of vi.reasons) console.log("  [verify] " + r);
console.log("RESULT_TRANSFER_VALIDATION=" + (rt.ok ? "PASS" : "FAIL") + " (accepted=" + rt.accepted.length + " rejected=" + rt.rejected.length + ")");
for (const r of rt.rejected) console.log("  [result] rejected " + r.path + " : " + r.reason);

const all = [fsb.verdict, pwp.verdict, vi.verdict, rt.ok ? "PASS" : "FAIL"];
const verdict = all.includes("FAIL") ? "FAIL" : all.includes("INCOMPLETE") ? "INCOMPLETE" : "PASS";
console.log("FS_DIMENSION=" + verdict);
process.exit(verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2);
