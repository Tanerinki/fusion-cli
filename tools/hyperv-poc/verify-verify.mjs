// Fusion v0.6 Hyper-V PoC - VERIFICATION-ISOLATION verdict driver (pure composition over fs-evaluator). Reads the
// result document written by verify-poc.ps1 and prints VERIFICATION_ISOLATION + PRIMARY_WORKSPACE_PROTECTION +
// RESULT_TRANSFER_VALIDATION + a reserved exit code (0=PASS 1=FAIL 2=INCOMPLETE 3=EXECUTION_ERROR). The number of host
// bind mounts is an authoritative HOST measurement (docker inspect), not a guest self-report, so it is merged into the
// probe here before the verdict runs. UNKNOWN/ERROR/NOT_RUN never becomes PASS.
//   usage: node verify-verify.mjs <result-json-path>
import { readFileSync } from "node:fs";
import { isolatedVerificationVerdict, primaryWorkspaceProtectionVerdict, validateResultEntries } from "./fs-evaluator.mjs";

const p = process.argv[2];
if (!p) { console.error("usage: node verify-verify.mjs <result-json-path>"); process.exit(3); }
let doc;
try { doc = JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")); } catch (e) { console.error("EXECUTION_ERROR reading result: " + (e && e.message)); process.exit(3); }

const probe = doc.probe ?? null;
if (!probe) { console.error("VERIFICATION_ISOLATION=INCOMPLETE (no guest verify probe)"); process.exit(2); }
// authoritative host measurement wins over any guest self-report
probe.bindMounts = typeof doc.bindMountCount === "number" ? doc.bindMountCount : probe.bindMounts;

const vi = isolatedVerificationVerdict(probe);
const pwp = primaryWorkspaceProtectionVerdict(doc.primaryFingerprintBefore, doc.primaryFingerprintAfter);
const resultEntries = Array.isArray(doc.resultEntries) ? doc.resultEntries : (doc.resultEntries == null || doc.resultEntries === "" ? [] : [doc.resultEntries]);
const rt = validateResultEntries(resultEntries, { maxPathLen: 240 });

console.log("VERIFICATION_ISOLATION=" + vi.verdict + " (outcome=" + vi.outcome + " isolationIntact=" + vi.isolationIntact + " sourceMutationDetected=" + vi.sourceMutationDetected + ")");
for (const r of vi.reasons) console.log("  [verify] " + r);
console.log("  [verify] ran: exit=" + probe.ran?.exitCode + " timedOut=" + probe.ran?.timedOut + " dur=" + probe.ran?.durationMs + "ms observed=" + probe.ran?.observed);
console.log("  [verify] network.loopbackOnly=" + probe.network?.loopbackOnly + " bindMounts=" + probe.bindMounts + " dockerPipe=" + probe.dockerPipePresent + " primaryReadable=" + probe.forbidden?.primaryReadable);
console.log("PRIMARY_WORKSPACE_PROTECTION=" + pwp.verdict + " (mutated=" + pwp.mutated + ")");
for (const r of pwp.reasons ?? []) console.log("  [primary] " + r);
console.log("RESULT_TRANSFER_VALIDATION=" + (rt.ok ? "PASS" : "FAIL") + " (accepted=" + rt.accepted.length + " rejected=" + rt.rejected.length + ")");
for (const r of rt.rejected) console.log("  [result] rejected " + r.path + " : " + r.reason);

const all = [vi.verdict, pwp.verdict, rt.ok ? "PASS" : "FAIL"];
const verdict = all.includes("FAIL") ? "FAIL" : all.includes("INCOMPLETE") ? "INCOMPLETE" : "PASS";
console.log("VERIFY_DIMENSION=" + verdict);
process.exit(verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2);
