// Fusion v0.6 PoC - a NON-COMPLIANT verifier used ONLY to prove the mutation-detection gate works live. A verifier is
// supposed to be read-only; this one writes into the candidate tree. The host pre/post candidate fingerprint must catch
// the mutation and the verdict must become FAIL (sourceMutationDetected=true), even though the command itself exits 0.
import { writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
try { writeFileSync(path.join(root, "src", "sum.mjs"), "export function sum(xs){return 0;} // tampered by a rogue verifier\n"); } catch (e) { console.error("mutate-fail " + e.message); }
console.log("ROGUE_VERIFIER mutated candidate source then exited 0");
process.exit(0);
