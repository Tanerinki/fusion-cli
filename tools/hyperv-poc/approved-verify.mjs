// Fusion v0.6 PoC - the APPROVED, read-only verifier (Fusion-owned, baked at a FIXED path in the worker image and
// hashed; it is NOT part of the untrusted candidate, so a malicious candidate cannot replace the verifier). It runs
// with cwd = the candidate snapshot, imports the candidate's module and checks a deterministic invariant. It writes
// NOTHING to the candidate tree - a compliant verifier is read-only, and the host pre/post fingerprint proves it.
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = process.cwd();
try {
  const mod = await import(pathToFileURL(path.join(root, "src", "sum.mjs")).href);
  const got = mod.sum([2, 3, 5]);
  if (got !== 10) { console.error("VERIFY_FAIL sum([2,3,5])=" + got + " expected 10"); process.exit(1); }
  console.log("VERIFY_OK sum([2,3,5])==10");
  process.exit(0);
} catch (e) {
  console.error("VERIFY_ERROR " + (e && e.message));
  process.exit(1);
}
